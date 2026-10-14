// 확장을 설치·갱신·다시 로드한 뒤, 열린 탭의 모든 프레임에서 옛 스크립트를 정리한다(결정 0008).

import { type AppError, appError, withTimeout } from '../shared/index.ts';

interface RetireMarkers {
  readonly eventName: string;
  readonly elementAttribute: string;
  readonly claimAttribute: string;
}

// 프레임 안에서 돈다. Chrome이 함수 본문만 옮겨 실행하므로 바깥의 이름을 쓰지 않는다.
// chrome-types는 func를 매개변수 없는 함수로 적어 두었다. args로 받는 값을 선택 매개변수로 받는다.
// 그 페이지의 문맥에서 돌므로 보안 문맥에서만 있는 API를 쓰지 않는다. 일반 http 페이지와 그 iframe에는 없다
// (예: crypto.randomUUID). 그래서 토큰은 서비스 워커가 만들어 넘긴다.
// 끝까지 돌면 참을 돌려준다. 함수가 예외를 내도 executeScript는 거절되지 않고 그 프레임의 결과가 null일 뿐이라
// (2026-10-14 실험, Chromium 156), 이 값으로 끝까지 돌았는지 가린다.
// 같은 문서에서 같은 토큰으로 두 번 돌아도 결과가 같다(살아 있는 실행 틀은 같은 토큰을 다시 적고, 지울 요소는 이미 없다).
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
): boolean {
  if (
    eventName === undefined ||
    elementAttribute === undefined ||
    claimAttribute === undefined ||
    token === undefined
  ) {
    return false;
  }
  document.dispatchEvent(new CustomEvent(eventName, { detail: token }));
  for (const element of document.querySelectorAll(`[${elementAttribute}]`)) {
    if (element.getAttribute(claimAttribute) !== token) element.remove();
  }
  return true;
}

// Chrome이 그 탭이나 문서에는 넣을 수 없다고 거절할 때의 문구(Chromium 156에서 받음, 결정 0008 고친 기록 2026-10-14).
// 넣을 수 없는 페이지이거나 넣는 사이에 탭·문서가 사라진 것이라 정리할 옛 스크립트가 없으므로 문제가 아니다.
// 이 밖의 거절은 문제로 알린다. Chrome이 문구를 바꾸면 그 거절이 문제 기록에 남는다(숨지 않는 쪽으로 틀린다).
const cannotInject = [
  // 네트워크 오류 등으로 오류 페이지를 보이는 탭.
  /Frame with ID \d+ is showing error page/,
  // 넣는 사이에 프레임이 사라짐(부하에서 봄).
  /Frame with ID \d+ was removed/,
  // 목록을 얻은 뒤 닫힌 탭.
  /No tab with id/,
  // 다시 넣으려던 문서가 그 사이 이동하거나 지워짐.
  /No document with id/,
  // 확장이 그 페이지에 접근할 수 없음(버려진 탭, 아직 주소가 정해지지 않은 로딩 중의 탭. 사용자가 사이트 접근을 거둔
  // 경우도 같은 검사로 본다, 추정).
  /Cannot access contents of the page/,
  // Chrome 웹 스토어.
  /The extensions gallery cannot be scripted/,
];

// 한 번 넣은 결과. ran: 넣었고 함수가 끝까지 돌지 못한 문서의 id들, unavailable: 넣을 수 없는 탭·문서,
// failed: 그 밖의 거절.
type Injection =
  | { readonly status: 'ran'; readonly unfinished: readonly string[] }
  | { readonly status: 'unavailable' }
  | { readonly status: 'failed'; readonly error: AppError };

