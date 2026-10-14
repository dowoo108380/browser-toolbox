import { inflateSync } from 'node:zlib';
import type { Page } from '@playwright/test';

// 화면의 한 점의 색. 페이지 스크린샷을 그 점 1×1로 잘라 PNG를 읽는다.
// 1×1 PNG는 줄이 하나, 픽셀이 하나라 어느 필터든 왼쪽·위쪽 값이 0이다. 그래서 필터 바이트 뒤의 바이트가 곧 색이다.
// 최상위 층(popover)을 포함해 실제로 그려진 것을 본다. DOM API로는 position-visibility로 숨은 것을 알 수 없다(결정 0018).
export async function pixelAt(
  page: Page,
  x: number,
  y: number,
): Promise<readonly [number, number, number]> {
  const png = await page.screenshot({
    clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 },
  });
  let offset = 8;
  let colorType = -1;
  const data: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      if (body.readUInt32BE(0) !== 1 || body.readUInt32BE(4) !== 1 || body[8] !== 8) {
        throw new Error('1×1, 8비트 PNG가 아니다.');
      }
      colorType = body[9] ?? -1;
    }
    if (type === 'IDAT') data.push(body);
    offset += 12 + length;
  }
  // 2는 RGB, 6은 RGBA다. 첫 바이트는 필터 종류다.
  if (colorType !== 2 && colorType !== 6) {
    throw new Error(`모르는 PNG 색 형식: ${String(colorType)}`);
  }
  const [, red = -1, green = -1, blue = -1] = inflateSync(Buffer.concat(data));
  return [red, green, blue];
}
