import type { TabState, TabToggleFeature } from '../contracts/index.ts';
import type {
  Delivery,
  KeyValueStore,
  Sender,
  TabActivityHandlers,
  TabInfo,
} from '../platform/index.ts';
import {
  type AppError,
  type Result,
  appError,
  createSerialQueue,
  err,
  ok,
} from '../shared/index.ts';
import {
  type TabToggleRecords,
  mayBeOn,
  parseTabToggleHint,
  parseTabToggles,
  recordedTabs,
  tabIsOn,
  tabToggleHintKey,
  tabTogglesKey,
  withAllTabs,
  withChoice,
  withNotice,
  withReplacedTab,
  withTurnedOff,
  withoutTabToggles,
} from '../storage/index.ts';
import type { Problem } from './problems.ts';
import { strings } from './strings.ts';
import type {
  TabToggleHost,
  TabTogglePart,
  TabToggleRunner,
  TabToggleServices,
} from './tab-toggle-part.ts';

// 탭마다 켜고 끄기의 공용 부분(TAB-2 기대 동작 1·10, 결정 0043). 탭마다 고른 것과 기능의 알림을 storage.session의 기록에
// 두고(쓰는 곳은 여기 하나), "모든 탭" 스위치(설정)와 합쳐 탭마다의 켜짐을 정한다. 켜짐이 바뀐 탭에는 그 탭의 모든 프레임에
// 알리고(tabState.changed) 기능의 sync를 부른다. 기록의 읽고-고치고-쓰기는 들어온 차례대로 하나씩 한다. 기능의 sync는 그 줄
// 밖(기능의 줄)에서 돈다. 기능이 sync 도중 turnOff를 부르면 이 줄에 서기 때문이다.

export interface TabTogglesDeps {
  readonly features: readonly TabToggleFeature[];
  readonly parts: readonly TabTogglePart[];
  readonly services: TabToggleServices;
  readonly session: KeyValueStore;
  readonly local: KeyValueStore;
  readonly allTabInfos: () => Promise<readonly TabInfo[]>;
  // 그 탭의 모든 프레임에 탭의 상태를 알린다(tabState.changed).
  readonly push: (tabId: number, state: TabState) => Promise<Delivery>;
  // 그 기능의 "모든 탭" 스위치를 쓴다(설정 바꾸기, 결정 0011).
  readonly writeSwitch: (featureId: string, on: boolean) => Promise<Result<unknown, AppError>>;
  // 탭과 창의 사건을 들을지. 켜진 탭이 있을 수 있는 동안만 듣는다.
  readonly listenTabs: (on: boolean) => void;
  readonly record: (problem: Problem) => void;
}

export interface TabToggles {
  // 설정의 "모든 탭" 스위치를 받았다(기능 id → 켜짐). 서비스 워커가 시작한 뒤 처음 받으면 기록을 읽고 남은 것을 다시 맞춘다.
  readonly settings: (switches: ReadonlyMap<string, boolean>) => void;
  // 팝업이 그 탭들에서 그 기능을 켜거나 껐다.
  readonly set: (
    featureId: string,
    tabIds: readonly number[],
    on: boolean,
  ) => Promise<Result<null, AppError>>;
  // 그 탭에서 켜진 기능(콘텐츠 스크립트가 묻는다).
  readonly state: (tabId: number) => Promise<TabState>;
  // 페이지 쪽이 보낸 기능 명령을 그 기능의 서비스 워커 쪽에 넘긴다.
  readonly command: (
    message: { readonly featureId: string; readonly name: string; readonly payload: unknown },
    sender: Sender,
  ) => Promise<Result<unknown, AppError>>;
  readonly events: TabActivityHandlers;
}

// 탭마다 켜고 끄는 기능마다 서비스 워커 쪽 일이 꼭 하나 있어야 한다. 빠지거나 겹치면 결함이므로 시작할 때 드러낸다(quality 066).
function partsByFeature(
  features: readonly TabToggleFeature[],
  parts: readonly TabTogglePart[],
): ReadonlyMap<string, TabTogglePart> {
  for (const part of parts) {
    if (!features.some((feature) => feature.id === part.featureId)) {
      throw new Error(`탭마다 켜고 끄는 일 ${part.featureId}에 맞는 기능이 없다.`);
    }
  }
  return new Map(
    features.map((feature) => {
      const matched = parts.filter((part) => part.featureId === feature.id);
      const [part] = matched;
      if (part === undefined || matched.length > 1) {
        throw new Error(
          `탭마다 켜고 끄는 기능 ${feature.id}의 일이 ${String(matched.length)}개다.`,
        );
      }
      return [feature.id, part];
    }),
  );
}

