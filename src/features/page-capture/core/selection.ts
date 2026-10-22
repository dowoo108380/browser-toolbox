import type { Point, Rect, Size } from './geometry.ts';

// 영역 고르기의 계산(PAGE-1 기대 동작 5). 점은 문서의 좌표(CSS 픽셀)다. 화면의 좌표는 문서의 좌표에서 스크롤을 뺀 것이다.

// 이보다 작게 고르면 다시 고르게 한다(가로나 세로, CSS 픽셀. 제안).
export const minSelectionPx = 10;

// 저절로 스크롤하는 가장자리의 너비와, 화면 한 번 그릴 때 움직이는 가장 큰 거리(옛 기능: 30픽셀).
export const edgePx = 40;
export const maxScrollStepPx = 30;

// 두 점을 꼭짓점으로 하는 네모.
export function rectBetween(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

export function tooSmall(rect: Rect): boolean {
  return rect.width < minSelectionPx || rect.height < minSelectionPx;
}

// 한 축의 저절로 스크롤 거리. 화면 안 좌표 at이 가장자리에서 edgePx 안이면 가까울수록 빠르게(가장자리 밖이면 가장 빠르게)
// 그 가장자리 쪽으로 움직인다.
function stepAlong(at: number, length: number): number {
  const toStart = at;
  const toEnd = length - at;
  const speed = (distance: number) =>
    Math.ceil(maxScrollStepPx * Math.min(1, (edgePx - Math.max(0, distance)) / edgePx));
  if (toStart < edgePx && toStart <= toEnd) return -speed(toStart);
  if (toEnd < edgePx) return speed(toEnd);
  return 0;
}

// 끄는 동안 화면 안의 포인터 자리(viewport 크기 안 좌표)에서 이번 화면에 스크롤할 거리.
export function scrollStep(pointer: Point, viewport: Size): Point {
  return { x: stepAlong(pointer.x, viewport.width), y: stepAlong(pointer.y, viewport.height) };
}

// 크기 표시와 고른 네모 사이, 크기 표시와 화면 가장자리 사이의 틈(CSS 픽셀. 제안).
export const labelGapPx = 4;

// 끄는 동안 크기 표시를 둘 자리(화면 좌표의 왼쪽 위). rect는 고른 네모의 화면 좌표, label은 크기 표시의 크기, view는 고르는
// 화면의 크기다. 네모의 왼쪽 아래 바로 밑에 두고, 화면 아래 끝에 가까워 들어가지 않으면 네모 위에 둔다(옛 기능). 저절로 스크롤해
// 네모가 화면 높이를 넘어 둘 다 들어가지 않으면 네모의 왼쪽 아래 모서리에 가장 가까운 화면 안에 둔다(제안). 가로도 화면 안에 둔다.
export function sizeLabelAt(rect: Rect, label: Size, view: Size): Point {
  const inside = (at: number, length: number, limit: number) =>
    Math.max(labelGapPx, Math.min(at, limit - length - labelGapPx));
  const x = inside(rect.x, label.width, view.width);
  const bottom = rect.y + rect.height;
  const below = bottom + labelGapPx;
  if (below + label.height <= view.height - labelGapPx) return { x, y: below };
  const above = rect.y - labelGapPx - label.height;
  if (above >= labelGapPx) return { x, y: above };
  return { x, y: inside(bottom - labelGapPx - label.height, label.height, view.height) };
}
