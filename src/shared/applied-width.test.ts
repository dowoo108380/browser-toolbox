import { describe, expect, it } from 'vitest';
import { unappliedIndex } from './applied-width.ts';

describe('GPT-2 너비가 걸렸는지의 판단(결정 0034)', () => {
  // 규칙을 px로 걸었을 때의 너비를 요소마다 정하는 가짜 잼. 잰 너비(px)를 차례로 적는다.
  function measuring(widthsAt: (px: number) => readonly number[]) {
    const asked: number[] = [];
    return {
      asked,
      measure: (px: number) => {
        asked.push(px);
        return widthsAt(px);
      },
    };
  }
  // 규칙이 작용하는 요소: 담는 상자(space)를 넘지 않는 한 규칙의 너비다.
  const obeys = (space: number) => (px: number) => Math.min(px, space);

  it('넓은 창에서 정한 값(1px 안)이면 작용하고 다시 재지 않는다', () => {
    for (const widths of [[1200, 1200.6, 1199.2], [1201], [1199]]) {
      const { asked, measure } = measuring(() => widths);
      expect(unappliedIndex(1200, measure), JSON.stringify(widths)).toBeNull();
      expect(asked, JSON.stringify(widths)).toEqual([1200]);
    }
  });

  it('정한 값보다 1px 넘게 넓으면 작용하지 않는다(그 요소의 자리)', () => {
    expect(unappliedIndex(1200, measuring(() => [1200, 1412]).measure)).toBe(1);
    expect(unappliedIndex(1200, measuring(() => [1201.1]).measure)).toBe(0);
    // 다른 요소 때문에 다시 잴 때 줄어들어도 넓은 것은 넓은 것이다.
    const wideAndNarrow = (px: number) => [px === 1200 ? 1412 : 600, obeys(600)(px)];
    expect(unappliedIndex(1200, measuring(wideAndNarrow).measure)).toBe(0);
  });

  it('좁은 창: 정한 값보다 1px 넘게 좁으면 가장 좁은 것의 절반으로 다시 재어, 줄어들면 작용한다', () => {
    const { asked, measure } = measuring((px) => [obeys(601)(px), obeys(616)(px)]);
    expect(unappliedIndex(1200, measure)).toBeNull();
    expect(asked).toEqual([1200, 300]);
    expect(unappliedIndex(1200, measuring(() => [1198.9]).measure)).toBe(0);
  });

  it('규칙이 듣지 않으면 창이 넓든 좁든 그 요소가 작용하지 않는다', () => {
    // 사이트가 변수를 그만 써 늘 768px(창이 넓음), 창에 맞춰 늘 600px(창이 사이트의 원래 너비보다 좁음).
    expect(unappliedIndex(1200, measuring(() => [768, 768]).measure)).toBe(0);
    expect(unappliedIndex(1200, measuring(() => [600, 600]).measure)).toBe(0);
    // 대화 열만 듣지 않으면 그 자리, 작성란만 듣지 않으면 그 자리다.
    expect(unappliedIndex(1200, measuring((px) => [768, obeys(2000)(px)]).measure)).toBe(0);
    expect(unappliedIndex(1200, measuring((px) => [obeys(2000)(px), 768]).measure)).toBe(1);
    expect(unappliedIndex(1200, measuring((px) => [obeys(900)(px), 768]).measure)).toBe(1);
  });

  it('1px 넘게 줄어야 줄어든 것이다', () => {
    expect(unappliedIndex(1200, measuring((px) => [px === 1200 ? 700 : 699]).measure)).toBe(0);
    expect(unappliedIndex(1200, measuring((px) => [px === 1200 ? 700 : 698.9]).measure)).toBeNull();
  });

  it('잴 요소가 없으면 작용하지 않는 요소도 없다', () => {
    const { asked, measure } = measuring(() => []);
    expect(unappliedIndex(1200, measure)).toBeNull();
    expect(asked).toEqual([1200]);
  });
});
