import { type AppError, type Result, appError, err, ok } from '../shared/index.ts';

// 팝업이 붙은 창의 지금 탭(결정 0023). 팝업은 탭이 아니므로 그 창에서 사용자가 보던 탭이다. 없으면 null이다.
// Chrome이 거절하면 던지지 않고 platform 실패로 준다. 팝업은 이 답을 기다려 탭의 상태를 묻고 실행 단추를 열므로,
// 던지면 알림 없이 막힌다(quality 067).
export async function currentTabId(): Promise<Result<number | null, AppError>> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return ok(tab?.id ?? null);
  } catch {
    return err(
      appError('platform', '지금 탭을 Chrome에서 받지 못했다. 팝업을 닫았다가 다시 연다.'),
    );
  }
}

// 닫힌 탭이면 Chrome이 "No tab with id: …"로 거절한다(결정 0024의 실험 3). 실제 문구는 e2e/tab-contract가 본다.
// 이 밖의 거절을 닫힌 탭으로 여기지 않는다. 열린 탭의 기록을 지우거나 열린 탭을 없다고 답하는 쪽으로 숨기 때문이다.
export function isClosedTab(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('No tab with id');
}

// 그 탭이 열려 있는지. 닫힌 탭이면 거짓이고, 그 밖의 거절은 던진다. 탭 정보는 tabs 권한 없이도 받는다(주소와 제목만
// 빠진다).
export async function tabExists(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch (error) {
    if (isClosedTab(error)) return false;
    throw error;
  }
}

export interface TabEventHandlers {
  readonly removed: (tabId: number) => void;
  // 탭이 다른 문서로 이동하는 중이거나 이동을 마쳤다(tabs.onUpdated의 status가 loading 또는 complete).
  readonly navigated: (tabId: number) => void;
}

export interface TabEvents {
  // 참이면 두 사건을 듣고, 거짓이면 그만둔다. 듣지 않는 동안 Chrome은 이 사건으로 서비스 워커를 깨우지 않는다.
  readonly listen: (on: boolean) => void;
}

// 탭 닫힘과 이동을 듣는다. 서비스 워커가 처음 실행될 때 불러야 Chrome이 서비스 워커를 깨워 사건을 넘긴다. 처음에는 듣는다.
// tabs.onUpdated는 걸러 받을 수 없어 모든 탭의 모든 바뀜에 서비스 워커를 깨우므로, 쓸모가 있을 때만 듣는다(결정 0024의
// 실험 6: 그만두면 멈춘 서비스 워커를 깨우지 않고, 다시 걸면 깨운다).
export function listenTabEvents(handlers: TabEventHandlers): TabEvents {
  const removed = (tabId: number) => {
    handlers.removed(tabId);
  };
  const updated = (tabId: number, changeInfo: { readonly status?: string }) => {
    if (changeInfo.status !== undefined) handlers.navigated(tabId);
  };
  const listen = (on: boolean) => {
    if (on) {
      if (!chrome.tabs.onRemoved.hasListener(removed)) chrome.tabs.onRemoved.addListener(removed);
      if (!chrome.tabs.onUpdated.hasListener(updated)) chrome.tabs.onUpdated.addListener(updated);
    } else {
      chrome.tabs.onRemoved.removeListener(removed);
      chrome.tabs.onUpdated.removeListener(updated);
    }
  };
  listen(true);
  return { listen };
}

// 그 탭이 창의 지금 탭인지. 닫힌 탭이면 거짓이고, 그 밖의 거절은 던진다.
export async function isTabActive(tabId: number): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.active;
  } catch (error) {
    if (isClosedTab(error)) return false;
    throw error;
  }
}

// 탭마다 켜고 끄는 기능이 보는 탭의 사정(결정 0041, 0043). url과 title은 이 확장이 볼 수 있는 탭(http·https 페이지,
// 호스트 권한)에만 있다. 탭이 이동하는 중이면 갈 곳(pendingUrl)을 url로 준다.
export interface TabInfo {
  readonly id: number;
  readonly windowId: number;
  // 그 창에 나와 있는 탭인지: 창의 활성 탭이거나, 활성 탭과 분할 보기(Chrome 140부터)로 나란히 놓인 탭. 분할 보기의 활성이
  // 아닌 쪽도 화면에 보이고 페이지도 보임 상태다(초점만 없다, 2026-10-21 실험). 창이 최소화되었거나 가려졌는지는 보지 않는다.
  readonly shown: boolean;
  readonly url: string | undefined;
  readonly title: string | undefined;
  readonly autoDiscardable: boolean;
  // 문서를 싣는 중인지(다른 주소로 이동하는 중 포함). 다 실으면 tabs.onUpdated가 알린다.
  readonly loading: boolean;
}

