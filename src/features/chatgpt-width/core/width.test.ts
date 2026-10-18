import { describe, expect, it } from 'vitest';
import { columnCss, defaultWidth, maxWidth, minWidth } from './width.ts';

describe('GPT-2 너비', () => {
  it('사용자가 정한 범위와 기본값(px)이다', () => {
    expect([minWidth, defaultWidth, maxWidth]).toEqual([640, 1200, 3840]);
  });

  it('GPT-2.1 GPT-2.3 선택자마다 담는 상자를 채우되 그 값을 넘지 않는 가운데 놓인 열로 만든다', () => {
    const rule =
      '{ box-sizing: border-box !important; width: 100% !important; max-width: 1000px !important; margin-inline: auto !important; }';
    expect(columnCss(['ol[data-a]', '[data-b]'], 1000)).toBe(
      [`ol[data-a] ${rule}`, `[data-b] ${rule}`].join('\n'),
    );
  });
});
