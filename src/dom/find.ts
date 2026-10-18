import type { Scope } from './scope.ts';

// 외부 화면 요소 찾기와 적용 확인(COM-6, 결정 0026, 0034). 기능이 기대는 요소를 찾기 시작한 때, 또는 찾은 요소에 건 변경이
// 작용하는지 보기 시작한 때부터 탭이 보인 시간만 세어 기다리고, 한도를 넘기면 알린다. 기다리기, 관찰, 타이머는 모두 받은 자원
// 범위에 맡긴다(결정 0014).

// 기능이 기대는 외부 화면 요소. 사이트의 요소는 그 사이트 모듈(sites/<사이트>/)이 정의한다(결정 0004).
export interface NamedElement {
  // 사이트와 요소를 점으로 이은 영어 이름표(예: chatgpt.thread). 문제 기록에 남는다.
  readonly id: string;
  // 사람이 알아볼 이름(예: "ChatGPT 대화 열"). 팝업의 "찾지 못함: (이름)"과 문제 기록에 남는다.
  readonly name: string;
  // 문서에서 그 요소를 찾는다. 없으면 null이다. 클래스 이름이 아니라 역할, aria-label, 요소 종류, 구조로 찾는다(R-13).
  readonly find: (document: Document) => Element | null;
}

// 찾기(또는 적용 확인)를 시작한 때부터 탭이 보인 시간이 이만큼 지나도 이루어지지 않으면 어긋남이다(COM-6 기대 동작 4, R-14).
export const elementTimeoutMs = 15_000;

// 보인 시간의 한도(ms)와 그에 이르렀을 때 부를 함수.
interface Limit {
  readonly ms: number;
  readonly onTimeout: () => void;
}

interface Wait<T> {
  readonly scope: Scope;
  readonly window: Window;
  // 기다리는 것이 이루어졌는지 본다. 이루어졌으면 그 값, 아니면 null이다.
  readonly probe: () => T | null;
  readonly onMet: (value: T) => void | Promise<void>;
  // null이면 한도 없이 기다린다(찾지 못한 뒤 실행 틀이 지켜볼 때).
  readonly limit: Limit | null;
  // 보이는 동안 문서가 바뀔 때마다 다시 볼지. 거짓이면 곧바로, 다시 보일 때, 한도에 이를 때만 본다.
  readonly observe: boolean;
}

// 곧바로 한 번 보고, 아니면 탭이 보이는 동안 기다린다(observe면 문서의 바뀜마다 다시 본다). 숨겨지면 관찰과 세기를 멈추고, 다시
// 보이면 한 번 보고 이어 센다(quality 003). 한도에 이르면 마지막으로 한 번 더 보고, 그래도 아니면 알린다. 이루어지거나 한도에
// 이르면 끝난다. 돌려준 함수는 이 기다림만 그만둔다. 범위가 닫혀도 그만둔다. probe의 예외는 처음 한 번이면 부른 쪽에, 그 뒤면
// 범위에 간다. onMet과 onTimeout은 범위가 감싼다.
function awaitVisibleTime<T>({ scope, window, probe, onMet, limit, observe }: Wait<T>): () => void {
  const { document } = window;
  // 알림은 바깥 범위로 감싼다. 이 기다림의 자원을 닫은 뒤에도 부른다.
  const met = scope.guard(onMet);
  const initial = probe();
  if (initial !== null) {
    met(initial);
    return () => undefined;
  }
  // 이 기다림의 자원(보이기 듣기, 그리고 보이는 동안의 관찰과 타이머). 끝나면 닫는다.
  const wait = scope.child();
  const stop = () => {
    wait.close();
  };
  // 남은 보인 시간. null이면 한도가 없다.
  let remaining = limit === null ? null : limit.ms;
  const timedOut = limit === null ? () => undefined : scope.guard(limit.onTimeout);
  // 보이는 동안의 관찰과 타이머, 그리고 그때부터 센 시각. 숨겨지면 닫는다.
  let watching: { readonly scope: Scope; readonly since: number } | null = null;

  const check = (): boolean => {
    const value = probe();
    if (value === null) return false;
    stop();
    met(value);
    return true;
  };

  const watch = () => {
    if (watching !== null || document.visibilityState !== 'visible') return;
    const inner = wait.child();
    watching = { scope: inner, since: window.performance.now() };
    if (observe) {
      inner
        .mutationObserver(() => {
          check();
        })
        .observe(document, { childList: true, subtree: true, attributes: true });
    }
    if (remaining !== null) {
      inner.timeout(remaining, () => {
        if (check()) return;
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

  wait.listen(document, 'visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      pause();
      return;
    }
    if (!check()) watch();
  });
  watch();
  return stop;
}

interface Search {
  readonly scope: Scope;
  readonly window: Window;
  readonly element: NamedElement;
  readonly onFound: (found: Element) => void | Promise<void>;
  readonly limit: Limit | null;
}

// 요소를 찾는다. 곧바로 한 번 찾고, 없으면 탭이 보이는 동안만 문서의 바뀜마다 다시 찾는다. 찾으면 onFound, 한도에 이르면
// onTimeout이다(위 awaitVisibleTime).
export function awaitElement({ scope, window, element, onFound, limit }: Search): () => void {
  return awaitVisibleTime({
    scope,
    window,
    probe: () => element.find(window.document),
    onMet: onFound,
    limit,
    observe: true,
  });
}

interface Verification {
  readonly scope: Scope;
  readonly window: Window;
  // 변경이 작용하지 않는 요소를 돌려준다. 모두 작용하거나 판단할 수 없으면 null이다.
  readonly check: () => NamedElement | null;
  readonly limit: { readonly ms: number; readonly onTimeout: (element: NamedElement) => void };
}

// 찾은 요소에 건 변경이 작용하는지 기다린다(결정 0034). check는 그려진 크기처럼 문서의 배치를 계산하게 하는 것을 읽어도 되도록
// 문서가 바뀔 때마다 부르지 않는다: 곧바로, 탭이 다시 보일 때, 한도에 이를 때 부른다. 한도에 이르러도 작용하지 않으면 그 요소로
// onTimeout을 부른다. 사이트가 화면을 다 그리기 전(스타일을 다 싣기 전)에 처음 본 결과로 알리지 않기 위해 한도까지 기다린다.
export function awaitApplied({ scope, window, check, limit }: Verification): () => void {
  let unapplied: NamedElement | null = null;
  return awaitVisibleTime({
    scope,
    window,
    probe: () => {
      unapplied = check();
      return unapplied === null ? true : null;
    },
    onMet: () => undefined,
    limit: {
      ms: limit.ms,
      onTimeout: () => {
        if (unapplied !== null) limit.onTimeout(unapplied);
      },
    },
    observe: false,
  });
}
