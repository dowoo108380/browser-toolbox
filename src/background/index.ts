import {
  type FeatureDefinition,
  type PageStatus,
  type TabState,
  featureCommand,
  featuresWithSettings,
  pageBundleSchema,
  popupRemember,
  problemReport,
  repairNoticeDismiss,
  settingsUpdate,
  storageEnsureReady,
  tabStateGet,
  tabStatus,
  tabToggleFeatures,
  tabToggleSet,
  taskSeen,
  taskStart,
  v,
} from '../contracts/index.ts';
import type {
  DebuggerLoss,
  Delivery,
  KeyValueStore,
  PageProbe,
  PopupWatch,
  Requester,
  Sender,
  TabActivity,
  TabActivityHandlers,
  TabBadge,
  TabEventHandlers,
  TabEvents,
  TabInfo,
  TabResponse,
} from '../platform/index.ts';
import { type AppError, type ErrorKind, type Result, appError, err, ok } from '../shared/index.ts';
import {
  type SettingsFormat,
  type Snapshot,
  settingsOf,
  startSettingsReader,
} from '../storage/index.ts';
import { createDebuggerManager } from './debugger.ts';
import { createPopupState } from './popup-state.ts';
import { createProblemLog } from './problems.ts';
import { createRepairNoticeLog } from './repair-notice.ts';
import { createRouter, route } from './router.ts';
import { createSettingsStore } from './settings-store.ts';
import { strings } from './strings.ts';
import type { TabTogglePart } from './tab-toggle-part.ts';
import { createTabToggles } from './tab-toggles.ts';
import type { TaskPart } from './task-part.ts';
import { createTaskRunner } from './tasks.ts';

export { type TaskPart, defineTaskPart } from './task-part.ts';
export {
  type TabTogglePart,
  type TabToggleRunner,
  defineTabTogglePart,
} from './tab-toggle-part.ts';

export interface BackgroundDeps {
  readonly features: readonly FeatureDefinition[];
  readonly format: SettingsFormat;
  readonly store: KeyValueStore;
  // 탭마다의 작업 기록을 두는 저장소(chrome.storage.session, 결정 0024).
  readonly session: KeyValueStore;
  // 실행 기능의 서비스 워커 쪽 일. 빌드가 기능 목록에서 만든 등록 목록이다(src/entries/generated/sw.ts).
  readonly taskParts: readonly TaskPart[];
  readonly randomId: () => string;
  readonly tabExists: (tabId: number) => Promise<boolean>;
  // 확장 아이콘의 탭마다의 배지와 제목(결정 0024).
  readonly setTabBadge: (tabId: number, badge: TabBadge | null) => Promise<void>;
  // 탭 닫힘과 이동을 듣는다. 처음 실행될 때 바로 불러야 Chrome이 서비스 워커를 깨워 사건을 넘긴다.
  readonly listenTabEvents: (handlers: TabEventHandlers) => TabEvents;
  // 팝업의 연결을 듣는다. 처음 실행될 때 부른다(결정 0024).
  readonly watchPopups: () => PopupWatch;
  readonly isTabActive: (tabId: number) => Promise<boolean>;
  // 그 탭의 최상위 프레임에 작업 결과 알림을 보낸다(task.notice).
  readonly notifyTab: (tabId: number, text: string) => Promise<Delivery>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  // 서비스 워커가 처음 실행될 때 바로 걸어야 하는 Chrome 이벤트를 건다.
  readonly listenRequests: (
    handle: (message: unknown, sender: Sender) => Promise<unknown>,
  ) => unknown;
  readonly onInstalled: (listener: () => void) => void;
  // 열린 탭의 옛 스크립트에게 물러나라고 알린다(결정 0008). 넣을 수 없는 탭이 아닌데 실패한 것을 탭마다 끝나는 대로
  // report로 알리고, 모든 탭이 끝나거나 제한 시간을 넘기면 끝난다.
  readonly retireOldScripts: (report: (problem: AppError) => void) => Promise<void>;
  // 그 탭의 최상위 문서에 탐침을 넣어 이 확장의 실행 틀이 도는지와 그 묶음을 본다(결정 0023, 0029).
  readonly probePage: (tabId: number) => Promise<PageProbe>;
  // 그 탭의 최상위 프레임의 실행 틀에 지금 상태(외부 화면에 기대한 것이 어긋난 기능)를 묻는다(page.status, 결정 0026, 0034).
  readonly askPage: (tabId: number, timeoutMs: number) => Promise<TabResponse<PageStatus>>;
  // 탭마다 켜고 끄는 기능의 서비스 워커 쪽 일(등록 목록, 결정 0043).
  readonly tabToggleParts: readonly TabTogglePart[];
  // 디버거(결정 0042). 끊김 듣기는 처음 실행될 때 바로 건다.
  readonly attachDebugger: (tabId: number) => Promise<Result<null, AppError>>;
  readonly detachDebugger: (tabId: number) => Promise<Result<null, AppError>>;
  readonly sendDebuggerCommand: (
    tabId: number,
    method: string,
    params: Readonly<Record<string, unknown>>,
  ) => Promise<Result<unknown, AppError>>;
  readonly listenDebuggerLoss: (handler: (tabId: number, loss: DebuggerLoss) => void) => void;
  // 탭과 창(결정 0041, 0043). 사건 듣기는 처음 실행될 때 바로 건다.
  readonly tabInfo: (tabId: number) => Promise<TabInfo | null>;
  readonly allTabInfos: () => Promise<readonly TabInfo[]>;
  readonly setAutoDiscardable: (tabId: number, autoDiscardable: boolean) => Promise<void>;
  readonly windowInfo: (
    windowId: number,
  ) => Promise<{ readonly minimized: boolean; readonly focused: boolean } | null>;
  readonly watchTabActivity: (handlers: TabActivityHandlers) => TabActivity;
  // 그 탭의 모든 프레임에 탭의 상태를 알린다(tabState.changed).
  readonly pushTabState: (tabId: number, state: TabState) => Promise<Delivery>;
  // 그 탭의 최상위 프레임에 기능의 명령을 보낸다(feature.command).
  readonly sendFeatureCommand: (
    tabId: number,
    message: { readonly featureId: string; readonly name: string; readonly payload: unknown },
  ) => Promise<TabResponse<unknown>>;
}

