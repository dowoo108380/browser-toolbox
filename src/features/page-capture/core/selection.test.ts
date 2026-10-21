import { describe, expect, it } from 'vitest';
import {
  edgePx,
  maxScrollStepPx,
  minSelectionPx,
  rectBetween,
  scrollStep,
  tooSmall,
} from './selection.ts';

// 영역 고르기의 계산(PAGE-1 기대 동작 5).

describe('고른 네모', () => {
  it('두 점이 어느 쪽에 있든 왼쪽 위와 크기로 만든다', () => {
    const rect = { x: 10, y: 20, width: 100, height: 50 };
    expect(rectBetween({ x: 10, y: 20 }, { x: 110, y: 70 })).toEqual(rect);
    expect(rectBetween({ x: 110, y: 70 }, { x: 10, y: 20 })).toEqual(rect);
    expect(rectBetween({ x: 110, y: 20 }, { x: 10, y: 70 })).toEqual(rect);
  });

  it('PAGE-1.17 가로나 세로가 10 CSS 픽셀보다 작으면 너무 작다(누르기만 한 것 포함)', () => {
    expect(minSelectionPx).toBe(10);
    expect(tooSmall({ x: 0, y: 0, width: 0, height: 0 })).toBe(true);
    expect(tooSmall({ x: 0, y: 0, width: 9.5, height: 100 })).toBe(true);
    expect(tooSmall({ x: 0, y: 0, width: 100, height: 9 })).toBe(true);
    expect(tooSmall({ x: 0, y: 0, width: 10, height: 10 })).toBe(false);
  });
});

describe('PAGE-1.15 가장자리의 저절로 스크롤(옛 기능: 가까울수록 빠르게, 화면 한 번 그릴 때 30픽셀까지)', () => {
  const viewport = { width: 1000, height: 800 };

  it('가장자리에서 먼 곳에서는 움직이지 않는다', () => {
    expect(scrollStep({ x: 500, y: 400 }, viewport)).toEqual({ x: 0, y: 0 });
    expect(scrollStep({ x: edgePx, y: viewport.height - edgePx }, viewport)).toEqual({
      x: 0,
      y: 0,
    });
  });

  it('아래·오른쪽 가장자리에 가까울수록 빠르게 그쪽으로, 가장자리와 그 밖에서는 가장 빠르게 움직인다', () => {
    expect(maxScrollStepPx).toBe(30);
    const near = scrollStep({ x: 500, y: viewport.height - 30 }, viewport).y;
    const nearer = scrollStep({ x: 500, y: viewport.height - 10 }, viewport).y;
    expect(near).toBeGreaterThan(0);
    expect(nearer).toBeGreaterThan(near);
    expect(scrollStep({ x: 500, y: viewport.height }, viewport).y).toBe(30);
    expect(scrollStep({ x: 500, y: viewport.height + 200 }, viewport).y).toBe(30);
    expect(scrollStep({ x: viewport.width - 1, y: 400 }, viewport).x).toBe(
      Math.ceil(30 * (39 / 40)),
    );
  });

  it('위·왼쪽 가장자리에서는 반대쪽으로 움직인다', () => {
    expect(scrollStep({ x: 500, y: 0 }, viewport)).toEqual({ x: 0, y: -30 });
    expect(scrollStep({ x: -50, y: 400 }, viewport)).toEqual({ x: -30, y: 0 });
    expect(scrollStep({ x: 20, y: 400 }, viewport).x).toBe(-15);
  });

  it('작은 화면에서 두 가장자리가 모두 가까우면 더 가까운 쪽으로 간다', () => {
    const small = { width: 60, height: 60 };
    expect(scrollStep({ x: 10, y: 50 }, small)).toEqual({ x: -23, y: 23 });
    // 두 가장자리에 다 가까우면 더 가까운 쪽으로, 같으면 처음 쪽으로 간다.
    expect(scrollStep({ x: 35, y: 30 }, small)).toEqual({ x: 12, y: -8 });
  });
});
