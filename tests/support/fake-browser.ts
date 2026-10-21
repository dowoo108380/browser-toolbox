import type { TabState } from '../../src/contracts/index.ts';
import type {
  DebuggerLoss,
  Delivery,
  TabActivity,
  TabActivityHandlers,
  TabInfo,
  TabResponse,
} from '../../src/platform/index.ts';
import {
  type AppError,
  type Result,
  appError,
  err,
  isWebPage,
  ok,
} from '../../src/shared/index.ts';

// 서비스 워커 시험의 가짜 Chrome: 탭, 창, 디버거, 탭에 보내는 알림과 명령(결정 0041–0043). 실제 Chrome에서 확인한 것을 따른다:
// 이 확장이 이미 붙은 탭에 다시 붙이면 붙은 것으로 받고(debugger_api.cc의 kAlreadyAttachedError를 platform이 붙은 것으로 바꿈),
// 이 확장이 스스로 뗀 연결의 끊김은 오지 않으며, 디버깅 안내 막대의 취소는 이 확장의 모든 연결을 끊고, 디버거를 붙일 수 없는
// 화면으로 이동하면 연결이 끊긴다(2026-10-21 실험). 이 확장의 디버거·탭 경계가 실제 Chrome에서 같게 나누는지는 계약
// 시험(tests/contract/run-tabs.ts, run-debugger.ts, tests/e2e/tab-contract.spec.ts)이 본다. 사건은 시험이 부른 때 곧바로
// 보낸다. 시험에서만 쓴다.

interface FakeTab {
  readonly id: number;
  windowId: number;
  active: boolean;
  // 든 분할 보기(없으면 null).
  split: number | null;
  url: string | undefined;
  title: string | undefined;
  autoDiscardable: boolean;
  loading: boolean;
  // 가는 중인 주소(이동하는 중이 아니면 null).
  pending: string | null;
  // Chrome이 비웠거나 얼렸는지.
  asleep: boolean;
}

interface FakeWindow {
  minimized: boolean;
  focused: boolean;
}

export interface OpenTab {
  readonly id: number;
  readonly windowId?: number;
  readonly active?: boolean;
  readonly url?: string;
  readonly autoDiscardable?: boolean;
}

export type FakeBrowser = ReturnType<typeof createFakeBrowser>;

