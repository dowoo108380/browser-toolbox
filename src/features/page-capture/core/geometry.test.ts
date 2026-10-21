import { describe, expect, it } from 'vitest';
import {
  type Rect,
  copyAllowed,
  deviceSize,
  maxAreaDevicePx,
  maxCopyDevicePx,
  maxSideDevicePx,
  placeOf,
  tilesOf,
  tooLarge,
  within,
} from './geometry.ts';

// 캡처의 크기 계산(PAGE-1, R-10, 결정 0047, 0048).

describe('기기 픽셀과 한도', () => {
  it('CSS 크기에 배율을 곱해 반올림한다(Chrome이 찍은 그림과 같다)', () => {
    expect(deviceSize({ width: 1280, height: 13_107 }, 1.25)).toEqual({
      width: 1600,
      height: 16_384,
    });
    expect(deviceSize({ width: 1000, height: 5000 }, 1)).toEqual({ width: 1000, height: 5000 });
  });

  it('PAGE-1.4 한 변 65,535 기기 픽셀이나 넓이 268,435,456 기기 픽셀을 넘으면 너무 크다', () => {
    expect(maxSideDevicePx).toBe(65_535);
    expect(maxAreaDevicePx).toBe(268_435_456);
    expect(tooLarge({ width: 1000, height: 65_535 })).toBe(false);
    expect(tooLarge({ width: 65_535, height: 1 })).toBe(false);
    expect(tooLarge({ width: 1000, height: 65_536 })).toBe(true);
    expect(tooLarge({ width: 65_536, height: 10 })).toBe(true);
    expect(tooLarge({ width: 16_384, height: 16_384 })).toBe(false);
    expect(tooLarge({ width: 16_384, height: 16_385 })).toBe(true);
  });

  it('PAGE-1.21 5천만 화소까지 복사한다', () => {
    expect(maxCopyDevicePx).toBe(50_000_000);
    expect(copyAllowed({ width: 5000, height: 10_000 })).toBe(true);
    expect(copyAllowed({ width: 5000, height: 10_001 })).toBe(false);
  });

  it('보이는 화면 안인지는 반 픽셀까지 너그럽게 본다', () => {
    const view = { x: 0, y: 100, width: 800, height: 600 };
    expect(within({ x: 10, y: 100, width: 100, height: 600 }, view)).toBe(true);
    expect(within({ x: -0.5, y: 99.5, width: 800.5, height: 601 }, view)).toBe(true);
    // 오른쪽과 아래 끝이 꼭 반 픽셀 넘는 것도 안이다.
    expect(within({ x: 0, y: 100, width: 800.5, height: 600.5 }, view)).toBe(true);
    expect(within({ x: 10, y: 99, width: 10, height: 10 }, view)).toBe(false);
    expect(within({ x: 10, y: 600, width: 10, height: 101 }, view)).toBe(false);
    expect(within({ x: 790, y: 200, width: 11, height: 10 }, view)).toBe(false);
    expect(within({ x: -1, y: 200, width: 10, height: 10 }, view)).toBe(false);
  });
});

