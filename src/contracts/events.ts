// 새 버전이 열린 탭의 옛 스크립트에게 물러나라고 알리는 문서 DOM 이벤트(결정 0008).
// 웹 페이지도 같은 이벤트를 보낼 수 있으므로, 받는 쪽은 자기 연결이 끊겼을 때만 따른다.
export const retireEventName = 'browser-toolbox:retire';

// 콘텐츠 스크립트 실행 틀이 확장의 격리된 세계의 전역에 두는 표식의 이름(Symbol.for의 키). 한 프레임에 실행 틀이 둘
// 생기지 않게 하고(COM-1.4), 서비스 워커의 탐침이 그 탭에서 실행 틀이 도는지 본다(결정 0023).
export const pageRuntimeKey = 'browser-toolbox.page-runtime';