export function createFakeBrowser() {
  const tabs = new Map<number, FakeTab>();
  const windows = new Map<number, FakeWindow>();
  const attached = new Set<number>();
  const refused = new Set<number>();
  // 답을 늦추는 붙이기(holdAttaches의 동안). 그동안 붙이면 Chrome에는 붙었고 그 답만 아직 오지 않은 것이다.
  let held: (() => void)[] | null = null;
  const commands: { readonly tabId: number; readonly method: string; readonly params: unknown }[] =
    [];
  const pushes: { readonly tabId: number; readonly state: TabState }[] = [];
  let activity: TabActivityHandlers | undefined;
  let listening = true;
  let loss: ((tabId: number, loss: DebuggerLoss) => void) | undefined;
  let answer: (
    tabId: number,
    message: { readonly featureId: string; readonly name: string; readonly payload: unknown },
  ) => TabResponse<unknown> = () => ({ delivery: 'unreachable' });

  // 창에 나와 있는 탭: 활성 탭이거나 활성 탭과 같은 분할 보기에 든 탭(platform의 tabInfo와 같다).
  const infoOf = (tab: FakeTab): TabInfo => ({
    id: tab.id,
    windowId: tab.windowId,
    shown:
      tab.active ||
      (tab.split !== null &&
        [...tabs.values()].some(
          (other) => other.active && other.windowId === tab.windowId && other.split === tab.split,
        )),
    url: tab.url,
    title: tab.title,
    autoDiscardable: tab.autoDiscardable,
    loading: tab.loading,
    asleep: tab.asleep,
  });

  const lose = (tabId: number, why: DebuggerLoss) => {
    if (!attached.delete(tabId)) return;
    loss?.(tabId, why);
  };

  const deps = {
    attachDebugger: (tabId: number): Promise<Result<null, AppError>> => {
      const tab = tabs.get(tabId);
      const restricted = !isWebPage(tab?.pending ?? tab?.url);
      if (tab === undefined || refused.has(tabId) || restricted) {
        return Promise.resolve(err(appError('permission', '이 탭에 디버거를 붙이지 못했다.')));
      }
      attached.add(tabId);
      const answers = held;
      if (answers === null) return Promise.resolve(ok(null));
      return new Promise((resolve) => {
        answers.push(() => {
          resolve(ok(null));
        });
      });
    },
    detachDebugger: (tabId: number): Promise<Result<null, AppError>> => {
      attached.delete(tabId);
      return Promise.resolve(ok(null));
    },
    sendDebuggerCommand: (
      tabId: number,
      method: string,
      params: Readonly<Record<string, unknown>>,
    ): Promise<Result<unknown, AppError>> => {
      if (!attached.has(tabId)) {
        return Promise.resolve(err(appError('platform', '디버거가 붙어 있지 않다.')));
      }
      commands.push({ tabId, method, params });
      return Promise.resolve(ok({}));
    },
    listenDebuggerLoss: (handler: (tabId: number, loss: DebuggerLoss) => void) => {
      loss = handler;
    },
    tabInfo: (tabId: number): Promise<TabInfo | null> => {
      const tab = tabs.get(tabId);
      return Promise.resolve(tab === undefined ? null : infoOf(tab));
    },
    allTabInfos: (): Promise<readonly TabInfo[]> => Promise.resolve([...tabs.values()].map(infoOf)),
    setAutoDiscardable: (tabId: number, autoDiscardable: boolean): Promise<void> => {
      const tab = tabs.get(tabId);
      if (tab !== undefined) tab.autoDiscardable = autoDiscardable;
      return Promise.resolve();
    },
    windowInfo: (
      windowId: number,
    ): Promise<{ readonly minimized: boolean; readonly focused: boolean } | null> => {
      const window = windows.get(windowId);
      return Promise.resolve(window === undefined ? null : { ...window });
    },
    watchTabActivity: (handlers: TabActivityHandlers): TabActivity => {
      activity = handlers;
      return {
        listen: (on) => {
          listening = on;
        },
      };
    },
    pushTabState: (tabId: number, state: TabState): Promise<Delivery> => {
      pushes.push({ tabId, state });
      return Promise.resolve(tabs.has(tabId) ? 'delivered' : 'unreachable');
    },
    sendFeatureCommand: (
      tabId: number,
      message: { readonly featureId: string; readonly name: string; readonly payload: unknown },
    ): Promise<TabResponse<unknown>> => Promise.resolve(answer(tabId, message)),
  };

  const tabOf = (tabId: number) => {
    const tab = tabs.get(tabId);
    if (tab === undefined) throw new Error(`탭 ${String(tabId)}이 없다.`);
    return tab;
  };

  const makeActive = (tab: FakeTab) => {
    for (const other of tabs.values()) if (other.windowId === tab.windowId) other.active = false;
    tab.active = true;
  };

  return {
    deps,
    // 탭을 연다(있으면 Chrome이 새 탭을 만든 것처럼 created를 보낸다). 창이 없으면 최소화되지 않고 초점이 있는 창을 만든다.
    open: ({
      id,
      windowId = 1,
      active = false,
      url = 'https://example.test/',
      autoDiscardable = true,
    }: OpenTab) => {
      if (!windows.has(windowId)) windows.set(windowId, { minimized: false, focused: true });
      const tab: FakeTab = {
        id,
        windowId,
        active: false,
        split: null,
        url,
        title: `탭 ${String(id)}`,
        autoDiscardable,
        loading: false,
        pending: null,
        asleep: false,
      };
      tabs.set(id, tab);
      if (active) makeActive(tab);
      activity?.created(id);
    },
    activate: (tabId: number) => {
      makeActive(tabOf(tabId));
      activity?.activated(tabId);
    },
    // 창을 최소화하거나 되살린다. notify가 거짓이면 창의 사건을 보내지 않는다(화면 없는 Chrome은 최소화를 알리지 않았다,
    // 2026-10-21 실험).
    minimize: (windowId: number, minimized: boolean, notify = true) => {
      const window = windows.get(windowId);
      if (window === undefined) throw new Error(`창 ${String(windowId)}이 없다.`);
      window.minimized = minimized;
      if (minimized) window.focused = false;
      if (notify) activity?.window(windowId);
    },
    // 운영체제의 초점. Chrome은 이 바뀜을 확장에 알리지 않는다(결정 0041). 창의 focused만 바꾼다.
    focus: (windowId: number, focused: boolean) => {
      const window = windows.get(windowId);
      if (window === undefined) throw new Error(`창 ${String(windowId)}이 없다.`);
      window.focused = focused;
    },
    moveToWindow: (tabId: number, windowId: number) => {
      if (!windows.has(windowId)) windows.set(windowId, { minimized: false, focused: true });
      const tab = tabOf(tabId);
      tab.windowId = windowId;
      makeActive(tab);
      activity?.moved(tabId);
    },
    // 탭들을 분할 보기 하나로 묶거나(split가 수), 풀어 따로 둔다(null). Chrome처럼 탭마다 바뀜을 보낸다.
    split: (tabIds: readonly number[], split: number | null) => {
      for (const tabId of tabIds) tabOf(tabId).split = split;
      for (const tabId of tabIds) activity?.updated(tabId);
    },
    // 다른 주소로 가기 시작한다. 갈 곳이 디버거를 붙일 수 없는 화면이면 Chrome이 연결을 끊고, 이동이 끝날 때까지 붙이기를
    // 거절한다. 확장은 그런 화면의 주소를 볼 수 없어 그동안 옛 주소로 보인다(2026-10-21 확장 전체 시험에서 찾음). 웹 페이지로
    // 가면 주소가 바뀐 것을 알린다.
    startNavigation: (tabId: number, url: string) => {
      const tab = tabOf(tabId);
      tab.loading = true;
      tab.pending = url;
      if (!isWebPage(url)) {
        lose(tabId, 'closed');
        return;
      }
      tab.url = url;
      activity?.updated(tabId);
    },
    // 이동을 마친다(문서를 다 실음).
    finishNavigation: (tabId: number) => {
      const tab = tabOf(tabId);
      tab.url = tab.pending ?? tab.url;
      tab.pending = null;
      tab.loading = false;
      activity?.updated(tabId);
    },
    // 다른 주소로 가서 다 싣는다(위 둘을 잇따라).
    navigate: (tabId: number, url: string) => {
      const tab = tabOf(tabId);
      tab.loading = true;
      tab.pending = url;
      if (!isWebPage(url)) lose(tabId, 'closed');
      tab.url = url;
      tab.pending = null;
      tab.loading = false;
      activity?.updated(tabId);
    },
    // Chrome이 그 탭을 메모리 절약으로 비우거나 얼린다(asleep), 또는 다시 싣거나 녹인다. 탭 사건은 보내지 않는다.
    sleep: (tabId: number, asleep: boolean) => {
      tabOf(tabId).asleep = asleep;
    },
    close: (tabId: number) => {
      lose(tabId, 'closed');
      tabs.delete(tabId);
      activity?.removed(tabId);
    },
    replace: (added: number, removed: number) => {
      const old = tabOf(removed);
      lose(removed, 'closed');
      tabs.delete(removed);
      tabs.set(added, { ...old, id: added });
      activity?.replaced(added, removed);
    },
    // 사용자가 디버깅 안내 막대에서 취소를 눌렀다.
    cancelDebugging: () => {
      for (const tabId of [...attached]) lose(tabId, 'cancelled');
    },
    // 확장을 다시 불러왔다: Chrome이 이 확장의 디버거 연결을 모두 지운다(새 서비스 워커에는 끊김을 알리지 않는다).
    extensionReloaded: () => {
      attached.clear();
    },
    // 그 탭에는 디버거를 붙이지 못하게 한다(페이지 안에 다른 확장의 화면이 있는 경우 등).
    refuse: (tabId: number) => {
      refused.add(tabId);
    },
    // 이제부터의 붙이기는 releaseAttaches까지 답하지 않는다(붙이는 사이의 끊김을 시험한다).
    holdAttaches: () => {
      held = [];
    },
    // 늦춘 붙이기에 모두 성공으로 답하고, 이제부터는 바로 답한다.
    releaseAttaches: () => {
      const answers = held ?? [];
      held = null;
      for (const answer of answers) answer();
    },
    // 서비스 워커가 탭의 최상위 프레임에 보낸 기능 명령에 답한다.
    answerCommands: (next: typeof answer) => {
      answer = next;
    },
    tab: (tabId: number) => {
      const tab = tabs.get(tabId);
      return tab === undefined ? undefined : infoOf(tab);
    },
    attached: () => [...attached].sort((a, b) => a - b),
    commands,
    pushes,
    listening: () => listening,
  };
}