describe('R-10 조각', () => {
  // 조각들이 rect를 빈틈없이 덮는지 본다. 조각마다 한 변 16,384, 넓이 2^25 기기 픽셀을 넘지 않는다.
  function check(rect: Rect, dpr: number) {
    const tiles = tilesOf(rect, dpr);
    for (const tile of tiles) {
      const device = deviceSize(tile, dpr);
      expect(device.width).toBeLessThanOrEqual(16_384);
      expect(device.height).toBeLessThanOrEqual(16_384);
      expect(device.width * device.height).toBeLessThanOrEqual(33_554_432);
      expect(tile.x).toBeGreaterThanOrEqual(rect.x);
      expect(tile.y).toBeGreaterThanOrEqual(rect.y);
      expect(tile.x + tile.width).toBeLessThanOrEqual(rect.x + rect.width);
      expect(tile.y + tile.height).toBeLessThanOrEqual(rect.y + rect.height);
    }
    const points = [
      [rect.x, rect.y],
      [rect.x + rect.width - 0.5, rect.y + rect.height - 0.5],
      [rect.x + rect.width / 2, rect.y + rect.height / 2],
      [rect.x + rect.width / 3, rect.y + (rect.height * 2) / 3],
    ] as const;
    for (const [x, y] of points) {
      const covering = tiles.filter(
        (tile) => x >= tile.x && x < tile.x + tile.width && y >= tile.y && y < tile.y + tile.height,
      );
      expect(covering.length).toBeGreaterThan(0);
    }
    return tiles;
  }

  it('작은 영역은 조각 하나다', () => {
    expect(check({ x: 5, y: 7, width: 300, height: 200 }, 1.25)).toEqual([
      { x: 5, y: 7, width: 300, height: 200 },
    ]);
  });

  it('긴 페이지는 위에서 아래로 1 CSS 픽셀씩 겹치는 줄로 나눈다(배율 1.25)', () => {
    const tiles = check({ x: 0, y: 0, width: 1280, height: 30_000 }, 1.25);
    expect(tiles.length).toBeGreaterThan(1);
    for (const [index, tile] of tiles.entries()) {
      const next = tiles[index + 1];
      if (next !== undefined) expect(next.y).toBe(tile.y + tile.height - 1);
    }
  });

  it('넓은 조각은 넓이의 한도에 맞춰 줄을 낮춘다', () => {
    const tiles = check({ x: 0, y: 0, width: 3000, height: 20_000 }, 2);
    // 한 줄의 넓이(6002 기기 픽셀)로 2^25 화소를 넘지 않는 높이다.
    expect(tiles[0]?.height).toBeLessThanOrEqual(Math.floor(33_554_432 / 6002 / 2));
  });

  it('16,384 기기 픽셀보다 넓으면 칸으로도 나눈다', () => {
    const tiles = check({ x: 0, y: 0, width: 20_000, height: 100 }, 1);
    expect(tiles.map((tile) => tile.x)).toEqual([0, 16_383]);
    expect(tiles[0]?.width).toBe(16_384);
  });

  it('빈 영역은 조각이 없다', () => {
    expect(tilesOf({ x: 0, y: 0, width: 0, height: 100 }, 1)).toEqual([]);
    expect(tilesOf({ x: 0, y: 0, width: 100, height: 0 }, 1)).toEqual([]);
    expect(tilesOf({ x: 0, y: 0, width: -5, height: 100 }, 1)).toEqual([]);
  });

  it('찍은 그림을 결과 그림의 왼쪽 위에서 잰 기기 픽셀 네모에 놓는다', () => {
    const target = { x: 100, y: 1000, width: 400, height: 300 };
    expect(placeOf({ x: 100, y: 1000, width: 400, height: 300 }, target, 1.25)).toEqual({
      x: 0,
      y: 0,
      width: 500,
      height: 375,
    });
    // 보이는 화면 전체를 찍고 고른 영역만 남긴다.
    expect(placeOf({ x: 0, y: 900, width: 1280, height: 720 }, target, 1.25)).toEqual({
      x: -125,
      y: -125,
      width: 1600,
      height: 900,
    });
  });

  it('PAGE-1.26 이웃한 조각의 네모가 겹치거나 맞닿고, 마지막 조각이 결과 그림의 끝까지 닿아 틈이 없다', () => {
    // 배율 1.5625(화면 배율 1.25, 페이지 확대 125%)에서 둘째 조각의 위(16,381.25)와 높이(8,606.25)를 따로 반올림하면 끝이
    // 24,987이고 결과 그림은 24,988이다(그림의 크기로 놓으면 맨 아래 한 줄이 빈다).
    const dpr = 1.5625;
    const target = { x: 0, y: 0, width: 1000, height: 15_992 };
    const tiles = tilesOf(target, dpr);
    expect(tiles.length).toBe(2);
    const places = tiles.map((tile) => placeOf(tile, target, dpr));
    const size = deviceSize(target, dpr);
    expect(size.height).toBe(24_988);
    const [first, second] = places;
    expect(first?.y).toBe(0);
    expect((second?.y ?? 0) <= (first?.y ?? 0) + (first?.height ?? 0)).toBe(true);
    expect((second?.y ?? 0) + (second?.height ?? 0)).toBe(size.height);
    expect(places.every((place) => place.x === 0 && place.width === size.width)).toBe(true);
  });
});
