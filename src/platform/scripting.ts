// 열린 http·https 탭의 모든 프레임 문서에 DOM 이벤트 하나를 보낸다.
// 새 버전이 옛 스크립트에게 물러나라고 알릴 때 쓴다(결정 0008). DOM 이벤트는 모든 세계와 버전의 스크립트가 받는다.
export async function dispatchEventInAllFrames(eventName: string): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          // chrome-types는 func를 매개변수 없는 함수로 적어 두었다. args로 받는 값을 선택 매개변수로 받는다.
          func: (name?: string) => {
            if (name !== undefined) document.dispatchEvent(new Event(name));
          },
          args: [eventName],
        });
      } catch {
        // 오류 페이지처럼 스크립트를 넣을 수 없는 탭에는 정리할 옛 스크립트도 없다.
      }
    }),
  );
}
