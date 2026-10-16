import { describe, expect, it } from 'vitest';
import { createFakeStore } from '../platform/fake.ts';
import { popupStateKey } from '../storage/index.ts';
import { createPopupState } from './popup-state.ts';
import type { Problem } from './problems.ts';

describe('결정 0023 팝업이 고른 범주를 남김', () => {
  it('고른 범주를 popup에 통째로 쓴다', async () => {
    const store = createFakeStore({ [popupStateKey]: { category: 'media', other: 1 } });
    const problems: Problem[] = [];
    const state = createPopupState({ store, record: (problem) => problems.push(problem) });
    expect(await state.remember('page')).toEqual({ ok: true, value: null });
    expect(store.peek(popupStateKey)).toEqual({ category: 'page' });
    expect(problems).toEqual([]);
  });

  it('쓰지 못하면 platform으로 기록하고 실패를 돌려준다(팝업은 이 실패를 보이지 않는다)', async () => {
    const fake = createFakeStore();
    const store = { ...fake, set: () => Promise.reject(new Error('quota')) };
    const problems: Problem[] = [];
    const state = createPopupState({ store, record: (problem) => problems.push(problem) });
    const result = await state.remember('page');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('platform');
    expect(problems).toEqual([{ featureId: null, kind: 'platform' }]);
    expect(fake.peek(popupStateKey)).toBeUndefined();
  });
});
