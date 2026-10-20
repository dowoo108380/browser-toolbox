import { describe, expect, it } from 'vitest';
import { heldTabs, originalOf, withHeld, withReplaced, withoutHeld } from './ledger.ts';

// 이 기능이 Chrome 상태를 바꾼 탭과 바꾸기 전의 값(TAB-2 기대 동작 5, 결정 0041).

describe('장부(원래 autoDiscardable)', () => {
  it('TAB-2.21 처음 적은 원래 값을 지키고, 다시 적어도 바꾸지 않는다', () => {
    const held = withHeld({}, 3, true);
    expect(originalOf(held, 3)).toBe(true);
    // 그 뒤에 읽은 값(false)은 이 기능이 바꾼 값이다.
    expect(originalOf(withHeld(held, 3, false), 3)).toBe(true);
    expect(originalOf(held, 4)).toBeNull();
    expect(heldTabs(withHeld(held, 4, false))).toEqual([3, 4]);
  });

  it('지운 탭은 장부에 없고, 바뀐 탭(tabs.onReplaced)으로 원래 값을 옮긴다', () => {
    const held = withHeld(withHeld({}, 1, true), 2, false);
    expect(heldTabs(withoutHeld(held, 1))).toEqual([2]);
    const moved = withReplaced(held, 9, 2);
    expect(originalOf(moved, 9)).toBe(false);
    expect(originalOf(moved, 2)).toBeNull();
    expect(withReplaced(held, 9, 5)).toEqual(held);
  });

  it('받은 장부를 고치지 않는다', () => {
    const held = withHeld({}, 1, true);
    withHeld(held, 2, true);
    withoutHeld(held, 1);
    withReplaced(held, 3, 1);
    expect(held).toEqual({ '1': { discardable: true } });
  });
});
