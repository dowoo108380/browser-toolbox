import { describe, expect, it } from 'vitest';
import { defaultWidth, maxWidth, minWidth, parseWidth, widthStep } from './width.ts';

describe('GPT-2 너비', () => {
  it('사용자가 정한 범위와 기본값(px)이다', () => {
    expect([minWidth, defaultWidth, maxWidth, widthStep]).toEqual([640, 1200, 3840, 10]);
  });

  it('숫자 칸의 글은 앞뒤 공백을 뺀 범위 안의 10진 정수만 너비로 읽는다', () => {
    const cases: readonly (readonly [string, number | null])[] = [
      ['640', 640],
      ['3840', 3840],
      ['1205', 1205],
      [' 1500 ', 1500],
      ['01200', 1200],
      ['639', null],
      ['3841', null],
      ['', null],
      ['  ', null],
      ['1200.5', null],
      ['1200.0', null],
      ['1e3', null],
      ['-700', null],
      ['+700', null],
      ['0x500', null],
      ['１２００', null],
      ['12 00', null],
    ];
    for (const [text, width] of cases) expect(parseWidth(text), JSON.stringify(text)).toBe(width);
  });
});
