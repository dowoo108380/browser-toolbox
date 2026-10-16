import type { Scope } from './scope.ts';

// 외부 화면 요소 찾기(COM-6, 결정 0026). 기능이 기대는 요소를 찾기 시작한 때부터 탭이 보인 시간만 세어 찾고, 한도를
// 넘기면 알린다. 기다리기, 관찰, 타이머는 모두 받은 자원 범위에 맡긴다(결정 0014).

// 기능이 기대는 외부 화면 요소. 사이트의 요소는 그 사이트 모듈(sites/<사이트>/)이 정의한다(결정 0004).
export interface NamedElement {
  // 사이트와 요소를 점으로 이은 영어 이름표(예: chatgpt.thread). 문제 기록에 남는다.
  readonly id: string;
  // 사람이 알아볼 이름(예: "ChatGPT 대화 열"). 팝업의 "찾지 못함: (이름)"과 문제 기록에 남는다.
  readonly name: string;
  // 문서에서 그 요소를 찾는다. 없으면 null이다. 클래스 이름이 아니라 역할, aria-label, 요소 종류, 구조로 찾는다(R-13).
  readonly find: (document: Document) => Element | null;
}

// 찾기 시작한 때부터 탭이 보인 시간이 이만큼 지나도 찾지 못하면 찾지 못함이다(COM-6 기대 동작 4, R-14).
export const elementTimeoutMs = 15_000;

interface Search {
  readonly scope: Scope;
  readonly window: Window;
  readonly element: NamedElement;
  // 보인 시간의 한도(ms). null이면 한도 없이 나타날 때까지 지켜본다(찾지 못한 뒤 실행 틀이 지켜볼 때).
  readonly limitMs: number | null;
  readonly onFound: (found: Element) => void | Promise<void>;
  // 보인 시간이 한도에 이르렀다.
  readonly onTimeout: () => void;
}

// 곧바로 한 번 찾고, 없으면 탭이 보이는 동안만 문서의 바뀜마다 다시 찾는다. 숨겨지면 관찰과 세기를 멈추고, 다시 보이면 한 번
// 찾고 이어 센다(quality 003). 찾거나 한도에 이르면 끝난다. 돌려준 함수는 이 찾기만 그만둔다. 범위가 닫혀도 그만둔다.
// 찾는 함수의 예외는 처음 한 번이면 부른 쪽에, 그 뒤면 범위에 간다. onFound와 onTimeout은 범위가 감싼다.
export function awaitElement({
  scope,
  window,
  element,
  limitMs,
  onFound,
  onTimeout,
}: Search): () => void {
  const { document } = window;
  // 알림은 바깥 범위로 감싼다. 이 찾기의 자원을 닫은 뒤에도 부른다.
  const found = scope.guard(onFound);
  const timedOut = scope.guard(onTimeout);
  const initial = element.find(document);
  if (initial !== null) {
    found(initial);
    return () => undefined;
  }
  // 이 찾기의 자원(보이기 듣기, 그리고 보이는 동안의 관찰과 타이머). 끝나면 닫는다.
  const search = scope.child();
  const stop = () => {
    search.close();
  };
  // 남은 보인 시간. null이면 한도가 없다.
  let remaining = limitMs;
  // 보이는 동안의 관찰과 타이머, 그리고 그때부터 센 시각. 숨겨지면 닫는다.
  let watching: { readonly scope: Scope; readonly since: number } | null = null;

  const check = (): boolean => {
    const target = element.find(document);
    if (target === null) return false;
    stop();
    found(target);
    return true;
  };

  const watch = () => {
    if (watching !== null || document.visibilityState !== 'visible') return;
    const inner = search.child();
    watching = { scope: inner, since: window.performance.now() };
    inner
      .mutationObserver(() => {
        check();
      })
      .observe(document, { childList: true, subtree: true, attributes: true });
    if (remaining !== null) {
      inner.timeout(remaining, () => {
        stop();
        timedOut();
      });
    }
  };

  const pause = () => {
    if (watching === null) return;
    if (remaining !== null) {
      remaining = Math.max(0, remaining - (window.performance.now() - watching.since));
    }
    watching.scope.close();
    watching = null;
  };

  search.listen(document, 'visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      pause();
      return;
    }
    if (!check()) watch();
  });
  watch();
  return stop;
}
