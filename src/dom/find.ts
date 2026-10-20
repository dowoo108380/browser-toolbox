import type { Scope } from './scope.ts';
import { visibilityEventNames } from './visibility.ts';

// 외부 화면 요소 찾기와 적용 확인(COM-6, 결정 0026, 0034, 0035). 기능이 기대는 요소를 찾기 시작한 때, 또는 찾은 요소에 건
// 변경이 작용하는지 보기 시작한 때부터 탭이 보인 시간만 세어 기다리고, 한도를 넘기면 알린다. 기다리기, 관찰, 타이머는 모두
// 받은 자원 범위에 맡긴다(결정 0014). 둘 다 지금 화면의 요소만 본다: 페이지 안에서 이동하는 사이트는 앞 화면을 숨긴 채 문서에
// 남기곤 해서, 단서에 맞는 요소가 지금 화면의 것이라는 보장이 없다(결정 0035).

// 기능이 기대는 외부 화면 요소. 사이트의 요소는 그 사이트 모듈(sites/<사이트>/)이 정의한다(결정 0004).
export interface NamedElement {
  // 사이트와 요소를 점으로 이은 영어 이름표(예: chatgpt.thread). 문제 기록에 남는다.
  readonly id: string;
  // 사람이 알아볼 이름(예: "ChatGPT 대화 열"). 팝업의 "찾지 못함: (이름)"과 문제 기록에 남는다.
  readonly name: string;
  // 문서에서 단서에 맞는 요소들(문서 순서). 클래스 이름이 아니라 역할, aria-label, 요소 종류, 구조로 찾는다(R-13). 앞 화면이
  // 숨긴 채 남긴 것이 들어도 된다. 그 가운데 지금 화면의 것은 찾기와 확인이 고른다(currentElement).
  readonly candidates: (document: Document) => Iterable<Element>;
}

// 찾기(또는 적용 확인)를 시작한 때부터 탭이 보인 시간이 이만큼 지나도 이루어지지 않으면 어긋남이다(COM-6 기대 동작 4, R-14).
export const elementTimeoutMs = 15_000;

// 요소가 지금 화면에 그려지는지: 문서에 있고, 숨긴 상자(display: none, content-visibility: hidden) 안에 있지 않다. 크기가 0이거나
// 보이는 자리 밖에 있어도 그려지는 것이다. checkVisibility는 스타일만 계산하고 배치는 계산하지 않아 문서가 바뀔 때마다 불러도
// 싸다(결정 0035의 실험). display: contents인 요소는 제 상자가 없어 checkVisibility가 거짓이므로 내용이 그려지는 부모로 가린다.
function rendered(element: Element, window: Window): boolean {
  if (element.checkVisibility()) return true;
  const parent = element.parentElement;
  return (
    parent !== null &&
    window.getComputedStyle(element).display === 'contents' &&
    rendered(parent, window)
  );
}

// 지금 화면의 그 요소: 단서에 맞는 요소 가운데 문서 순서로 첫째인 그려지는 요소. 없으면 null이다.
function currentElement(element: NamedElement, window: Window): Element | null {
  for (const candidate of element.candidates(window.document)) {
    if (rendered(candidate, window)) return candidate;
  }
  return null;
}

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
  // 한도 전에도 볼지. 참이면 곧바로, 보이는 동안 문서가 바뀔 때마다, 다시 보일 때 본다. 거짓이면 한도에 이를 때만 본다.
  readonly early: boolean;
}

