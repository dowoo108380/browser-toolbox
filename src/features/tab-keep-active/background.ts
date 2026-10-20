import { type TabToggleRunner, defineTabTogglePart } from '../../background/index.ts';
import { v } from '../../contracts/index.ts';
import type { TabInfo } from '../../platform/index.ts';
import {
  type AppError,
  type Result,
  appError,
  createSerialQueue,
  err,
  isWebPage,
  ok,
} from '../../shared/index.ts';
import { wantsDebugger } from './core/attach.ts';
import {
  type Ledger,
  heldTabs,
  originalOf,
  withHeld,
  withReplaced,
  withoutHeld,
} from './core/ledger.ts';
import { type SafePair, hiddenCommand, pointCommand, tabKeepActive } from './feature.ts';
import { strings } from './strings.ts';

// 페이지 활성 상태 유지의 서비스 워커 쪽(TAB-2, 결정 0041). 켜진 탭마다:
// - Chrome이 메모리 절약으로 비우지 못하게 하고 원래 값을 장부(storage.local)에 적는다. 끄면 되돌리고 지운다.
// - 보지 않는 탭(창에 나와 있지 않음, 창이 최소화됨, 창이 가려짐)이면 디버거를 붙여 초점을 흉내 내고 페이지를 활성 상태로
//   둔다. 보는 탭이면 떼고, 초점과 숨김은 페이지 쪽 방패(main.ts)가 페이지에 숨긴다.
// - 디버거가 붙은 동안 1분마다 안전한 곳에 마우스 움직임을 보낸다(가짜 입력).
// 탭마다의 일은 이 기능의 줄에서 하나씩 한다. 장부는 Chrome 상태보다 먼저 생기고 나중에 없어진다(결정 0038).

// 가짜 입력의 간격. 보지 않는 탭이 된 때부터 이만큼 지나 처음 보낸다. 그 탭은 보지 않는 동안 사용자의 입력을 받지 못하므로
// 그때는 1분 넘게 입력이 없었다(TAB-2 기대 동작 7).
const inputIntervalMs = 60_000;

// 가려져 디버거를 붙인 탭의 창이 다시 초점을 얻었는지 묻는 간격. Chrome은 다른 프로그램에서 돌아오는 초점의 사건을 늘
// 보내지 않는다(2026-10-21 실험, 결정 0041). 그런 탭이 있는 동안만 묻고, 그동안은 디버거가 서비스 워커를 깨워 둔다.
const focusPollMs = 1000;

const ledgerKey = 'keepActiveLedger';

const ledgerSchema: v.Schema<Ledger> = v.record(v.string(), v.object({ discardable: v.boolean() }));

interface Input {
  readonly timer: ReturnType<typeof setTimeout>;
  // 지난번에 쓴 두 점과 다음에 쓸 쪽.
  readonly pair: SafePair | null;
  readonly second: boolean;
}

