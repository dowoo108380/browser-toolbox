// 팝업이 붙은 창의 지금 탭(결정 0023). 팝업은 탭이 아니므로 그 창에서 사용자가 보던 탭이다. 없으면 null이다.
export async function currentTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
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
