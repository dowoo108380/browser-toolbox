import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTimeout } from './timeout.ts';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ms 뒤에 value로 끝나는 일.
const after = <T>(ms: number, value: T) =>
  new Promise<T>((resolve) => {
    setTimeout(() => {
      resolve(value);
    }, ms);
  });

describe('제한 시간이 있는 기다림(withTimeout)', () => {
  it('시간 안에 끝나면 그 값을 돌려주고, 신호를 멈추지 않고, 타이머를 남기지 않는다', async () => {
    let signal: AbortSignal | undefined;
    const outcome = withTimeout(100, (given) => {
      signal = given;
      return after(99, '값');
    });
    await vi.advanceTimersByTimeAsync(99);
    await expect(outcome).resolves.toEqual({ done: true, value: '값' });
    expect(signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('quality 068 시간을 넘기면 정한 때에 done: false이고 신호를 멈춘다', async () => {
    let signal: AbortSignal | undefined;
    let settled = false;
    const outcome = withTimeout(100, (given) => {
      signal = given;
      return new Promise<never>(() => undefined);
    });
    void outcome.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toEqual({ done: false });
    expect(signal?.aborted).toBe(true);
  });

  it('시간 안의 거절은 그대로 전한다', async () => {
    await expect(withTimeout(100, () => Promise.reject(new Error('실패')))).rejects.toThrow('실패');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('시간을 넘긴 뒤에 온 값과 거절은 버린다(처리되지 않은 거절도 남지 않는다)', async () => {
    const late = withTimeout(100, () => after(150, '늦은 값'));
    const lateFailure = withTimeout(100, () =>
      after(150, null).then(() => Promise.reject(new Error('늦은 실패'))),
    );
    await vi.advanceTimersByTimeAsync(200);
    await expect(late).resolves.toEqual({ done: false });
    await expect(lateFailure).resolves.toEqual({ done: false });
  });
});
