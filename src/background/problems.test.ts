import { describe, expect, it } from 'vitest';
import { createFakeLocalStore } from '../platform/fake.ts';
import { createProblemLog } from './problems.ts';

// 문제 기록(COM-5, 결정 0011의 problems 키).

describe('문제 기록', () => {
  it('COM-5.3 101번째 기록이 생기면 가장 오래된 것을 지워 최근 100개만 남긴다', async () => {
    const store = createFakeLocalStore();
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

  it('기록이 손상되었으면 새로 시작한다(기록은 진단용이라 잃어도 기능에 영향이 없다)', async () => {
    const store = createFakeLocalStore({ problems: 'broken' });
    const log = createProblemLog({ store, now: () => 7 });
    await log.record({ featureId: 'media-speed', kind: 'unexpected' });
    expect(store.peek('problems')).toEqual([
      { at: 7, featureId: 'media-speed', kind: 'unexpected' },
    ]);
  });
});