// 탭이 보인 시간만 세어 기다린다. 숨겨지면 관찰과 세기를 멈추고, 다시 보이면 이어 센다(quality 003). 보임의 바뀜은
// visibility.ts의 이름들로 듣는다(결정 0044). 한도에 이르면(마지막으로) 한 번 보고, 아니면 알린다. 이루어지거나 한도에 이르면
// 끝난다. 돌려준 함수는 이 기다림만 그만둔다. 범위가 닫혀도 그만둔다.
// probe의 예외는 처음 한 번이면 부른 쪽에, 그 뒤면 범위에 간다. onMet과 onTimeout은 범위가 감싼다.
function awaitVisibleTime<T>({ scope, window, probe, onMet, limit, early }: Wait<T>): () => void {
  const { document } = window;
  // 알림은 바깥 범위로 감싼다. 이 기다림의 자원을 닫은 뒤에도 부른다.
  const met = scope.guard(onMet);
  if (early) {
    const initial = probe();
    if (initial !== null) {
      met(initial);
      return () => undefined;
    }
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
    if (early) {
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

  // 같은 보임을 거듭 받아도 된다: watch와 pause는 이미 그 상태면 아무것도 하지 않는다.
  const onVisibility = () => {
    if (document.visibilityState !== 'visible') {
      pause();
      return;
    }
    if (!(early && check())) watch();
  };
  for (const type of visibilityEventNames) wait.listen(document, type, onVisibility);
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

// 지금 화면의 요소를 찾는다. 곧바로 한 번 찾고, 없으면 탭이 보이는 동안만 문서의 바뀜마다 다시 찾는다. 찾으면 onFound,
// 한도에 이르면 onTimeout이다(위 awaitVisibleTime). 앞 화면이 숨긴 채 남긴 것은 단서에 맞아도 찾은 것이 아니다.
export function awaitElement({ scope, window, element, onFound, limit }: Search): () => void {
  return awaitVisibleTime({
    scope,
    window,
    probe: () => currentElement(element, window),
    onMet: onFound,
    limit,
    early: true,
  });
}

interface Verification {
  readonly scope: Scope;
  readonly window: Window;
  // 변경을 건 요소들. 한도에 이를 때 지금 화면의 그 요소들로 판단한다.
  readonly elements: readonly NamedElement[];
  // 지금 화면의 그 요소들(elements와 같은 차례)을 받아, 변경이 작용하지 않는 첫 요소의 차례를 돌려준다. 모두 작용하면 null이다.
  readonly check: (current: readonly Element[]) => number | null;
  readonly limitMs: number;
  // 한도에 이르렀을 때 그 요소가 지금 화면에 없다(판단할 수 없다).
  readonly onMissing: (element: NamedElement) => void;
  // 한도에 이르렀을 때 지금 화면의 그 요소에 변경이 작용하지 않는다.
  readonly onUnapplied: (element: NamedElement) => void;
}

// 판단: 모두 작용함(null), 그 요소가 지금 화면에 없음, 지금 화면의 그 요소에 작용하지 않음.
type Verdict = null | { readonly kind: 'missing' | 'unapplied'; readonly element: NamedElement };

// 찾은 요소에 건 변경이 작용하는지 확인한다(결정 0034, 0035). 부른 때부터 탭이 보인 시간이 한도가 될 때 한 번, 그때의 지금 화면의
// 요소들로 판단한다. 그 전에는 보지 않는다:
// - 사이트가 화면을 다 그리기 전(스타일을 다 싣기 전)에 본 "작용하지 않음"으로 알리지 않는다.
// - 이른 "작용함"으로 끝내지 않는다. 사이트는 이동 신호 뒤에 새 화면을 그리므로, 이동 신호 때 찾아 바로 본 요소는 곧 숨겨질 앞
//   화면의 것일 수 있다.
// 그때 지금 화면에 없는 요소가 있으면 판단할 수 없는 것이라 작용함이 아니라 없음(onMissing)이다. check는 그려진 크기처럼 문서의
// 배치를 계산하게 하는 것을 읽어도 된다(한 번만 부른다).
export function awaitApplied({
  scope,
  window,
  elements,
  check,
  limitMs,
  onMissing,
  onUnapplied,
}: Verification): () => void {
  let verdict: Verdict = null;
  const judge = (): Verdict => {
    const current: Element[] = [];
    for (const element of elements) {
      const found = currentElement(element, window);
      if (found === null) return { kind: 'missing', element };
      current.push(found);
    }
    const index = check(current);
    if (index === null) return null;
    const element = elements[index];
    // 일어나면 안 되는 상태다. 던지면 범위가 그 기능의 실패로 기록한다(결정 0014).
    if (element === undefined)
      throw new RangeError(`확인 함수가 없는 차례 ${String(index)}를 냈다.`);
    return { kind: 'unapplied', element };
  };
  return awaitVisibleTime({
    scope,
    window,
    probe: () => {
      verdict = judge();
      return verdict === null ? true : null;
    },
    onMet: () => undefined,
    limit: {
      ms: limitMs,
      onTimeout: () => {
        if (verdict === null) return;
        if (verdict.kind === 'missing') onMissing(verdict.element);
        else onUnapplied(verdict.element);
      },
    },
    early: false,
  });
}
