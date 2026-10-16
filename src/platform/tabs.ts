// 팝업이 붙은 창의 지금 탭(결정 0023). 팝업은 탭이 아니므로 그 창에서 사용자가 보던 탭이다. 없으면 null이다.
export async function currentTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

// 그 탭이 열려 있는지. 없는 탭이면 Chrome이 거절한다("No tab with id", 결정 0024의 실험 3). 탭 정보는 tabs 권한 없이도
// 받는다(주소와 제목만 빠진다).
export async function tabExists(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}