async function inject(
  target: chrome.scripting.InjectionTarget,
  args: readonly string[],
): Promise<Injection> {
  try {
    const results = await chrome.scripting.executeScript({
      target,
      func: retireInFrame,
      args: [...args],
      // 정리 함수는 문서가 다 실리기를 기다릴 이유가 없다. 이것이 없으면 Chrome은 document_idle까지 기다리는데,
      // 응답이 끝나지 않는 문서는 그때가 오지 않는다(2026-10-14 확장 전체 시험으로 확인, 결정 0008 고친 기록).
      injectImmediately: true,
    });
    return {
      status: 'ran',
      unfinished: results.filter((frame) => frame.result !== true).map((frame) => frame.documentId),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (cannotInject.some((known) => known.test(message))) return { status: 'unavailable' };
    // Chrome의 문구에는 페이지 주소가 들어갈 수 있어 옮기지 않는다(quality 082).
    return {
      status: 'failed',
      error: appError('platform', '옛 스크립트를 정리하는 함수를 넣지 못했다.'),
    };
  }
}

async function retireInTab(
  tabId: number,
  markers: RetireMarkers,
  signal: AbortSignal,
): Promise<AppError | null> {
  // 탭마다 새 토큰. 서비스 워커는 확장의 출처라 늘 보안 문맥이다.
  const args = [
    markers.eventName,
    markers.elementAttribute,
    markers.claimAttribute,
    crypto.randomUUID(),
  ];
  const first = await inject({ tabId, allFrames: true }, args);
  if (first.status === 'unavailable') return null;
  if (first.status === 'failed') return first.error;
  // 끝까지 돌지 못한 문서는 함수가 예외를 냈거나, 넣는 사이에 그 문서가 이동·삭제된 것이다(부하에서 봄, 둘 다 결과가 null).
  // 그 문서에만 한 번 더 넣어 가린다. 사라졌으면 Chrome이 거절하고, 남아 있는데 또 끝까지 돌지 못하면 함수의 실패다.
  for (const documentId of first.unfinished) {
    // 제한 시간을 넘긴 탭은 이미 timeout으로 알렸다. 더 넣지 않는다.
    if (signal.aborted) return null;
    const again = await inject({ tabId, documentIds: [documentId] }, args);
    if (again.status === 'failed') return again.error;
    if (again.status === 'ran' && again.unfinished.length > 0) {
      return appError(
        'unexpected',
        '옛 스크립트를 정리하는 함수가 어떤 문서에서 끝까지 돌지 못했다.',
      );
    }
  }
  return null;
}

// 한 탭을 정리하는 기다림의 제한 시간(아키텍처 7장 "비동기, 제한 시간, 취소"). 바로 넣으므로 보통 곧 끝난다. 그 탭의
// 페이지가 주 스레드를 붙잡고 있으면 Chrome은 풀릴 때까지 함수를 돌리지 못하고 기다린다(2026-10-14 확장 전체 시험).
// 메시지의 기본 제한 시간과 같게 둔다.
export const retireTimeoutMs = 5000;

// 탭마다 동시에 정리하고, 탭의 문제는 그 탭이 끝나는 대로 report로 알린다. 응답하지 않는 탭이 다른 탭의 문제를 붙잡지
// 않으므로, 부르는 쪽이 알리는 대로 기록하면 그 사이 서비스 워커가 멈춰도 앞의 기록은 남는다. 한 탭의 실패가 다른 탭의
// 정리를 막지 않는다. 모든 탭이 끝나거나 제한 시간을 넘기면 끝난다.
export async function retireInAllFrames(
  markers: RetireMarkers,
  report: (problem: AppError) => void,
): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(
    tabs.map(async ({ id, discarded }) => {
      // 버려진(discarded) 탭은 문서가 내려가 돌던 스크립트가 없다.
      if (id === undefined || discarded) return;
      const outcome = await withTimeout(retireTimeoutMs, (signal) =>
        retireInTab(id, markers, signal),
      );
      if (!outcome.done) {
        // 늦게 끝나도 결과는 버린다. 이 탭은 여기서 알렸다.
        report(
          appError(
            'timeout',
            '옛 스크립트를 정리하는 동안 어떤 탭이 제한 시간 안에 응답하지 않았다.',
          ),
        );
      } else if (outcome.value !== null) {
        report(outcome.value);
      }
    }),
  );
}
