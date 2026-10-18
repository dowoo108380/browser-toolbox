import { describe, expect, it } from 'vitest';
import { columnCss, defaultWidth, maxWidth, minWidth, parseWidth, widthStep } from './width.ts';

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

  it('GPT-2.1 GPT-2.3 선택자마다 담는 상자를 채우되 그 값을 넘지 않는 가운데 놓인 열로 만든다', () => {
    const rule =
      '{ box-sizing: border-box !important; width: 100% !important; max-width: 1000px !important; margin-inline: auto !important; }';
    expect(columnCss(['ol[data-a]', '[data-b]'], 1000)).toBe(
      [`ol[data-a] ${rule}`, `[data-b] ${rule}`].join('\n'),
    );
  });
});
