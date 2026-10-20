import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type NamedElement, awaitApplied, awaitElement, elementTimeoutMs } from './find.ts';
import { type Scope, createScope } from './scope.ts';
import { visibilityNoticeEventName } from './visibility.ts';

// 외부 화면 요소 찾기와 적용 확인(COM-6, 결정 0026, 0034, 0035). 시계는 가짜이고, 문서가 보이는지는 시험이 정한다(headless
// Chromium의 문서는 늘 visible이다, 결정 0024의 실험 5). 요소가 지금 화면에 그려지는지는 실제 Chromium이 정한다.

let visibility: DocumentVisibilityState = 'visible';
const added: Element[] = [];
// 시험이 만든 범위. 끝나지 않은 찾기가 다음 시험의 보이기 바뀜을 받지 않게 닫는다(quality 104).
const scopes: Scope[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  for (const scope of scopes.splice(0)) scope.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, 'visibilityState');
  visibility = 'visible';
  for (const element of added.splice(0)) element.remove();
});

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

const target: NamedElement = {
  id: 'test.target',
  name: '시험 대상',
  candidates: (root) => root.querySelectorAll('[aria-label="시험 대상"]'),
};

function addTarget(label = '시험 대상', parent: Element = document.body): HTMLElement {
  const element = document.createElement('section');
  element.setAttribute('aria-label', label);
  parent.append(element);
  if (parent === document.body) added.push(element);
  return element;
}

// 앞 화면이 숨긴 채 남긴 상자를 문서 앞쪽에 둔다. 로그인한 chatgpt.com은 style="display: none"으로 숨긴다(2026-10-19).
function addHiddenScreen(
  hide: (screen: HTMLElement) => void = (screen) => {
    screen.style.display = 'none';
  },
): HTMLElement {
  const screen = document.createElement('div');
  hide(screen);
  document.body.prepend(screen);
  added.push(screen);
  return screen;
}

// 관찰 알림(마이크로태스크)까지 처리한다.
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

function search(element: NamedElement = target, limitMs: number | null = elementTimeoutMs) {
  const errors: unknown[] = [];
  const found: Element[] = [];
  let timeouts = 0;
  const scope = createScope({ window, onError: (error) => errors.push(error), isLive: () => true });
  scopes.push(scope);
  const stop = awaitElement({
    scope,
    window,
    element,
    onFound: (element) => {
      found.push(element);
    },
    limit:
      limitMs === null
        ? null
        : {
            ms: limitMs,
            onTimeout: () => {
              timeouts += 1;
            },
          },
  });
  return { scope, stop, errors, found, timeouts: () => timeouts };
}

