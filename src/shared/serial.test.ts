import { describe, expect, it } from 'vitest';
import { createSerialQueue } from './serial.ts';

describe('차례로 하나씩', () => {
  it('앞 일이 끝난 뒤에 다음 일을 시작한다', async () => {
    const enqueue = createSerialQueue();
    const log: string[] = [];
    const slow = enqueue(async () => {
      log.push('a 시작');
      await new Promise((resolve) => setTimeout(resolve, 5));
      log.push('a 끝');
    });
    const fast = enqueue(() => {
      log.push('b');
      return Promise.resolve();
    });
    await Promise.all([slow, fast]);
    expect(log).toEqual(['a 시작', 'a 끝', 'b']);
  });

  it('앞 일이 실패해도 다음 일을 한다', async () => {
    const enqueue = createSerialQueue();
    const failing = enqueue(() => Promise.reject(new Error('실패')));
    const next = enqueue(() => Promise.resolve('다음'));
    await expect(failing).rejects.toThrow('실패');
    await expect(next).resolves.toBe('다음');
  });
});
