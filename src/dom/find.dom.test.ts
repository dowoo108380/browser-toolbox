import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type NamedElement, awaitElement, elementTimeoutMs } from './find.ts';
import { createScope } from './scope.ts';

// 외부 화면 요소 찾기(COM-6, 결정 0026). 시계는 가짜이고, 문서가 보이는지는 시험이 정한다(headless Chromium의 문서는
// 늘 visible이다, 결정 0024의 실험 5).

let visibility: DocumentVisibilityState = 'visible';
const added: Element[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
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
  find: (root) => root.querySelector('[aria-label="시험 대상"]'),
};

function addTarget(label = '시험 대상'): Element {
  const element = document.createElement('section');
  element.setAttribute('aria-label', label);
  document.body.append(element);
  added.push(element);
  return element;
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
  const stop = awaitElement({
    scope,
    window,
    element,
    limitMs,
    onFound: (element) => {
      found.push(element);
    },
    onTimeout: () => {
      timeouts += 1;
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
      find: () => {
        calls += 1;
        throw new Error(`찾는 함수 실패 ${String(calls)}`);
      },
    };
    expect(() => search(broken)).toThrow('찾는 함수 실패 1');

    const later: NamedElement = {
      ...target,
      find: (root) => {
        if (root.querySelector('[data-break]') !== null) throw new Error('나중의 실패');
        return null;
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
      limitMs: elementTimeoutMs,
      onFound: () => {
        throw new Error('기능의 실패');
      },
      onTimeout: () => undefined,
    });
    expect(errors).toHaveLength(1);
  });
});