describe('외부 화면 요소 찾기(결정 0026)', () => {
  it('요소가 이미 있으면 그 자리에서 알리고 관찰과 타이머를 남기지 않는다', () => {
    const element = addTarget();
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    const { found, timeouts } = search();
    expect(found).toEqual([element]);
    expect(observe).not.toHaveBeenCalled();
    vi.advanceTimersByTime(elementTimeoutMs * 2);
    expect(timeouts()).toBe(0);
  });

  it('나중에 더해진 요소를 문서의 바뀜에서 찾고 한 번만 알린다', async () => {
    const { found, timeouts } = search();
    vi.advanceTimersByTime(3000);
    const element = addTarget();
    await settle();
    expect(found).toEqual([element]);
    addTarget();
    await settle();
    vi.advanceTimersByTime(elementTimeoutMs);
    expect(found).toHaveLength(1);
    expect(timeouts()).toBe(0);
  });

  it('나중에 속성이 맞게 바뀐 요소도 찾는다(이름표를 늦게 다는 사이트)', async () => {
    const element = addTarget('아직 아님');
    const { found } = search();
    element.setAttribute('aria-label', '시험 대상');
    await settle();
    expect(found).toEqual([element]);
  });

  it('COM-6 기대 동작 4 찾기 시작한 때부터 보인 시간이 15초가 되면 찾지 못함을 한 번 알리고 더 찾지 않는다', async () => {
    const { found, timeouts } = search();
    vi.advanceTimersByTime(elementTimeoutMs - 1);
    expect(timeouts()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(timeouts()).toBe(1);
    addTarget();
    await settle();
    vi.advanceTimersByTime(elementTimeoutMs);
    expect(found).toEqual([]);
    expect(timeouts()).toBe(1);
  });

  it('COM-6 기대 동작 4 탭이 숨겨진 동안 지난 시간은 세지 않는다', () => {
    const { timeouts } = search();
    vi.advanceTimersByTime(10_000);
    setVisibility('hidden');
    vi.advanceTimersByTime(60_000);
    expect(timeouts()).toBe(0);
    setVisibility('visible');
    vi.advanceTimersByTime(elementTimeoutMs - 10_000 - 1);
    expect(timeouts()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(timeouts()).toBe(1);
  });

  it('COM-6.7 숨겨진 채 찾기 시작하면 보일 때부터 센다', () => {
    visibility = 'hidden';
    const { timeouts } = search();
    vi.advanceTimersByTime(60_000);
    expect(timeouts()).toBe(0);
    setVisibility('visible');
    vi.advanceTimersByTime(elementTimeoutMs - 1);
    expect(timeouts()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(timeouts()).toBe(1);
  });

  it('COM-6.7 결정 0044 방패가 visibilitychange를 막는 문서에서도 보임 알림으로 숨겨지고 보이는 것을 따라 센다', () => {
    // 페이지 활성 상태 유지의 방패가 켜진 문서에는 보임이 바뀌어도 visibilitychange 대신 보임 알림만 온다.
    const notice = (next: DocumentVisibilityState) => {
      visibility = next;
      document.dispatchEvent(new Event(visibilityNoticeEventName));
    };
    visibility = 'hidden';
    const { timeouts } = search();
    vi.advanceTimersByTime(60_000);
    notice('visible');
    vi.advanceTimersByTime(10_000);
    notice('hidden');
    vi.advanceTimersByTime(60_000);
    expect(timeouts()).toBe(0);
    notice('visible');
    vi.advanceTimersByTime(elementTimeoutMs - 10_000 - 1);
    expect(timeouts()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(timeouts()).toBe(1);
  });

  it('quality 003 숨겨진 동안은 문서를 관찰하지 않고, 다시 보이면 곧바로 찾는다', async () => {
    const { found } = search();
    setVisibility('hidden');
    const element = addTarget();
    await settle();
    expect(found).toEqual([]);
    setVisibility('visible');
    expect(found).toEqual([element]);
  });

  it('한도가 없으면 시간이 아무리 지나도 알리지 않고, 나타나면 찾는다', async () => {
    const { found, timeouts } = search(target, null);
    vi.advanceTimersByTime(60 * 60_000);
    expect(timeouts()).toBe(0);
    const element = addTarget();
    await settle();
    expect(found).toEqual([element]);
  });

  it('돌려준 함수로 그만두면 그 찾기는 찾지도 알리지도 않는다', async () => {
    const { stop, found, timeouts } = search();
    stop();
    addTarget();
    await settle();
    vi.advanceTimersByTime(elementTimeoutMs);
    expect(found).toEqual([]);
    expect(timeouts()).toBe(0);
  });

  it('범위가 닫히면 관찰과 타이머가 그친다(기능을 끔)', async () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const { scope, found, timeouts } = search();
    scope.close();
    expect(disconnect).toHaveBeenCalled();
    addTarget();
    await settle();
    vi.advanceTimersByTime(elementTimeoutMs);
    expect(found).toEqual([]);
    expect(timeouts()).toBe(0);
  });

  it('찾는 함수가 처음에 던지면 부른 쪽에 던지고, 그 뒤에 던지면 범위의 실패로 알린다', async () => {
    let calls = 0;
    const broken: NamedElement = {
      ...target,
      candidates: () => {
        calls += 1;
        throw new Error(`찾는 함수 실패 ${String(calls)}`);
      },
    };
    expect(() => search(broken)).toThrow('찾는 함수 실패 1');

    const later: NamedElement = {
      ...target,
      candidates: (root) => {
        if (root.querySelector('[data-break]') !== null) throw new Error('나중의 실패');
        return [];
      },
    };
    const { errors } = search(later);
    const breaker = document.createElement('div');
    breaker.dataset['break'] = '';
    document.body.append(breaker);
    added.push(breaker);
    await settle();
    expect(errors).toHaveLength(1);
  });

  it('결정 0034 한도에 이르면 마지막으로 한 번 더 찾는다(문서의 바뀜 없이 찾게 된 요소)', () => {
    let ready = false;
    const late: NamedElement = { ...target, candidates: () => (ready ? [document.body] : []) };
    const { found, timeouts } = search(late);
    vi.advanceTimersByTime(elementTimeoutMs - 1);
    ready = true;
    vi.advanceTimersByTime(1);
    expect(found).toEqual([document.body]);
    expect(timeouts()).toBe(0);
  });

  it.each([
    ['style="display: none"(로그인한 chatgpt.com)', undefined],
    [
      'hidden 속성',
      (screen: HTMLElement) => {
        screen.hidden = true;
      },
    ],
    [
      'content-visibility: hidden',
      (screen: HTMLElement) => {
        screen.style.contentVisibility = 'hidden';
      },
    ],
  ])(
    '결정 0035 앞 화면이 %s로 숨긴 채 문서 앞쪽에 남긴 요소는 단서에 맞아도 찾은 것이 아니고, 지금 화면에 그려지는 것을 찾는다',
    async (_name, hide) => {
      addTarget('시험 대상', addHiddenScreen(hide));
      const { found, timeouts } = search();
      expect(found).toEqual([]);
      const current = addTarget();
      await settle();
      expect(found).toEqual([current]);
      vi.advanceTimersByTime(elementTimeoutMs);
      expect(timeouts()).toBe(0);
    },
  );

  it('결정 0035 앞 화면의 숨은 요소만 있으면 15초 뒤 찾지 못함이고, 숨긴 상자가 다시 보이게 되면(속성의 바뀜) 찾는다', async () => {
    const screen = addHiddenScreen();
    const element = addTarget('시험 대상', screen);
    const first = search();
    vi.advanceTimersByTime(elementTimeoutMs);
    expect(first.found).toEqual([]);
    expect(first.timeouts()).toBe(1);

    const second = search(target, null);
    screen.style.removeProperty('display');
    await settle();
    expect(second.found).toEqual([element]);
  });

  it('결정 0035 크기가 0이어도, display: contents여도 내용이 그려지는 요소는 지금 화면의 것이다', () => {
    const empty = addTarget();
    empty.setAttribute('style', 'width: 0; height: 0; overflow: hidden;');
    expect(search().found).toEqual([empty]);
    empty.remove();

    const contents = addTarget();
    contents.style.display = 'contents';
    expect(search().found).toEqual([contents]);
    contents.remove();

    // 숨긴 상자 안의 display: contents는 그려지지 않는다.
    addTarget('시험 대상', addHiddenScreen()).style.display = 'contents';
    expect(search().found).toEqual([]);
  });

  it('찾았다는 알림이 던지면 범위의 실패로 알린다', () => {
    addTarget();
    const errors: unknown[] = [];
    const scope = createScope({
      window,
      onError: (error) => errors.push(error),
      isLive: () => true,
    });
    awaitElement({
      scope,
      window,
      element: target,
      onFound: () => {
        throw new Error('기능의 실패');
      },
      limit: { ms: elementTimeoutMs, onTimeout: () => undefined },
    });
    expect(errors).toHaveLength(1);
  });
});

describe('찾은 요소에 건 변경의 적용 확인(결정 0034, 0035)', () => {
  // 확인 함수. 작용하는지는 시험이 정하고(applied, 처음 값은 받음), 받은 지금 화면의 요소들과 부른 횟수를 적는다. 작용하지 않으면
  // unapplied가 낸 차례를 돌려준다.
  function verification(
    applied = false,
    elements: readonly NamedElement[] = [target],
    unapplied: (current: readonly Element[]) => number | null = () => 0,
  ) {
    const state = { applied, checks: 0 };
    const seen: (readonly Element[])[] = [];
    const errors: unknown[] = [];
    const missing: NamedElement[] = [];
    const notApplied: NamedElement[] = [];
    const scope = createScope({
      window,
      onError: (error) => errors.push(error),
      isLive: () => true,
    });
    scopes.push(scope);
    const stop = awaitApplied({
      scope,
      window,
      elements,
      check: (current) => {
        state.checks += 1;
        seen.push(current);
        return state.applied ? null : unapplied(current);
      },
      limitMs: elementTimeoutMs,
      onMissing: (element) => {
        missing.push(element);
      },
      onUnapplied: (element) => {
        notApplied.push(element);
      },
    });
    return { state, seen, scope, stop, errors, missing, notApplied };
  }

  it('한도 전에는 보지 않는다: 곧바로도, 문서가 바뀌어도(관찰하지 않음), 다시 보여도. 한도 때 한 번 보아 작용하면 알리지 않고 끝난다', async () => {
    addTarget();
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    const { state, missing, notApplied } = verification(true);
    expect(state.checks).toBe(0);
    addTarget('다른 것');
    await settle();
    setVisibility('hidden');
    setVisibility('visible');
    vi.advanceTimersByTime(elementTimeoutMs - 1);
    expect(state.checks).toBe(0);
    expect(observe).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(state.checks).toBe(1);
    expect([missing, notApplied]).toEqual([[], []]);
    vi.advanceTimersByTime(elementTimeoutMs * 2);
    expect(state.checks).toBe(1);
  });

  it('COM-6.8 한도 때 지금 화면의 그 요소에 작용하지 않으면 그 요소로 알린다(적용되지 않음)', () => {
    const element = addTarget();
    const { seen, missing, notApplied } = verification();
    vi.advanceTimersByTime(elementTimeoutMs);
    expect(seen).toEqual([[element]]);
    expect(notApplied).toEqual([target]);
    expect(missing).toEqual([]);
  });

  it('결정 0034 처음에 작용하지 않아도 한도 때 작용하게 되었으면(사이트가 스타일을 늦게 실음) 알리지 않는다', () => {
    addTarget();
    const { state, missing, notApplied } = verification();
    vi.advanceTimersByTime(elementTimeoutMs - 1);
    state.applied = true;
    vi.advanceTimersByTime(1);
    expect([missing, notApplied]).toEqual([[], []]);
  });

  it('결정 0035 한도 때 지금 화면에 그 요소가 없으면(앞 화면이 숨긴 것만 있음) 판단할 수 없어 작용함이 아니라 없음으로 알리고, 확인 함수를 부르지 않는다', () => {
    addTarget('시험 대상', addHiddenScreen());
    const { state, missing, notApplied } = verification(true);
    vi.advanceTimersByTime(elementTimeoutMs);
    expect(state.checks).toBe(0);
    expect(missing).toEqual([target]);
    expect(notApplied).toEqual([]);
  });

  it('결정 0035 시작할 때 작용하던 요소가 한도 때 숨겨져 있고 지금 화면의 것이 없으면 없음이다(이동 신호 때 본 앞 화면의 요소)', () => {
    const element = addTarget();
    const { missing } = verification(true);
    vi.advanceTimersByTime(5000);
    element.style.display = 'none';
    vi.advanceTimersByTime(elementTimeoutMs - 5000);
    expect(missing).toEqual([target]);
  });

  it('결정 0035 확인 함수는 지금 화면의 요소들을 elements의 차례로 받고, 그가 낸 차례의 요소로 알린다', () => {
    const second: NamedElement = {
      id: 'test.second',
      name: '두째 대상',
      candidates: (root) => root.querySelectorAll('[aria-label="두째 대상"]'),
    };
    const hidden = addHiddenScreen();
    addTarget('두째 대상', hidden);
    addTarget('시험 대상', hidden);
    const shownSecond = addTarget('두째 대상');
    const shownTarget = addTarget();
    const { seen, notApplied } = verification(false, [target, second], () => 1);
    vi.advanceTimersByTime(elementTimeoutMs);
    expect(seen).toEqual([[shownTarget, shownSecond]]);
    expect(notApplied).toEqual([second]);
  });

  it('COM-6 기대 동작 4 숨겨진 동안은 세지 않는다', () => {
    addTarget();
    const { state, notApplied } = verification();
    vi.advanceTimersByTime(10_000);
    setVisibility('hidden');
    vi.advanceTimersByTime(60_000);
    setVisibility('visible');
    vi.advanceTimersByTime(elementTimeoutMs - 10_000 - 1);
    expect(state.checks).toBe(0);
    expect(notApplied).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(notApplied).toEqual([target]);
  });

  it('그만두거나 범위가 닫히면 보지도 알리지도 않는다', () => {
    addTarget();
    const stopped = verification();
    stopped.stop();
    const closed = verification();
    closed.scope.close();
    vi.advanceTimersByTime(elementTimeoutMs);
    for (const { state, missing, notApplied } of [stopped, closed]) {
      expect(state.checks).toBe(0);
      expect([missing, notApplied]).toEqual([[], []]);
    }
  });

  it('확인 함수가 던지거나 없는 차례를 내면 알리지 않고 범위의 실패로 알린다', () => {
    addTarget();
    const throwing = verification(false, [target], () => {
      throw new Error('확인 실패');
    });
    const outOfRange = verification(false, [target], () => 1);
    vi.advanceTimersByTime(elementTimeoutMs);
    for (const { errors, missing, notApplied } of [throwing, outOfRange]) {
      expect(errors).toHaveLength(1);
      expect([missing, notApplied]).toEqual([[], []]);
    }
  });
});
