import { describe, expect, it } from 'vitest';
import { armDetail, parseArm } from './shield.ts';

// 격리된 쪽이 페이지 쪽 방패를 켜고 끄는 이벤트의 내용(결정 0041). 웹 페이지도 같은 이벤트를 보낼 수 있다.

describe('페이지 쪽 방패의 이벤트 내용', () => {
  it('켜기·끄기를 오간다', () => {
    expect(parseArm(armDetail(true))).toBe(true);
    expect(parseArm(armDetail(false))).toBe(false);
  });

  it.each([
    ['글이 아님', { on: true }],
    ['글을 담은 배열', [JSON.stringify({ on: true })]],
    ['JSON 수', '1'],
    ['JSON이 아님', 'on'],
    ['다른 키', JSON.stringify({ hidden: true })],
    ['참거짓이 아님', JSON.stringify({ on: 'yes' })],
    ['null', 'null'],
    ['너무 김', JSON.stringify({ on: true, pad: 'x'.repeat(64) })],
  ])('모양이 맞지 않으면 버린다: %s', (_name, detail) => {
    expect(parseArm(detail)).toBeNull();
  });

  it('내용은 64자까지 읽는다', () => {
    const padded = (length: number) => {
      const detail = JSON.stringify({ on: true, pad: 'x'.repeat(length - 20) });
      expect(detail).toHaveLength(length);
      return detail;
    };
    expect(parseArm(padded(64))).toBe(true);
    expect(parseArm(padded(65))).toBeNull();
  });
});
