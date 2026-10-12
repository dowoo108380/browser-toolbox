// 확장을 설치하거나 갱신하거나 다시 로드한 뒤 새 서비스 워커에서 한 번 온다.
export function listenInstalled(listener: () => void): void {
  chrome.runtime.onInstalled.addListener(() => {
    listener();
  });
}
