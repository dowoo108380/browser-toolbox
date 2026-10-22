import { describe, expect, it } from 'vitest';
import {
  edgePx,
  labelGapPx,
  maxScrollStepPx,
  minSelectionPx,
  rectBetween,
  scrollStep,
  sizeLabelAt,
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

describe('PAGE-1.27 크기 표시의 자리(옛 기능: 네모의 왼쪽 아래 바로 밑, 화면 아래 끝에 가까우면 네모 위)', () => {
  const view = { width: 800, height: 600 };
  const label = { width: 80, height: 20 };
  const gap = labelGapPx;

  it('네모의 왼쪽 아래 바로 밑에 둔다', () => {
    expect(gap).toBe(4);
    const rect = { x: 20, y: 30, width: 200, height: 100 };
    expect(sizeLabelAt(rect, label, view)).toEqual({ x: 20, y: 130 + gap });
    // 밑에 꼭 들어가면(화면 끝과 틈만큼 떨어짐) 아직 밑이다.
    const fits = { ...rect, height: view.height - 30 - 2 * gap - label.height };
    expect(sizeLabelAt(fits, label, view).y).toBe(30 + fits.height + gap);
  });

  it('화면 아래 끝에 가까워 밑에 들어가지 않으면 네모 위에 둔다', () => {
    const rect = { x: 20, y: 450, width: 200, height: 140 };
    expect(sizeLabelAt(rect, label, view)).toEqual({ x: 20, y: 450 - gap - label.height });
    const tight = { x: 20, y: 2 * gap + label.height, width: 200, height: 560 };
    expect(sizeLabelAt(tight, label, view).y).toBe(gap);
  });

  it('네모가 화면 높이를 넘어 밑에도 위에도 들어가지 않으면 왼쪽 아래 모서리에 가장 가까운 화면 안에 둔다', () => {
    // 아래로 저절로 스크롤해 위가 화면 밖이고 아래가 화면 끝 가까이.
    const down = { x: 20, y: -900, width: 200, height: 1490 };
    expect(sizeLabelAt(down, label, view)).toEqual({ x: 20, y: 590 - gap - label.height });
    // 위로 저절로 스크롤해 아래가 화면 밖.
    const up = { x: 20, y: 2, width: 200, height: 2000 };
    expect(sizeLabelAt(up, label, view)).toEqual({
      x: 20,
      y: view.height - gap - label.height,
    });
    // 크기 표시보다 낮은 화면에서도 위에서 틈만큼 떨어진다.
    expect(sizeLabelAt(up, label, { width: 800, height: 10 }).y).toBe(gap);
  });

  it('가로는 화면 안에 둔다', () => {
    const rect = { y: 30, width: 200, height: 100 };
    expect(sizeLabelAt({ ...rect, x: -300 }, label, view).x).toBe(gap);
    expect(sizeLabelAt({ ...rect, x: 790 }, label, view).x).toBe(view.width - gap - label.width);
  });
});
