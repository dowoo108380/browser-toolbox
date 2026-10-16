import { describe, expect, it } from 'vitest';
import { createFakeStore } from '../platform/fake.ts';
import { repairNoticeKey } from '../storage/index.ts';
import { createRepairNoticeLog } from './repair-notice.ts';

// 서비스 워커의 설정 복구 알림 기록(결정 0016).

const t = 1_790_000_000_000;

function setup(initial?: unknown) {
  const store = createFakeStore(initial === undefined ? {} : { [repairNoticeKey]: initial });
  const clock = { time: t };
  const log = createRepairNoticeLog({ store, now: () => clock.time });
  return { store, clock, log };
}

const sampleOnly = { whole: false, features: ['sample'], sites: [] };

describe('설정 복구 알림 기록', () => {
  it('고친 범위를 더해 가며 남긴다', async () => {
    const { store, clock, log } = setup();
    expect(await log.add(sampleOnly)).toEqual({ ok: true, value: null });
    clock.time += 1_000;
    await log.add({
      whole: true,
      features: ['sample', 'other'],
      sites: [{ host: 'example.com', featureId: 'sample' }],
    });
    expect(store.peek(repairNoticeKey)).toEqual({
      stamp: t + 1_000,
      whole: true,
      features: ['sample', 'other'],
      sites: [{ host: 'example.com', featureId: 'sample' }],
    });
  });

  it('사용자가 본 기록을 확인하면 비운다', async () => {
    const { store, clock, log } = setup({ stamp: t, ...sampleOnly });
    clock.time += 5;
    expect(await log.dismiss(t)).toEqual({ ok: true, value: null });
    expect(store.peek(repairNoticeKey)).toEqual({
      stamp: t + 5,
      whole: false,
      features: [],
      sites: [],
    });
  });

  it('확인보다 먼저 들어온 새 손상은 확인이 지우지 않는다(들어온 순서대로 한다)', async () => {
    const { store, clock, log } = setup({ stamp: t, ...sampleOnly });
    clock.time += 5;
    await Promise.all([log.add({ whole: false, features: ['other'], sites: [] }), log.dismiss(t)]);
    expect(store.peek(repairNoticeKey)).toEqual({
      stamp: t + 5,
      whole: false,
      features: ['sample', 'other'],
      sites: [],
    });
  });

  it.each([
    ['같은 기능', sampleOnly],
    ['설정 전체', { whole: true, features: [], sites: [] }],
    [
      '같은 사이트 항목',
      { whole: false, features: [], sites: [{ host: 'a.test', featureId: null }] },
    ],
  ])('확인보다 먼저 들어온 %s의 재손상은 확인이 지우지 않는다', async (_name, scope) => {
    const { store, clock, log } = setup({ stamp: t, ...scope });
    clock.time += 5;
    await Promise.all([log.add(scope), log.dismiss(t)]);
    expect(store.peek(repairNoticeKey)).toEqual({ stamp: t + 5, ...scope });
  });

  it('형식이 틀린 기록은 버리고 새로 시작한다', async () => {
    const { store, log } = setup({ stamp: 'x' });
    await log.add(sampleOnly);
    expect(store.peek(repairNoticeKey)).toEqual({ stamp: t, ...sampleOnly });
  });

  it('결정 0017 사이트 항목이 없던 때의 기록에 사이트 항목을 더한다', async () => {
    const { store, log } = setup({ stamp: t - 10, whole: false, features: ['sample'] });
    await log.add({ whole: false, features: [], sites: [{ host: 'a.test', featureId: 'sample' }] });
    expect(store.peek(repairNoticeKey)).toEqual({
      stamp: t,
      whole: false,
      features: ['sample'],
      sites: [{ host: 'a.test', featureId: 'sample' }],
    });
  });

  it('저장소에 쓰지 못하면 실패를 돌려준다', async () => {
    const fake = createFakeStore();
    const log = createRepairNoticeLog({
      store: { ...fake, set: () => Promise.reject(new Error('quota')) },
      now: () => t,
    });
    const added = await log.add({ whole: true, features: [], sites: [] });
    expect(added.ok).toBe(false);
    if (!added.ok) expect(added.error.kind).toBe('platform');
  });
});
