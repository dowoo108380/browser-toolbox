// 팝업이 붙은 창의 지금 탭(결정 0023). 팝업은 탭이 아니므로 그 창에서 사용자가 보던 탭이다. 없으면 null이다.
export async function currentTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}
