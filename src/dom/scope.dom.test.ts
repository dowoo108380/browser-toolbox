import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScope } from './scope.ts';

// 자원 범위(결정 0014). 실행 틀이 기능마다 하나 만들어 시작 함수에 넘긴다.

// live가 거짓이면 실행 틀이 "연결이 끊겼다"고 답하는 것과 같다.
function setup() {
  const errors: unknown[] = [];
  const state = { live: true };
  const scope = createScope({
    window,
    onError: (error) => errors.push(error),
    isLive: () => state.live,
  });
  return { scope, errors, state };
}

describe('자원 범위', () => {
  it('닫으면 맡긴 정리를 반대 순서로 한 번씩 부른다', () => {
    const { scope } = setup();
    const order: string[] = [];
    scope.defer(() => order.push('a'));
    scope.defer(() => order.push('b'));
    scope.close();
    scope.close();
    expect(order).toEqual(['b', 'a']);
  });

  it('먼저 정리한 자원은 닫을 때 다시 정리하지 않는다', () => {
    const { scope } = setup();
    const cleanup = vi.fn();
    const release = scope.defer(cleanup);
    release();
    release();
    scope.close();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('닫힌 범위에 맡기면 곧바로 정리한다(시작 도중에 실패한 뒤 만든 자원도 남지 않는다)', () => {
    const { scope } = setup();
    scope.close();
    const cleanup = vi.fn();
    scope.defer(cleanup);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('정리 하나가 실패해도 나머지 정리는 하고 실패를 알린다', () => {
    const { scope, errors } = setup();
    const cleanup = vi.fn();
    scope.defer(cleanup);
    scope.defer(() => {
      throw new Error('정리 실패');
    });
    scope.close();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
  });

  it('감싼 콜백의 예외와 거절된 Promise를 알리고, 닫힌 뒤에는 부르지 않는다', async () => {
    const { scope, errors } = setup();
    const thrown = scope.guard(() => {
      throw new Error('콜백 실패');
    });
    const rejected = scope.guard(() => Promise.reject(new Error('비동기 실패')));
    expect(() => {
      thrown();
    }).not.toThrow();
    rejected();
    await vi.waitFor(() => {
      expect(errors).toHaveLength(2);
    });
    const later = vi.fn();
    const guarded = scope.guard(later);
    scope.close();
    guarded();
    expect(later).not.toHaveBeenCalled();
  });

  it('결정 0008 실행 틀이 살아 있지 않다고 하면(연결 끊김) 감싼 콜백을 부르지 않는다', () => {
    const { scope, state } = setup();
    const callback = vi.fn();
    const guarded = scope.child().guard(callback);
    state.live = false;
    guarded();
    expect(callback).not.toHaveBeenCalled();
    state.live = true;
    guarded();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('안쪽 범위는 바깥이 닫히면 함께 닫히고, 먼저 닫으면 바깥에서 빠진다', () => {
    const { scope } = setup();
    const first = scope.child();
    const second = scope.child();
    const firstCleanup = vi.fn();
    const secondCleanup = vi.fn();
    first.defer(firstCleanup);
    second.defer(secondCleanup);
    first.close();
    expect(firstCleanup).toHaveBeenCalledTimes(1);
    scope.close();
    expect(firstCleanup).toHaveBeenCalledTimes(1);
    expect(secondCleanup).toHaveBeenCalledTimes(1);
  });

  it('안쪽 콜백의 예외도 바깥과 같이 알린다', () => {
    const { scope, errors } = setup();
    scope.child().guard(() => {
      throw new Error('안쪽 실패');
    })();
    expect(errors).toHaveLength(1);
  });

  it('이벤트 듣기는 닫으면 그친다(capture로 건 것도)', () => {
    const { scope } = setup();
    const target = new EventTarget();
    const plain = vi.fn();
    const captured = vi.fn();
    scope.listen(target, 'ping', plain);
    scope.listen(target, 'ping', captured, { capture: true });
    target.dispatchEvent(new Event('ping'));
    scope.close();
    target.dispatchEvent(new Event('ping'));
    expect(plain).toHaveBeenCalledTimes(1);
    expect(captured).toHaveBeenCalledTimes(1);
  });

  describe('타이머', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('정한 시간 뒤에 한 번 부르고, 먼저 취소하거나 범위를 닫으면 부르지 않는다', () => {
      vi.useFakeTimers();
      const { scope } = setup();
      const fired = vi.fn();
      const cancelled = vi.fn();
      const closed = vi.fn();
      scope.timeout(100, fired);
      const cancel = scope.timeout(100, cancelled);
      scope.child().timeout(200, closed);
      cancel();
      vi.advanceTimersByTime(99);
      expect(fired).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(fired).toHaveBeenCalledTimes(1);
      scope.close();
      vi.advanceTimersByTime(1000);
      expect(fired).toHaveBeenCalledTimes(1);
      expect(cancelled).not.toHaveBeenCalled();
      expect(closed).not.toHaveBeenCalled();
    });

    it('부른 뒤에는 범위의 정리에 남지 않고, 콜백의 예외는 알린다', () => {
      vi.useFakeTimers();
      const { scope, errors } = setup();
      const clear = vi.spyOn(window, 'clearTimeout');
      scope.timeout(10, () => {
        throw new Error('타이머 콜백 실패');
      });
      vi.advanceTimersByTime(10);
      expect(errors).toHaveLength(1);
      const before = clear.mock.calls.length;
      scope.close();
      expect(clear.mock.calls.length).toBe(before);
      clear.mockRestore();
    });
  });

  describe('닫힌 범위에서는 관찰을 새로 시작하지 않는다', () => {
    // 닫힌 뒤에는 콜백이 불리지 않으므로 콜백으로는 구별되지 않는다. 브라우저에 관찰이 등록되는지를 본다.
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('MutationObserver', () => {
      const { scope } = setup();
      const observer = scope.mutationObserver(() => undefined);
      scope.close();
      const registered = vi.spyOn(MutationObserver.prototype, 'observe');
      observer.observe(document.body, { childList: true });
      expect(registered).not.toHaveBeenCalled();
    });

    it('안쪽 범위가 닫힌 뒤에도(바깥은 열려 있음)', () => {
      const { scope } = setup();
      const inner = scope.child();
      const observer = inner.mutationObserver(() => undefined);
      inner.close();
      const registered = vi.spyOn(MutationObserver.prototype, 'observe');
      observer.observe(document.body, { childList: true });
      expect(registered).not.toHaveBeenCalled();
    });

    it('열린 범위에서는 관찰을 등록한다', () => {
      const { scope } = setup();
      const registered = vi.spyOn(MutationObserver.prototype, 'observe');
      scope.mutationObserver(() => undefined).observe(document.body, { childList: true });
      expect(registered).toHaveBeenCalledTimes(1);
      scope.close();
    });
  });

  it('관찰 콜백은 관찰자를 받지 않는다(콜백이 관찰자를 붙잡아 닫힌 뒤에 쓸 수 없다)', async () => {
    const { scope } = setup();
    const records = vi.fn();
    const target = document.createElement('div');
    document.body.append(target);
    scope.mutationObserver(records).observe(target, { childList: true });
    target.append(document.createElement('span'));
    await vi.waitFor(() => {
      expect(records).toHaveBeenCalledTimes(1);
    });
    expect(records.mock.calls[0]).toHaveLength(1);
    scope.close();
    target.remove();
  });

  it('관찰은 닫으면 끊긴다', async () => {
    const { scope } = setup();
    const records = vi.fn();
    const observer = scope.mutationObserver(records);
    const target = document.createElement('div');
    document.body.append(target);
    observer.observe(target, { childList: true });
    target.append(document.createElement('span'));
    await vi.waitFor(() => {
      expect(records).toHaveBeenCalledTimes(1);
    });
    scope.close();
    target.append(document.createElement('span'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(records).toHaveBeenCalledTimes(1);
    target.remove();
  });
});
