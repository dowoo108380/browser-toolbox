import { describe, expect, it } from 'vitest';
import { createFakeLocalStore } from '../platform/fake.ts';
import { repairNoticeKey } from '../storage/index.ts';
import { createRepairNoticeLog } from './repair-notice.ts';

// 서비스 워커의 설정 복구 알림 기록(결정 0016).

const t = 1_790_000_000_000;

function setup(initial?: unknown) {
  const store = createFakeLocalStore(initial === undefined ? {} : { [repairNoticeKey]: initial });
  const clock = { time: t };
  const log = createRepairNoticeLog({ store, now: () => clock.time });
  return { store, clock, log };
}

describe('설정 복구 알림 기록', () => {
  it('고친 범위를 더해 가며 남긴다', async () => {
    const { store, clock, log } = setup();
    expect(await log.add({ whole: false, features: ['sample'] })).toEqual({
      ok: true,
      value: null,
    });
    clock.time += 1_000;
    await log.add({ whole: true, features: ['sample', 'other'] });
    expect(store.peek(repairNoticeKey)).toEqual({
      stamp: t + 1_000,
      whole: true,
      features: ['sample', 'other'],
    });
  });

  it('사용자가 본 기록을 확인하면 비운다', async () => {
    const { store, clock, log } = setup({ stamp: t, whole: false, features: ['sample'] });
    clock.time += 5;
    expect(await log.dismiss(t)).toEqual({ ok: true, value: null });
    expect(store.peek(repairNoticeKey)).toEqual({ stamp: t + 5, whole: false, features: [] });
  });

  it('확인보다 먼저 들어온 새 손상은 확인이 지우지 않는다(들어온 순서대로 한다)', async () => {
    const { store, clock, log } = setup({ stamp: t, whole: false, features: ['sample'] });
    clock.time += 5;
    await Promise.all([log.add({ whole: false, features: ['other'] }), log.dismiss(t)]);
    expect(store.peek(repairNoticeKey)).toEqual({
      stamp: t + 5,
      whole: false,
      features: ['sample', 'other'],
    });
  });

  it('형식이 틀린 기록은 버리고 새로 시작한다', async () => {
    const { store, log } = setup({ stamp: 'x' });
    await log.add({ whole: false, features: ['sample'] });
    expect(store.peek(repairNoticeKey)).toEqual({ stamp: t, whole: false, features: ['sample'] });
  });

  it('저장소에 쓰지 못하면 실패를 돌려준다', async () => {
    const fake = createFakeLocalStore();
    const log = createRepairNoticeLog({
      store: { ...fake, set: () => Promise.reject(new Error('quota')) },
      now: () => t,
    });
    const added = await log.add({ whole: true, features: [] });
    expect(added.ok).toBe(false);
    if (!added.ok) expect(added.error.kind).toBe('platform');
  });
});