// 분할 보기에 들지 않은 탭의 splitViewId(chrome.tabs.SPLIT_VIEW_ID_NONE).
const noSplitView = -1;

// windowTabs는 그 탭과 같은 창의 탭들이다(다른 창의 탭이 섞여 있어도 된다).
function infoOf(tab: chrome.tabs.Tab, windowTabs: readonly chrome.tabs.Tab[]): TabInfo | null {
  if (tab.id === undefined) return null;
  const split = tab.splitViewId ?? noSplitView;
  const shown =
    tab.active ||
    (split !== noSplitView &&
      windowTabs.some(
        (other) => other.active && other.windowId === tab.windowId && other.splitViewId === split,
      ));
  return {
    id: tab.id,
    windowId: tab.windowId,
    shown,
    url: tab.pendingUrl ?? tab.url,
    title: tab.title,
    autoDiscardable: tab.autoDiscardable,
    loading: tab.status === 'loading',
  };
}

const infosOf = (tabs: readonly chrome.tabs.Tab[]) =>
  tabs.map((tab) => infoOf(tab, tabs)).filter((info) => info !== null);

// 그 탭의 사정. 닫힌 탭이면 null이고, 그 밖의 거절은 던진다(서비스 워커의 경계가 받는다).
export async function tabInfo(tabId: number): Promise<TabInfo | null> {
  try {
    const tab = await chrome.tabs.get(tabId);
    // 분할 보기의 활성이 아닌 쪽이면 그 창의 활성 탭이 같은 분할 보기에 있는지 본다.
    const split = !tab.active && (tab.splitViewId ?? noSplitView) !== noSplitView;
    return infoOf(
      tab,
      split ? await chrome.tabs.query({ windowId: tab.windowId, active: true }) : [],
    );
  } catch (error) {
    if (isClosedTab(error)) return null;
    throw error;
  }
}

// 열린 모든 탭의 사정. 거절은 던진다.
export async function allTabInfos(): Promise<readonly TabInfo[]> {
  return infosOf(await chrome.tabs.query({}));
}

// 팝업이 붙은 창의 탭들(TAB-2의 탭 목록). Chrome이 거절하면 던지지 않고 platform 실패로 준다(위 currentTabId와 같은 까닭).
export async function currentWindowTabs(): Promise<Result<readonly TabInfo[], AppError>> {
  try {
    return ok(infosOf(await chrome.tabs.query({ currentWindow: true })));
  } catch {
    return err(
      appError('platform', '이 창의 탭 목록을 Chrome에서 받지 못했다. 팝업을 닫았다가 다시 연다.'),
    );
  }
}

// 그 탭을 Chrome이 메모리 절약으로 비울 수 있는지 정한다(TAB-2 기대 동작 5). 닫힌 탭이면 할 일이 없다. 그 밖의 거절은 던진다.
export async function setAutoDiscardable(tabId: number, autoDiscardable: boolean): Promise<void> {
  try {
    await chrome.tabs.update(tabId, { autoDiscardable });
  } catch (error) {
    if (!isClosedTab(error)) throw error;
  }
}

// 창의 사정. minimized는 최소화되었는지, focused는 운영체제의 초점이 그 창에 있는지다. focused는 Chrome이 사건(windows.onFocusChanged)을
// 늘 보내지 않아도 맞다(2026-10-21 실험, 결정 0041). 닫힌 창이면 null이고, 그 밖의 거절은 던진다.
export async function windowInfo(
  windowId: number,
): Promise<{ readonly minimized: boolean; readonly focused: boolean } | null> {
  try {
    const window = await chrome.windows.get(windowId);
    return { minimized: window.state === 'minimized', focused: window.focused };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('No window with id')) return null;
    throw error;
  }
}