export function createTabToggles(deps: TabTogglesDeps): TabToggles {
  const parts = partsByFeature(deps.features, deps.parts);
  const enqueue = createSerialQueue();
  // 읽은 기록과 받은 스위치. 둘 다 처음 설정을 받은 줄에서 채운다. 그 전의 요청은 ready를 기다린다.
  let records: TabToggleRecords = {};
  let switches: ReadonlyMap<string, boolean> | null = null;
  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  const switchOf = (featureId: string) => switches?.get(featureId) ?? false;

  const onIn = (tabId: number): string[] =>
    deps.features
      .filter((feature) => tabIsOn(records, feature.id, tabId, switchOf(feature.id)))
      .map((feature) => feature.id);

  // 기록을 쓴다. 쓰지 못하면 거짓이다(기록하는 것은 부르는 쪽이다).
  const write = async (next: TabToggleRecords): Promise<boolean> => {
    try {
      await deps.session.set({ [tabTogglesKey]: next });
      records = next;
      return true;
    } catch {
      return false;
    }
  };

  // 표시(어느 탭에서 켜졌을 수 있는 기능)를 기록에 맞추고 사건 듣기도 맞춘다. 콘텐츠 스크립트는 표시가 빈 동안 묻지 않으므로,
  // 기록을 쓴 뒤 탭에 알리기 전에 맞춘다. 쓰지 못하면 남기고 다음에 다시 쓴다(빈 표시가 늦게 남으면 묻는 쪽이 늘 뿐이다).
  let hint: readonly string[] | null = null;
  const syncHint = async () => {
    const next = deps.features
      .filter((feature) => mayBeOn(records, feature.id, switchOf(feature.id)))
      .map((feature) => feature.id);
    deps.listenTabs(next.length > 0);
    if (hint !== null && hint.join() === next.join()) return;
    try {
      await deps.local.set({ [tabToggleHintKey]: next });
      hint = next;
    } catch {
      deps.record({ featureId: null, kind: 'platform' });
    }
  };

  // 켜짐이 바뀌었을 수 있는 탭에 지금 상태를 알린다. 받는 쪽이 없는 탭(이 확장이 스크립트를 넣을 수 없는 페이지, 새로 고치기
  // 전의 탭)은 그 페이지가 다시 실릴 때 묻는다. 기다리는 쪽이 없어 실패는 기록한다.
  const announce = async (tabIds: readonly number[]) => {
    const deliveries = await Promise.all(
      tabIds.map((tabId) => deps.push(tabId, { on: onIn(tabId) })),
    );
    for (const delivery of deliveries) {
      if (delivery === 'timeout' || delivery === 'failed') {
        deps.record({ featureId: null, kind: delivery === 'timeout' ? 'timeout' : 'platform' });
      }
    }
  };

  const allTabIds = async (): Promise<readonly number[] | null> => {
    try {
      return (await deps.allTabInfos()).map((tab) => tab.id);
    } catch {
      deps.record({ featureId: null, kind: 'platform' });
      return null;
    }
  };

  const runner = (featureId: string): TabToggleRunner | undefined => runners.get(featureId);

  const hostFor = (featureId: string): TabToggleHost => ({
    isOn: (tabId) => tabIsOn(records, featureId, tabId, switchOf(featureId)),
    turnOff: (tabIds, notice) =>
      enqueue(async () => {
        if (
          !(await write(withTurnedOff(records, featureId, switchOf(featureId), tabIds, notice)))
        ) {
          deps.record({ featureId, kind: 'platform' });
          return;
        }
        await syncHint();
        await announce(tabIds);
        runner(featureId)?.sync(tabIds);
      }),
    disable: (notice) =>
      enqueue(async () => {
        const switchOn = switchOf(featureId);
        const tabIds = switchOn ? await allTabIds() : recordedTabs(records, featureId);
        if (tabIds === null) return;
        const wasOn = tabIds.filter((tabId) => tabIsOn(records, featureId, tabId, switchOn));
        // 스위치를 끄는 설정 쓰기는 곧 바뀜 알림으로 돌아온다. 기록이 따르는 값을 먼저 꺼짐으로 두어 그 알림이 남긴 까닭을
        // 지우지 않게 한다(withAllTabs가 같은 값이면 아무것도 하지 않는다).
        const cleared = withAllTabs(records, featureId, false) ?? records;
        if (!(await write(withTurnedOff(cleared, featureId, false, wasOn, notice)))) {
          deps.record({ featureId, kind: 'platform' });
          return;
        }
        if (switchOn) {
          switches = new Map(switches).set(featureId, false);
          const written = await deps.writeSwitch(featureId, false);
          if (!written.ok) deps.record({ featureId, kind: written.error.kind });
        }
        await syncHint();
        await announce(wasOn);
        runner(featureId)?.sync(wasOn);
      }),
    notice: (tabId, notice) =>
      enqueue(async () => {
        const next = withNotice(records, featureId, switchOf(featureId), tabId, notice);
        if (JSON.stringify(next) === JSON.stringify(records)) return;
        if (!(await write(next))) deps.record({ featureId, kind: 'platform' });
      }),
  });

  const runners = new Map(
    [...parts].map(([featureId, part]) => [
      featureId,
      part.start(hostFor(featureId), deps.services),
    ]),
  );

  // 처음 설정을 받은 때: 앞 서비스 워커가 남긴 기록을 읽는다. 읽지 못하면 빈 기록에서 시작한다(탭마다 켠 것이 꺼진 것처럼
  // 보인다. 앞 서비스 워커가 붙인 Chrome 상태는 기능의 recover가 자기 기록으로 맞춘다).
  const load = async () => {
    let raw: unknown;
    try {
      raw = await deps.session.get(tabTogglesKey);
    } catch {
      deps.record({ featureId: null, kind: 'platform' });
      return;
    }
    const parsed = parseTabToggles(raw);
    if (parsed === null) deps.record({ featureId: null, kind: 'unexpected' });
    records = parsed ?? {};
    try {
      hint = parseTabToggleHint(await deps.local.get(tabToggleHintKey));
    } catch {
      hint = null;
    }
  };

  const applySettings = async (next: ReadonlyMap<string, boolean>) => {
    const first = switches === null;
    if (first) await load();
    switches = next;
    // 스위치가 기록이 따르는 값과 다르면 바뀐 것이다(새 세션이면 기록이 없다). 탭마다 고른 것을 지우고 모든 탭에 맞춘다.
    let updated = records;
    const changed = deps.features.filter((feature) => {
      const cleared = withAllTabs(updated, feature.id, switchOf(feature.id));
      if (cleared === null) return false;
      updated = cleared;
      return true;
    });
    if (changed.length > 0 && !(await write(updated))) {
      deps.record({ featureId: null, kind: 'platform' });
    }
    await syncHint();
    if (first) markReady();
    const everyTab =
      changed.length > 0 || deps.features.some((feature) => switchOf(feature.id))
        ? await allTabIds()
        : [];
    if (first) {
      for (const part of runners.values()) await part.recover();
    }
    // 처음이 아닌 스위치의 바뀜은 모든 탭의 켜짐을 바꾼다. 처음(서비스 워커가 시작함)에는 탭이 이미 자기 상태를 안다.
    const switched = first ? [] : changed;
    if (switched.length > 0 && everyTab !== null) await announce(everyTab);
    for (const feature of deps.features) {
      const tabIds = new Set([
        ...(switchOf(feature.id) || changed.includes(feature) ? (everyTab ?? []) : []),
        ...recordedTabs(records, feature.id),
      ]);
      runner(feature.id)?.sync([...tabIds]);
    }
  };

  return {
    settings: (next) => {
      enqueue(() => applySettings(next)).catch(() => {
        deps.record({ featureId: null, kind: 'unexpected' });
      });
    },
    set: async (featureId, tabIds, on) => {
      await ready;
      return enqueue(async () => {
        if (!runners.has(featureId)) return err(appError('invalid-input', strings.notTabToggle));
        if (!(await write(withChoice(records, featureId, switchOf(featureId), tabIds, on)))) {
          return err(appError('platform', strings.tabTogglesWriteFailed));
        }
        await syncHint();
        await announce(tabIds);
        runner(featureId)?.sync(tabIds);
        return ok(null);
      });
    },
    state: async (tabId) => {
      await ready;
      return { on: onIn(tabId) };
    },
    command: async (message, sender) => {
      await ready;
      const target = runner(message.featureId);
      if (target === undefined) return err(appError('invalid-input', strings.notTabToggle));
      if (sender.kind !== 'content') {
        return err(appError('permission', strings.commandFromPage));
      }
      return target.command(message.name, message.payload, sender);
    },
    events: {
      created: (tabId) => {
        for (const feature of deps.features) {
          if (switchOf(feature.id)) runner(feature.id)?.sync([tabId]);
        }
      },
      removed: (tabId) => {
        enqueue(async () => {
          const next = withoutTabToggles(records, tabId);
          if (JSON.stringify(next) !== JSON.stringify(records) && !(await write(next))) {
            deps.record({ featureId: null, kind: 'platform' });
          }
          for (const part of runners.values()) part.removed(tabId);
        }).catch(() => {
          deps.record({ featureId: null, kind: 'unexpected' });
        });
      },
      replaced: (added, removed) => {
        enqueue(async () => {
          const next = withReplacedTab(records, added, removed);
          if (JSON.stringify(next) !== JSON.stringify(records) && !(await write(next))) {
            deps.record({ featureId: null, kind: 'platform' });
          }
          for (const part of runners.values()) part.replaced(added, removed);
        }).catch(() => {
          deps.record({ featureId: null, kind: 'unexpected' });
        });
      },
      activated: (tabId) => {
        for (const part of runners.values()) part.activated(tabId);
      },
      moved: (tabId) => {
        for (const part of runners.values()) part.moved(tabId);
      },
      updated: (tabId) => {
        for (const part of runners.values()) part.updated(tabId);
      },
      window: (windowId) => {
        for (const part of runners.values()) part.window(windowId);
      },
    },
  };
}
