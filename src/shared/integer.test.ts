import { describe, expect, it } from 'vitest';
import { parseInteger } from './integer.ts';

describe('결정 0039 숫자 칸의 글을 범위 안의 정수로 읽기', () => {
  it('앞뒤 공백을 뺀 10진 숫자만 받고, 범위의 양 끝을 포함한다', () => {
    const cases: readonly (readonly [string, number | null])[] = [
      ['10', 10],
      ['20', 20],
      [' 15 ', 15],
      ['015', 15],
      ['9', null],
      ['21', null],
      ['', null],
      ['15.0', null],
      ['1e1', null],
      ['-15', null],
      ['+15', null],
      ['１５', null],
      ['1 5', null],
    ];
    for (const [text, value] of cases) {
      expect(parseInteger(text, 10, 20), JSON.stringify(text)).toBe(value);
    }
  });
});