export interface TabActivityHandlers {
  // 창의 활성 탭이 바뀌었다.
  readonly activated: (tabId: number) => void;
  // 탭이 다른 창으로 옮겨졌다(창에서 떨어짐, 붙음).
  readonly moved: (tabId: number) => void;
  // 탭의 주소가 바뀌었거나, 문서를 다 실었거나, 비워지거나 되살아났거나, 분할 보기에 들거나 나왔다.
  readonly updated: (tabId: number) => void;
  readonly created: (tabId: number) => void;
  // Chrome이 탭을 다른 탭으로 바꿨다(미리 렌더링한 문서 등).
  readonly replaced: (added: number, removed: number) => void;
  readonly removed: (tabId: number) => void;
  // 창의 크기나 초점이 바뀌었다(windows.onBoundsChanged, windows.onFocusChanged). 최소화와 되살림을 아는 길이다. 화면이 있는
  // Chrome은 둘 다 보내지만, 화면 없는 Chrome은 최소화에 아무것도 보내지 않고 되살림에 초점의 바뀜만 보냈다(2026-10-21 실험).
  // 다른 프로그램으로 초점이 갔다 돌아올 때는 초점의 바뀜이 오지 않았으므로(같은 실험, 결정 0041) 초점은 windowInfo로 묻는다.
  // windowId는 바뀐 창이고, 초점이 Chrome 밖으로 나갔으면 chrome.windows.WINDOW_ID_NONE(-1)이다.
  readonly window: (windowId: number) => void;
}

// Chrome 사건 하나를 듣거나 그만둔다. 이미 듣고 있으면 다시 걸지 않는다.
function toggle<L>(
  event: {
    addListener(listener: L): void;
    removeListener(listener: L): void;
    hasListener(listener: L): boolean;
  },
  listener: L,
  on: boolean,
): void {
  if (!on) event.removeListener(listener);
  else if (!event.hasListener(listener)) event.addListener(listener);
}

export interface TabActivity {
  // 참이면 사건을 듣고, 거짓이면 그만둔다. 듣지 않는 동안 Chrome은 이 사건으로 서비스 워커를 깨우지 않는다.
  readonly listen: (on: boolean) => void;
}

// 탭마다 켜고 끄는 기능이 듣는 탭과 창의 사건(결정 0041, 0043). 서비스 워커가 처음 실행될 때 불러야 Chrome이 서비스 워커를
// 깨워 사건을 넘긴다. 처음에는 듣는다. tabs.onUpdated는 모든 탭의 모든 바뀜에 서비스 워커를 깨우므로 켜진 탭이 있을 수 있는
// 동안만 듣는다(결정 0024의 실험 6과 같은 까닭).
export function watchTabActivity(handlers: TabActivityHandlers): TabActivity {
  const activated = (info: { readonly tabId: number }) => {
    handlers.activated(info.tabId);
  };
  const moved = (tabId: number) => {
    handlers.moved(tabId);
  };
  const updated = (
    tabId: number,
    change: {
      readonly status?: string;
      readonly url?: string;
      readonly discarded?: boolean;
      readonly splitViewId?: number;
    },
  ) => {
    if (
      change.status === 'complete' ||
      change.url !== undefined ||
      change.discarded !== undefined ||
      change.splitViewId !== undefined
    ) {
      handlers.updated(tabId);
    }
  };
  const created = (tab: chrome.tabs.Tab) => {
    if (tab.id !== undefined) handlers.created(tab.id);
  };
  const replaced = (added: number, removed: number) => {
    handlers.replaced(added, removed);
  };
  const removed = (tabId: number) => {
    handlers.removed(tabId);
  };
  const bounds = (window: chrome.windows.Window) => {
    if (window.id !== undefined) handlers.window(window.id);
  };
  const focused = (windowId: number) => {
    handlers.window(windowId);
  };
  // chrome-types(0.1.454)는 거르개를 받는 사건(CustomChromeEvent)의 removeListener·hasListener 인자를 addListener의 형으로 잘못
  // 적었다. Chrome에서는 다른 사건처럼 듣는 함수를 받는다(chrome.events.Event).
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- 위의 잘못 적힌 형을 바로잡는다.
  const focusChanged = chrome.windows.onFocusChanged as unknown as chrome.events.Event<
    (windowId: number) => void
  >;
  const listen = (on: boolean) => {
    toggle(chrome.tabs.onActivated, activated, on);
    toggle(chrome.tabs.onAttached, moved, on);
    toggle(chrome.tabs.onDetached, moved, on);
    toggle(chrome.tabs.onUpdated, updated, on);
    toggle(chrome.tabs.onCreated, created, on);
    toggle(chrome.tabs.onReplaced, replaced, on);
    toggle(chrome.tabs.onRemoved, removed, on);
    toggle(chrome.windows.onBoundsChanged, bounds, on);
    toggle(focusChanged, focused, on);
  };
  listen(true);
  return { listen };
}
