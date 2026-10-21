// 캡처의 크기 계산(PAGE-1, 결정 0048). 길이는 따로 적지 않으면 CSS 픽셀이고, 문서의 왼쪽 위가 원점이다. 기기 픽셀은 CSS 픽셀에
// 화면 배율(devicePixelRatio: Windows 배율과 페이지 확대를 곱한 것)을 곱한 것이다.

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Rect extends Point, Size {}

// 결과 그림의 한도(R-10): 한 변 65,535 기기 픽셀(캔버스가 만들어지는 끝), 넓이 16,384²(그보다 크면 빈 그림이었다).
export const maxSideDevicePx = 65_535;
export const maxAreaDevicePx = 268_435_456;

// 조각 하나의 한도. 한 변은 16,384 기기 픽셀까지만 맞게 찍힌다(R-10: 그 아래는 맨 위가 되풀이). 넓이는 디버거가 돌려주는
// base64 글이 자바스크립트 글의 한도와 메모리에 무리가 없게 2^25 화소로 둔다(2026-10-21 실험: 잡음뿐인 2000×16000 조각이
// base64 128MB였다).
const maxTileSideDevicePx = 16_384;
const maxTileAreaDevicePx = 33_554_432;

// 클립보드에 복사하는 그림의 한도(결정 0047). Windows의 Chrome은 클립보드에 그림을 쓸 때 브라우저의 화면 스레드에서 PNG로
// 다시 압축하고(Chromium clipboard_win.cc의 EncodeBitmapToPngAcceptJank) 그동안 화면이 멈춘다. 이 컴퓨터에서 PNG 압축은
// 초당 5천만(사진처럼 압축되지 않는 그림)–1억 5천만(글이 많은 그림) 화소였다(2026-10-21 실험). 멈춤이 1초쯤에 그치게 둔다.
export const maxCopyDevicePx = 50_000_000;

// CSS 크기를 그 배율의 기기 픽셀로. Chrome이 찍은 그림의 크기와 같게 반올림한다(2026-10-21 실험: 13,107 CSS 픽셀이 배율 1.25에서
// 16,384 기기 픽셀).
export function deviceSize(size: Size, dpr: number): Size {
  return { width: Math.round(size.width * dpr), height: Math.round(size.height * dpr) };
}

// 그 크기가 결과 그림의 한도를 넘는지.
export function tooLarge(size: Size): boolean {
  return (
    size.width > maxSideDevicePx ||
    size.height > maxSideDevicePx ||
    size.width * size.height > maxAreaDevicePx
  );
}

export function copyAllowed(size: Size): boolean {
  return size.width * size.height <= maxCopyDevicePx;
}

// rect가 view 안에 있는지. 반올림의 차이로 반 픽셀 넘는 것은 안으로 본다.
export function within(rect: Rect, view: Rect): boolean {
  const slack = 0.5;
  return (
    rect.x >= view.x - slack &&
    rect.y >= view.y - slack &&
    rect.x + rect.width <= view.x + view.width + slack &&
    rect.y + rect.height <= view.y + view.height + slack
  );
}

// rect를 찍을 조각들(CSS 픽셀, 위에서 아래로 줄마다 왼쪽에서 오른쪽). 조각은 한 변과 넓이의 한도 안이고, 다음 조각과 1 CSS
// 픽셀 겹친다(마지막 줄과 칸은 rect의 끝까지). 이어 붙일 때 반올림 때문에 생길 수 있는 틈을 덮기 위해서다(뒤 조각이 겹친 곳을
// 덮어 그린다). rect가 비면(가로나 세로가 0 이하) 아래의 반복이 돌지 않아 조각도 없다.
export function tilesOf(rect: Rect, dpr: number): readonly Rect[] {
  // 겹치는 1픽셀을 더해도 한도 안이게 한 칸을 그만큼 작게 둔다.
  const step = (limitDevicePx: number) => Math.max(1, Math.floor(limitDevicePx / dpr) - 1);
  const columnWidth = Math.min(rect.width, step(maxTileSideDevicePx));
  const columnDevicePx = Math.ceil((columnWidth + 1) * dpr);
  const rowHeight = Math.min(
    rect.height,
    step(Math.min(maxTileSideDevicePx, Math.floor(maxTileAreaDevicePx / columnDevicePx))),
  );
  const tiles: Rect[] = [];
  for (let y = 0; y < rect.height; y += rowHeight) {
    for (let x = 0; x < rect.width; x += columnWidth) {
      const width = Math.min(columnWidth + 1, rect.width - x);
      const height = Math.min(rowHeight + 1, rect.height - y);
      tiles.push({ x: rect.x + x, y: rect.y + y, width, height });
    }
  }
  return tiles;
}

// 찍은 그림(shot)을 결과 그림(target을 그 배율로)에 놓을 자리(기기 픽셀). 결과 그림의 왼쪽 위가 원점이다. 그림이 결과보다
// 크면(보이는 화면 전체를 찍고 영역만 남김) 바깥은 잘린다.
export function placeOf(shot: Rect, target: Rect, dpr: number): Point {
  return { x: Math.round((shot.x - target.x) * dpr), y: Math.round((shot.y - target.y) * dpr) };
}