export const background = defineTabTogglePart(tabKeepActive, (host, services) => {
  const user = tabKeepActive.id;
  const enqueue = createSerialQueue();
  // 장부에 적힌 탭(장부의 메모리 사본). 꺼진 탭의 탭 사건을 거르는 데 쓴다.
  let held = new Set<number>();
  // 페이지가 숨김을 알린 보는 탭(창이 가려짐). 그 창이 다시 초점을 얻거나 보는 탭이 아니게 되면 지운다.
  const covered = new Set<number>();
  // 디버거를 붙여 초점을 흉내 내는 탭.
  const emulating = new Set<number>();
  const inputs = new Map<number, Input>();
  // 가짜 입력을 보낼 곳이 없다고 알린 탭.
  const noticed = new Set<number>();
  let focusTimer: ReturnType<typeof setInterval> | null = null;

  // 이 기능의 일이 던진 예외는 기다리는 쪽이 없다. 기록한다(quality 067).
  const run = (work: () => Promise<void>) => {
    enqueue(work).catch(() => {
      services.record({ featureId: user, kind: 'platform' });
    });
  };

  const loadLedger = async (): Promise<Ledger> => {
    const parsed = v.safeParse(ledgerSchema, (await services.local.get(ledgerKey)) ?? {});
    if (parsed.success) return parsed.output;
    // 쓰는 곳은 여기 하나다. 틀린 장부는 결함이다. 기록하고 빈 장부에서 다시 시작한다.
    services.record({ featureId: user, kind: 'unexpected' });
    return {};
  };

  const saveLedger = async (ledger: Ledger) => {
    await services.local.set({ [ledgerKey]: ledger });
    held = new Set(heldTabs(ledger));
  };

  const setNotice = async (tabId: number, on: boolean) => {
    if (on === noticed.has(tabId)) return;
    if (on) noticed.add(tabId);
    else noticed.delete(tabId);
    await host.notice(tabId, on ? 'no-safe-point' : null);
  };

  const updateFocusPoll = () => {
    if (covered.size > 0 && focusTimer === null) {
      focusTimer = setInterval(() => {
        run(pollFocus);
      }, focusPollMs);
    } else if (covered.size === 0 && focusTimer !== null) {
      clearInterval(focusTimer);
      focusTimer = null;
    }
  };

  const stopInput = (tabId: number) => {
    const input = inputs.get(tabId);
    if (input === undefined) return;
    clearTimeout(input.timer);
    inputs.delete(tabId);
  };

  const schedule = (tabId: number) =>
    setTimeout(() => {
      run(() => tick(tabId));
    }, inputIntervalMs);

  const startInput = (tabId: number) => {
    if (!inputs.has(tabId))
      inputs.set(tabId, { timer: schedule(tabId), pair: null, second: false });
  };

  // 가짜 입력 하나(TAB-2 기대 동작 7). 최상위 프레임의 페이지 쪽에 안전한 두 점을 묻고, 번갈아 한쪽으로 마우스를 옮긴다.
  // 받는 쪽이 없으면(새로 고치기 전의 탭 등) 보내지 않는다.
  async function tick(tabId: number) {
    const input = inputs.get(tabId);
    if (input === undefined) return;
    const answer = await services.askTop(tabId, pointCommand, { keep: input.pair });
    if (inputs.get(tabId) !== input) return;
    const next = { timer: schedule(tabId), pair: input.pair, second: input.second };
    inputs.set(tabId, next);
    if (answer.delivery !== 'delivered') return;
    const { pair } = answer.value;
    if (pair === null) {
      await setNotice(tabId, true);
      return;
    }
    const point = input.second ? pair.second : pair.first;
    const sent = await services.debuggers.send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
    });
    // 떨어진 연결(unavailable)은 끊김을 듣는 쪽이 맞춘다.
    if (!sent.ok && sent.error.kind !== 'unavailable') {
      services.record({ featureId: user, kind: sent.error.kind });
    }
    if (inputs.get(tabId) === next) inputs.set(tabId, { ...next, pair, second: !input.second });
    await setNotice(tabId, false);
  }

  // 디버거를 붙여 초점을 흉내 내고 페이지를 활성 상태로 둔다(R-09, 옛 확장과 같은 두 명령). 붙이지 못하면 그 탭을 끄고 까닭을
  // 남긴다(TAB-2 기대 동작 9).
  const keep = async (tabId: number) => {
    if (emulating.has(tabId)) {
      startInput(tabId);
      return;
    }
    const acquired = await services.debuggers.acquire(tabId, user);
    if (!acquired.ok) {
      // 이동하는 중이면 갈 곳 때문에 거절했을 수 있다(Chrome 내부 화면 등. 확장은 그 주소를 볼 수 없어 아직 옛 주소로 보인다,
      // 2026-10-21 시험에서 찾음). 끄지 않고 쉰다. 다 실으면 다시 맞춘다(웹 페이지가 아니면 쉬고, 다시 거절하면 끈다).
      if ((await services.tabInfo(tabId))?.loading !== true) {
        await host.turnOff([tabId], 'attach-failed');
      }
      return;
    }
    const focused = await services.debuggers.send(tabId, 'Emulation.setFocusEmulationEnabled', {
      enabled: true,
    });
    const active = focused.ok
      ? await services.debuggers.send(tabId, 'Page.setWebLifecycleState', { state: 'active' })
      : focused;
    if (!active.ok) {
      services.debuggers.release(tabId, user);
      // 그 사이 연결이 끊긴 것(unavailable)은 끊김을 듣는 쪽이 맞춘다.
      if (active.error.kind === 'unavailable') return;
      services.record({ featureId: user, kind: active.error.kind });
      await host.turnOff([tabId], 'attach-failed');
      return;
    }
    emulating.add(tabId);
    startInput(tabId);
  };

  // 디버거를 뗀다. 같은 연결을 다른 쪽(캡처, PAGE-1)이 쓰면 연결이 남으므로 초점 흉내를 먼저 끈다(결정 0042). 끄지 못해도
  // 뗀다. 서비스 워커가 다시 시작해 맞출 때는 앞 서비스 워커가 붙인 연결이 남았을 수 있어 떼어 둔다.
  const leave = async (tabId: number, recovering: boolean) => {
    stopInput(tabId);
    await setNotice(tabId, false);
    if (!emulating.has(tabId)) {
      if (recovering) services.debuggers.discard(tabId);
      return;
    }
    emulating.delete(tabId);
    await services.debuggers.send(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false });
    services.debuggers.release(tabId, user);
  };

  // 켜진 탭: 비우기를 막는다. 장부에 원래 값을 먼저 적는다.
  const hold = async (tab: TabInfo) => {
    const ledger = await loadLedger();
    if (originalOf(ledger, tab.id) === null)
      await saveLedger(withHeld(ledger, tab.id, tab.autoDiscardable));
    if (tab.autoDiscardable) await services.setAutoDiscardable(tab.id, false);
  };

  // 꺼진 탭: 디버거를 떼고 비우기를 원래 값으로 되돌린 뒤 장부에서 지운다.
  const turnDown = async (tab: TabInfo, recovering: boolean) => {
    await leave(tab.id, recovering);
    covered.delete(tab.id);
    const ledger = await loadLedger();
    const original = originalOf(ledger, tab.id);
    if (original === null) return;
    if (tab.autoDiscardable !== original) await services.setAutoDiscardable(tab.id, original);
    await saveLedger(withoutHeld(ledger, tab.id));
  };

  // 닫힌 탭: Chrome이 연결과 탭 상태를 지운다. 이 기능이 든 것만 버린다(TAB-2.8).
  const forget = async (tabId: number) => {
    stopInput(tabId);
    noticed.delete(tabId);
    covered.delete(tabId);
    if (emulating.delete(tabId)) services.debuggers.release(tabId, user);
    const ledger = await loadLedger();
    if (originalOf(ledger, tabId) !== null) await saveLedger(withoutHeld(ledger, tabId));
  };

  // 그 탭의 Chrome 상태를 지금 켜짐과 보이는 사정에 맞춘다.
  async function syncTab(tabId: number, recovering: boolean) {
    const tab = await services.tabInfo(tabId);
    if (tab === null) {
      await forget(tabId);
    } else if (!host.isOn(tabId)) {
      await turnDown(tab, recovering);
    } else {
      await hold(tab);
      const window = await services.windowInfo(tab.windowId);
      const minimized = window?.minimized ?? false;
      // 가려짐은 보는 탭일 때만 뜻이 있다.
      if (!tab.shown || minimized) covered.delete(tabId);
      const view = {
        web: isWebPage(tab.url),
        shown: tab.shown,
        minimized,
        covered: covered.has(tabId),
      };
      if (wantsDebugger(view)) await keep(tabId);
      else await leave(tabId, recovering);
    }
    updateFocusPoll();
  }

  // 가려져 붙인 탭의 창이 다시 초점을 얻었거나 그 탭이 보는 탭이 아니게 되었으면 가려짐을 지우고 다시 맞춘다.
  async function pollFocus() {
    for (const tabId of [...covered]) {
      const tab = await services.tabInfo(tabId);
      const window = tab === null ? null : await services.windowInfo(tab.windowId);
      if (tab === null || window === null || window.focused || !tab.shown || window.minimized) {
        covered.delete(tabId);
        await syncTab(tabId, false);
      }
    }
    updateFocusPoll();
  }

  // 켜진 탭(장부에 적힌 탭)과 그 탭을 모두 다시 맞춘다. 창의 활성 탭이 바뀌면 앞의 활성 탭도 바뀐다.
  const syncHeld = (tabId: number | null) => {
    run(async () => {
      const tabIds = new Set(heldTabs(await loadLedger()));
      if (tabId !== null && host.isOn(tabId)) tabIds.add(tabId);
      for (const id of tabIds) await syncTab(id, false);
    });
  };

  // 연결이 밖에서 끊겼다. 사용자가 디버깅 안내 막대에서 취소했으면(Chrome이 이 확장의 연결을 모두 끊는다) 켜진 탭을 모두 끄고
  // 스위치도 꺼서 사용자가 다시 켤 때까지 붙이지 않는다(TAB-2 기대 동작 9). 대상이 사라졌으면(붙일 수 없는 화면으로 이동함) 그
  // 탭이 아직 있을 때만 다시 맞춘다. 그 화면에서는 쉬고, 웹 페이지로 돌아오면 이동 사건에 다시 붙인다. 탭이 닫히거나 다른 탭으로
  // 바뀐 것은 그 사건(removed, replaced)이 맡는다. 바뀜보다 끊김이 먼저 오므로 여기서 장부를 지우면 원래 값을 잃는다.
  services.debuggers.onLost(user, (tabId, loss) => {
    emulating.delete(tabId);
    stopInput(tabId);
    if (loss === 'cancelled') {
      host.disable('cancelled').catch(() => {
        services.record({ featureId: user, kind: 'unexpected' });
      });
      return;
    }
    run(async () => {
      if ((await services.tabInfo(tabId)) !== null) await syncTab(tabId, false);
    });
  });

  const runner: TabToggleRunner = {
    sync: (tabIds) => {
      for (const tabId of tabIds) run(() => syncTab(tabId, false));
    },
    recover: () => {
      run(async () => {
        const ledger = await loadLedger();
        held = new Set(heldTabs(ledger));
        for (const tabId of heldTabs(ledger)) await syncTab(tabId, true);
      });
    },
    command: async (name, payload, sender): Promise<Result<unknown, AppError>> => {
      if (name !== hiddenCommand.name)
        return err(appError('invalid-input', strings.unknownCommand));
      if (sender.frameId !== 0) return err(appError('permission', strings.topFrameOnly));
      const parsed = v.safeParse(hiddenCommand.payload, payload);
      if (!parsed.success) return err(appError('invalid-input', strings.unknownCommand));
      const { tabId } = sender;
      if (!parsed.output.hidden || !host.isOn(tabId)) return ok(null);
      // 페이지가 숨김이 되었으면 그 탭을 다시 맞춘다. 창의 사건이 늦거나 오지 않아도(화면 없는 Chrome은 최소화를 알리지 않는다)
      // 맞추기 위해서다. 보는 탭인데 숨김이고 창이 최소화되지 않았고 초점이 없으면 창이 가려진 것이다(다른 창이 완전히 덮음,
      // 결정 0041). 창에 초점이 있으면 가려진 것이 아니다.
      await enqueue(async () => {
        const tab = await services.tabInfo(tabId);
        const window = tab === null ? null : await services.windowInfo(tab.windowId);
        if (tab === null || window === null) return;
        if (tab.shown && !window.minimized && !window.focused) covered.add(tabId);
        await syncTab(tabId, false);
      });
      return ok(null);
    },
    activated: (tabId) => {
      syncHeld(tabId);
    },
    moved: (tabId) => {
      syncHeld(tabId);
    },
    window: () => {
      syncHeld(null);
    },
    updated: (tabId) => {
      if (host.isOn(tabId) || held.has(tabId)) run(() => syncTab(tabId, false));
    },
    removed: (tabId) => {
      run(() => forget(tabId));
    },
    replaced: (added, removed) => {
      run(async () => {
        const ledger = await loadLedger();
        await saveLedger(withReplaced(ledger, added, removed));
        await forget(removed);
        await syncTab(added, false);
      });
    },
  };
  return runner;
});
