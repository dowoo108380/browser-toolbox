import { describe, expect, it } from 'vitest';
import { wantsDebugger } from './attach.ts';

// 켜진 탭에 디버거를 붙일지(TAB-2 기대 동작 2·3, 결정 0041).

const viewed = { web: true, shown: true, minimized: false, covered: false };

describe('디버거를 붙일지', () => {
  it('TAB-2.16 TAB-2.25 보는 탭(최소화되지 않은 창에 나와 있고 가려지지 않음)에는 붙이지 않는다', () => {
    expect(wantsDebugger(viewed)).toBe(false);
  });

  it('TAB-2.1·2.2·2.18 창에 나와 있지 않거나, 창이 최소화되었거나, 창이 가려진 탭에는 붙인다', () => {
    expect(wantsDebugger({ ...viewed, shown: false })).toBe(true);
    expect(wantsDebugger({ ...viewed, minimized: true })).toBe(true);
    expect(wantsDebugger({ ...viewed, covered: true })).toBe(true);
  });

  it('TAB-2.22 웹 페이지가 아니면 보지 않는 탭이어도 붙이지 않는다', () => {
    expect(wantsDebugger({ ...viewed, web: false, shown: false })).toBe(false);
  });
});
