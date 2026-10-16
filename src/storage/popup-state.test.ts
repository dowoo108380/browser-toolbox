import { describe, expect, it } from 'vitest';
import { createFakeStore } from '../platform/fake.ts';
import { popupStateKey, popupStateOf, readRememberedCategory } from './popup-state.ts';

describe('결정 0023 팝업이 마지막으로 고른 범주 읽기', () => {
  it('남긴 범주를 읽는다', async () => {
    const store = createFakeStore({ [popupStateKey]: popupStateOf('page') });
    expect(await readRememberedCategory(store)).toBe('page');
  });

  it('저장 키 이름은 popup이다(결정 0011의 표. 바꾸면 앞의 판이 남긴 값을 읽지 못한다)', async () => {
    const store = createFakeStore({ popup: { category: 'chatgpt' } });
    expect(await readRememberedCategory(store)).toBe('chatgpt');
  });

  it('없거나 모양이 틀리면 알리지 않고 null이다(첫 범주로 연다)', async () => {
    for (const value of [
      undefined,
      null,
      'page',
      [],
      {},
      { category: 'settings' },
      { category: 1 },
    ]) {
      const store = createFakeStore(value === undefined ? {} : { [popupStateKey]: value });
      expect(await readRememberedCategory(store), JSON.stringify(value)).toBeNull();
    }
  });

  it('읽지 못하면 null이다', async () => {
    const store = { get: () => Promise.reject(new Error('읽기 실패')) };
    expect(await readRememberedCategory(store)).toBeNull();
  });
});
