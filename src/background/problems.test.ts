import { describe, expect, it } from 'vitest';
import { createFakeStore } from '../platform/fake.ts';
import { createProblemLog } from './problems.ts';

// 문제 기록(COM-5, 결정 0011의 problems 키).

describe('문제 기록', () => {
  it('COM-5.3 101번째 기록이 생기면 가장 오래된 것을 지워 최근 100개만 남긴다', async () => {
    const store = createFakeStore();
    let now = 0;
    const log = createProblemLog({ store, now: () => (now += 1) });
    for (let index = 0; index < 101; index += 1) {
      await log.record({ featureId: null, kind: 'timeout' });
    }
    const records = store.peek('problems');
    expect(Array.isArray(records) ? records.length : 0).toBe(100);
    expect(Array.isArray(records) ? records[0] : null).toEqual({
      at: 2,
      featureId: null,
      kind: 'timeout',
    });
  });

  it('COM-5 기대 동작 2 찾지 못한 외부 화면 요소는 이름표와 이름을 함께 남기고, 그 밖의 문제에는 요소 칸이 없다', async () => {
    const store = createFakeStore();
    const log = createProblemLog({ store, now: () => 5 });
    const element = { id: 'chatgpt.thread', name: 'ChatGPT 대화 열' };
    await log.record({ featureId: 'chatgpt-width', kind: 'not-found', element });
    await log.record({ featureId: null, kind: 'platform' });
    // toStrictEqual은 값이 undefined인 칸도 칸으로 본다.
    expect(store.peek('problems')).toStrictEqual([
      { at: 5, featureId: 'chatgpt-width', kind: 'not-found', element },
      { at: 5, featureId: null, kind: 'platform' },
    ]);
  });

  it('요소 칸이 없는 앞 판의 기록도 그대로 읽어 이어 쓴다', async () => {
    const store = createFakeStore({ problems: [{ at: 1, featureId: null, kind: 'timeout' }] });
    const log = createProblemLog({ store, now: () => 2 });
    await log.record({ featureId: null, kind: 'platform' });
    expect(store.peek('problems')).toEqual([
      { at: 1, featureId: null, kind: 'timeout' },
      { at: 2, featureId: null, kind: 'platform' },
    ]);
  });

  it('기록이 손상되었으면 새로 시작한다(기록은 진단용이라 잃어도 기능에 영향이 없다)', async () => {
    const store = createFakeStore({ problems: 'broken' });
    const log = createProblemLog({ store, now: () => 7 });
    await log.record({ featureId: 'media-speed', kind: 'unexpected' });
    expect(store.peek('problems')).toEqual([
      { at: 7, featureId: 'media-speed', kind: 'unexpected' },
    ]);
  });
});