// 실행 틀에 묻는 제한 시간. 팝업의 tab.status 요청(5초) 안에 탐침과 함께 끝나게 짧게 둔다(결정 0026).
const askPageTimeoutMs = 1000;

export function startBackground(deps: BackgroundDeps): void {
  const problems = createProblemLog({ store: deps.store, now: deps.now });
  const record = (problem: Parameters<typeof problems.record>[0]) => {
    // 기록을 못 남겨도 할 수 있는 일이 없다. 기록 실패는 기능에 영향이 없다.
    problems.record(problem).catch(() => undefined);
  };
  const repairNotice = createRepairNoticeLog({ store: deps.store, now: deps.now });
  const settings = createSettingsStore({
    store: deps.store,
    now: deps.now,
    sleep: deps.sleep,
    format: deps.format,
    features: featuresWithSettings(deps.features),
    record,
    noticeRepair: repairNotice.add,
  });
  // 탭 사건은 처음 실행될 때 바로 듣는다. 사건은 나중에 오므로 그때 tasks는 만들어져 있다.
  const tabEvents = deps.listenTabEvents({
    removed: (tabId) => {
      tasks.tabRemoved(tabId).catch(() => {
        record({ featureId: null, kind: 'unexpected' });
      });
    },
    navigated: (tabId) => {
      tasks.tabNavigated(tabId).catch(() => {
        record({ featureId: null, kind: 'unexpected' });
      });
    },
  });
  const popups = deps.watchPopups();
  const tasks = createTaskRunner({
    session: deps.session,
    features: deps.features,
    parts: deps.taskParts,
    randomId: deps.randomId,
    tabExists: deps.tabExists,
    badge: deps.setTabBadge,
    listenTabs: tabEvents.listen,
    popupViewing: popups.viewing,
    isTabActive: deps.isTabActive,
    notify: deps.notifyTab,
    record,
  });
  const popupState = createPopupState({ store: deps.store, record });
  // 디버거 관리(결정 0042). Chrome이 연결을 끊은 것은 처음 실행될 때 바로 듣는다.
  const debuggers = createDebuggerManager({
    attach: deps.attachDebugger,
    detach: deps.detachDebugger,
    send: deps.sendDebuggerCommand,
    record,
  });
  deps.listenDebuggerLoss(debuggers.lost);
  // 탭마다 켜고 끄기(결정 0043). 탭과 창의 사건은 처음 실행될 때 바로 듣고, 켜진 탭이 있을 수 있는 동안만 듣는다. 사건은 나중에
  // 오므로 그때 tabToggles는 만들어져 있다.
  const toggleFeatures = tabToggleFeatures(deps.features);
  const activity = deps.watchTabActivity({
    activated: (tabId) => {
      tabToggles.events.activated(tabId);
    },
    moved: (tabId) => {
      tabToggles.events.moved(tabId);
    },
    updated: (tabId) => {
      tabToggles.events.updated(tabId);
    },
    created: (tabId) => {
      tabToggles.events.created(tabId);
    },
    replaced: (added, removed) => {
      tabToggles.events.replaced(added, removed);
    },
    removed: (tabId) => {
      tabToggles.events.removed(tabId);
    },
    window: (windowId) => {
      tabToggles.events.window(windowId);
    },
  });
  const tabToggles = createTabToggles({
    features: toggleFeatures,
    parts: deps.tabToggleParts,
    services: {
      debuggers,
      local: deps.store,
      tabInfo: deps.tabInfo,
      setAutoDiscardable: deps.setAutoDiscardable,
      windowInfo: deps.windowInfo,
      askTop: async (tabId, command, payload) => {
        const response = await deps.sendFeatureCommand(tabId, {
          featureId: command.featureId,
          name: command.name,
          payload,
        });
        if (response.delivery !== 'delivered') return response;
        const value = v.safeParse(command.value, response.value);
        return value.success
          ? { delivery: 'delivered', value: value.output }
          : { delivery: 'failed' };
      },
      record,
    },
    session: deps.session,
    local: deps.store,
    allTabInfos: deps.allTabInfos,
    push: deps.pushTabState,
    writeSwitch: (featureId, on) => settings.updateFeature(featureId, { enabled: on }),
    listenTabs: activity.listen,
    record,
  });
  // 실행 틀에서 외부 화면에 기대한 것이 어긋난 기능(결정 0026, 0034). 묻지 못하면 비워 답한다. 받는 쪽이 없는 것(탐침 뒤에
  // 물러남)은 기록하지 않는다.
  const unmetOn = async (tabId: number): Promise<PageStatus['unmet']> => {
    const response = await deps.askPage(tabId, askPageTimeoutMs);
    switch (response.delivery) {
      case 'delivered':
        return response.value.unmet;
      case 'unreachable':
        return [];
      case 'timeout':
      case 'failed':
        record({ featureId: null, kind: response.delivery === 'timeout' ? 'timeout' : 'platform' });
        return [];
    }
  };
  const router = createRouter(
    [
      route(settingsUpdate, (payload) => settings.updateFeature(payload.featureId, payload.patch)),
      route(storageEnsureReady, () => settings.ensureReady()),
      route(repairNoticeDismiss, (payload) => repairNotice.dismiss(payload.stamp)),
      route(problemReport, async (payload) => {
        await problems.record(payload);
        return ok(null);
      }),
      route(popupRemember, (payload) => popupState.remember(payload.category)),
      route(tabStatus, async (payload) => {
        const probe = await deps.probePage(payload.tabId);
        switch (probe.status) {
          case 'ran': {
            if (probe.marker === null) return ok({ page: 'reload' });
            // 표식은 같은 판의 실행 틀만 둔다(옛 판은 다른 세계다). 묶음 이름이 아니면 일어나면 안 되는 상태다.
            const bundle = v.safeParse(pageBundleSchema, probe.marker);
            if (!bundle.success) {
              record({ featureId: null, kind: 'unexpected' });
              return ok({ page: 'reload' });
            }
            return ok({
              page: 'ready',
              bundle: bundle.output,
              unmet: await unmetOn(payload.tabId),
            });
          }
          case 'unavailable':
            return ok({ page: 'denied' });
          case 'failed':
            // 알려지지 않은 거절도 그 페이지에는 넣을 수 없는 것이다. 쓸 수 없다고 답하되 숨기지 않고 기록한다(quality 067).
            record({ featureId: null, kind: 'platform' });
            return ok({ page: 'denied' });
        }
      }),
      route(taskStart, (payload) => tasks.start(payload.featureId, payload.tabId)),
      route(taskSeen, (payload) => tasks.seen(payload.tabId, payload.taskId)),
      route(tabToggleSet, (payload) =>
        tabToggles.set(payload.featureId, payload.tabIds, payload.on),
      ),
      route(tabStateGet, async (_payload, sender) =>
        sender.kind === 'content'
          ? ok(await tabToggles.state(sender.tabId))
          : err(appError('invalid-input', strings.tabStateFromPage)),
      ),
      route(featureCommand, (payload, sender) => tabToggles.command(payload, sender)),
    ],
    () => {
      record({ featureId: null, kind: 'unexpected' });
    },
  );
  deps.listenRequests(router);
  deps.onInstalled(() => {
    // 탭이 많아도 문제 기록(최근 100개)을 채우지 않게 종류마다 처음 한 번만 남긴다(quality 067). 알리는 대로 바로 남겨,
    // 늦은 탭을 기다리는 사이 서비스 워커가 멈춰도 앞의 기록은 남는다.
    const recorded = new Set<ErrorKind>();
    deps
      .retireOldScripts((problem) => {
        if (recorded.has(problem.kind)) return;
        recorded.add(problem.kind);
        record({ featureId: null, kind: problem.kind });
      })
      .catch(() => {
        record({ featureId: null, kind: 'platform' });
      });
  });
  // 앞 서비스 워커가 남긴 작업 기록을 고치고, 기록이 없으면 탭 사건 듣기를 그만둔다(결정 0024).
  tasks.recover().catch(() => {
    record({ featureId: null, kind: 'unexpected' });
  });
  // 탭마다 켜고 끄는 기능의 "모든 탭" 스위치를 읽기 도우미로 받는다(결정 0011의 읽는 쪽 계약). 준비 부탁은 메시지 없이 이
  // 서비스 워커의 설정 저장에 바로 한다. 더 새 형식의 설정이면 스위치를 모두 꺼진 것으로 본다(이 판은 그 설정을 읽지 않는다).
  if (toggleFeatures.length > 0) {
    const switches = (snapshot: Snapshot | null) =>
      new Map(
        toggleFeatures.map((feature) => [
          feature.id,
          snapshot !== null && settingsOf(snapshot, feature).enabled,
        ]),
      );
    const ensureLocally: Requester = async (definition) => {
      const ready = await settings.ensureReady();
      if (!ready.ok) return err({ ...ready.error, answered: true });
      const value = v.safeParse(definition.value, null);
      return value.success
        ? ok(value.output)
        : err({ ...appError('unexpected', strings.debuggerUnexpected), answered: true });
    };
    startSettingsReader(
      { store: deps.store, request: ensureLocally, format: deps.format, specs: toggleFeatures },
      {
        apply: (snapshot) => {
          tabToggles.settings(switches(snapshot));
        },
        corrupt: () => undefined,
        newer: () => {
          tabToggles.settings(switches(null));
        },
        problem: (error) => {
          record({ featureId: null, kind: error.kind });
        },
      },
    );
  }
  // 서비스 워커가 시작할 때 설정을 준비한다(처음 설치, 손상, 옛 형식). 실패 결과도 버리지 않고 기록한다(quality 067).
  // 읽는 쪽은 준비되지 않은 설정을 보면 storage.ensureReady로 다시 부탁한다(결정 0011).
  settings
    .ensureReady()
    .then((result) => {
      if (!result.ok) record({ featureId: null, kind: result.error.kind });
    })
    .catch(() => {
      record({ featureId: null, kind: 'unexpected' });
    });
}
