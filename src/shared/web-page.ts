// 웹 페이지(TAB-2 기대 동작 11, 결정 0043): http·https 주소이고 Chrome 웹 스토어가 아니다. Chrome은 웹 스토어에 확장의
// 스크립트와 디버거를 들이지 않는다. Chrome 내부 화면, 새 탭, 내 컴퓨터의 파일, 확장 화면은 http·https가 아니다. 주소를 모르면
// (확장이 볼 수 없는 탭은 Chrome이 주소를 주지 않는다) 웹 페이지가 아니다.
export function isWebPage(url: string | undefined): boolean {
  if (url === undefined) return false;
  const parsed = URL.parse(url);
  if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    return false;
  }
  if (parsed.hostname === 'chromewebstore.google.com') return false;
  const store = parsed.pathname === '/webstore' || parsed.pathname.startsWith('/webstore/');
  return !(parsed.hostname === 'chrome.google.com' && store);
}
