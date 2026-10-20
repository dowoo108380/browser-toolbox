// 확장의 격리된 쪽이 문서의 보임 바뀜을 듣는 이름(결정 0044).
// 페이지 활성 상태 유지의 방패(TAB-2, 페이지의 세계)는 켜진 동안 신뢰된 visibilitychange를 창의 캡처 단계에서 막는다(결정 0041).
// DOM 이벤트는 세계를 가리지 않고 한 줄로 전해지므로 격리된 쪽의 듣기에도 닿지 않는다. 그래서 방패는 막을 때마다 그 문서에 보임
// 알림을 보내고, 격리된 쪽은 visibilitychange를 직접 듣지 않고 둘 다 듣는다(린터가 지킨다). 보임 알림에는 내용이 없다. 받은 쪽은
// 자기 세계의 document.visibilityState를 다시 읽는다. 방패가 바꿔 끼우는 것은 페이지의 세계의 것이라 격리된 쪽은 실제 값을 읽는다.
// 웹 페이지도 두 이벤트를 보낼 수 있고 방패는 켜고 끌 때 visibilitychange를 보내므로, 듣는 쪽은 같은 보임을 거듭 받아도 맞아야
// 한다.

// 방패가 막은 visibilitychange 대신 보내는 이벤트(내용 없음, visibilitychange처럼 버블링함).
export const visibilityNoticeEventName = 'browser-toolbox:visibility';

// 보임이 바뀌었을 수 있다는 이벤트의 이름들. 격리된 쪽은 문서에서 이 이름들을 모두 듣는다.
export const visibilityEventNames: readonly string[] = [
  'visibilitychange',
  visibilityNoticeEventName,
];
