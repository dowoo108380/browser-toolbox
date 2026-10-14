// 확장을 설치·갱신·다시 로드한 뒤, 열린 탭의 모든 프레임에서 옛 스크립트를 정리한다(결정 0008).

interface RetireMarkers {
  readonly eventName: string;
  readonly elementAttribute: string;
  readonly claimAttribute: string;
}

// 프레임 안에서 돈다. Chrome이 함수 본문만 옮겨 실행하므로 바깥의 이름을 쓰지 않는다.
// chrome-types는 func를 매개변수 없는 함수로 적어 두었다. args로 받는 값을 선택 매개변수로 받는다.
// 그 페이지의 문맥에서 돌므로 보안 문맥에서만 있는 API를 쓰지 않는다. 일반 http 페이지와 그 iframe에는 없다
// (예: crypto.randomUUID). 그래서 토큰은 서비스 워커가 만들어 넘긴다.
//
// 1. 일회용 토큰을 실은 물러남 이벤트를 보낸다. DOM 이벤트는 모든 세계의 듣기를 그 자리에서(동기로) 부른다.
//    연결이 끊긴 옛 실행 틀은 물러나며 자기 요소를 지우고, 살아 있는 실행 틀은 자기 요소에 토큰을 적는다.
// 2. 그래도 토큰이 없는 확장의 요소는 다시 로드 뒤 코드가 더 돌지 않는 옛 세계의 것이다(05단계에서 iframe으로 확인).
//    그 요소를 지운다.
export function retireInFrame(
  eventName?: string,
  elementAttribute?: string,
  claimAttribute?: string,
  token?: string,
) {
  if (
    eventName === undefined ||
    elementAttribute === undefined ||
    claimAttribute === undefined ||
    token === undefined
  ) {
    return;
  }
  document.dispatchEvent(new CustomEvent(eventName, { detail: token }));
  for (const element of document.querySelectorAll(`[${elementAttribute}]`)) {
    if (element.getAttribute(claimAttribute) !== token) element.remove();
  }
}

export async function retireInAllFrames(markers: RetireMarkers): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      // 탭마다 새 토큰. 서비스 워커는 확장의 출처라 늘 보안 문맥이다.
      const token = crypto.randomUUID();
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          func: retireInFrame,
          args: [markers.eventName, markers.elementAttribute, markers.claimAttribute, token],
        });
      } catch {
        // 오류 페이지처럼 스크립트를 넣을 수 없는 탭에는 정리할 옛 스크립트도 없다.
      }
    }),
  );
}
