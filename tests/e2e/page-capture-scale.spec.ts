import type { BrowserContext, Page, Worker } from '@playwright/test';
import { strings } from '../../src/features/page-capture/strings.ts';
import { type Rect, tilesOf } from '../../src/features/page-capture/core/geometry.ts';
import {
  addScriptLazyLoading,
  drawBands,
  finished,
  grantActiveTab,
  pngInfo,
  recordShots,
  savedFiles,
  setPageZoom,
  startCapture,
  stripeGaps,
} from './support/capture.ts';
import { expect, fixtureOrigin, serviceWorkerOf, test } from './support/extension.ts';
import { tabIdOf } from './support/tasks.ts';

// 캡처(PAGE-1.26)를 화면 배율(Windows 배율) 1.25와 1.5, 페이지 확대 100%와 125%에서 본다. 페이지의 배율(devicePixelRatio)은
// 둘을 곱한 것이고, 결과 그림은 그 배율이다(기대 동작 8). 페이지를 확대하면 디버거 명령의 길이(화면 높이, 찍을 영역)인 DIP가 CSS
// 픽셀과 달라지므로(R-10), 조각을 잇는 네 길(높은 문서, 넓은 문서, 안쪽 상자, 화면 밖까지 고른 영역)을 모든 조합에서 보고, 확대한
// 페이지에서는 디버거의 화면 높이·찍기를 쓰는 다른 길(지연 로딩, 보이는 화면만 찍기)과 디버거 없이 보이는 화면을 찍는 영역도
// 본다. 시험 페이지(capture-tiles.html)는 200px마다 색이 다른 띠이고(drawBands), 그림의 세로 줄을 위에서 아래까지 모두 읽어
// 띠가 아닌 곳(조각 사이나 맨 아래의 빈 띠, 어긋난 조각)이 없는지 보고, 디버거가 조각마다 페이지의 배율로 그렸는지(늘린 그림이
// 아닌지) 본다. 조각의 크기는 core/geometry.ts의 tilesOf가 정한다(한 변 16,384, 넓이 2^25 기기 픽셀).

test.describe.configure({ timeout: 90_000 });

const selectionHost = 'browser-toolbox-ui[data-browser-toolbox="page-capture-selection"]';

async function run(
  context: BrowserContext,
  extensionId: string,
  page: Page,
  button: '전체 캡처' | '영역 캡처',
) {
  const popup = await startCapture(context, extensionId, page, button);
  await popup.close();
}

async function onlyFile(worker: Worker): Promise<Buffer> {
  const files = await savedFiles(worker);
  expect(files).toHaveLength(1);
  const [file] = files;
  if (file === undefined) throw new Error('저장한 파일이 없다.');
  return file;
}

// 페이지에서 끌기를 기록한다(창의 포획 단계라 고르는 화면이 받기 전에 본다). 고른 영역은 누른 곳과 놓은 곳의 문서 좌표다.
async function recordDrag(page: Page): Promise<() => Promise<Rect>> {
  await page.evaluate(() => {
    const points: { x: number; y: number }[] = [];
    Reflect.set(window, '__drag', points);
    for (const type of ['pointerdown', 'pointerup']) {
      addEventListener(
        type,
        (event) => {
          if (event instanceof PointerEvent) {
            points.push({ x: event.clientX + scrollX, y: event.clientY + scrollY });
          }
        },
        { capture: true },
      );
    }
  });
  return async () => {
    const points: unknown = await page.evaluate((): unknown => Reflect.get(window, '__drag'));
    const list: readonly unknown[] = Array.isArray(points) ? points : [];
    const [down, up] = list;
    const at = (point: unknown, key: 'x' | 'y') => Number(Reflect.get(Object(point), key));
    const x = Math.min(at(down, 'x'), at(up, 'x'));
    const y = Math.min(at(down, 'y'), at(up, 'y'));
    return {
      x,
      y,
      width: Math.max(at(down, 'x'), at(up, 'x')) - x,
      height: Math.max(at(down, 'y'), at(up, 'y')) - y,
    };
  };
}

for (const [scale, zoom] of [
  [1.25, 1],
  [1.5, 1],
  [1.25, 1.25],
  [1.5, 1.25],
] as const) {
  const dpr = scale * zoom;
  test.describe(`화면 배율 ${String(scale)}, 페이지 확대 ${String(zoom * 100)}%(배율 ${String(dpr)})`, () => {
    test.use({
      realViewport: true,
      browserDebugging: true,
      chromiumArgs: [`--force-device-scale-factor=${String(scale)}`, '--window-size=1280,800'],
    });
    const device = (css: number) => Math.round(css * dpr);
    // 한 조각의 가장 큰 한 변(CSS 픽셀). 이보다 큰 것은 조각이 둘 이상이다.
    const tileSide = Math.floor(16_384 / dpr) - 1;

    // 시험 페이지를 열고 확대를 정한다(Chrome이 사이트마다 기억한 확대로 연 것과 같다).
    async function setup(context: BrowserContext, file = 'capture-tiles.html') {
      const worker = await serviceWorkerOf(context);
      const page = await context.newPage();
      await page.goto(`${fixtureOrigin}/${file}`, { waitUntil: 'domcontentloaded' });
      const tabId = await tabIdOf(worker, page);
      await setPageZoom(worker, page, tabId, zoom, dpr);
      const shots = await recordShots(worker);
      return { worker, page, tabId, shots };
    }

    // 디버거가 찍은 조각 가운데 그 영역을 화면 배율대로 그리지 않은 것(반올림의 1픽셀은 넘어간다). 영역은 DIP(CSS 픽셀 × 확대)라
    // 화면 배율을 곱한 크기가 페이지의 배율대로 그린 그림이다.
    async function blurred(shots: Awaited<ReturnType<typeof setup>>['shots']) {
      return (await shots()).filter(
        ({ clip, width, height }) =>
          Math.abs(width - clip.width * scale) > 1 || Math.abs(height - clip.height * scale) > 1,
      );
    }

    // 그 크기가 여러 조각(가로 columns개 이상, 세로 rows개 이상)인지. 시험이 여러 조각을 잇는 길을 지나는지 지킨다.
    function expectTiles(width: number, height: number, columns: number, rows: number) {
      const tiles = tilesOf({ x: 0, y: 0, width, height }, dpr);
      expect(new Set(tiles.map((tile) => tile.x)).size).toBeGreaterThanOrEqual(columns);
      expect(new Set(tiles.map((tile) => tile.y)).size).toBeGreaterThanOrEqual(rows);
    }

    test(`PAGE-1.26 높아서 조각이 여럿인 문서를 찍으면 그림이 문서 크기 × ${String(dpr)}이고 어느 줄에도 빈 띠가 없다`, async ({
      context,
      extensionId,
    }) => {
      const height = tileSide + 2000;
      const { worker, page, tabId, shots } = await setup(context);
      await drawBands(page, { height });
      const width = await page.evaluate(() => document.documentElement.clientWidth);
      expectTiles(width, height, 1, 2);
      await run(context, extensionId, page, '전체 캡처');
      expect(await finished(worker, tabId, 60_000)).toMatchObject({ status: 'succeeded' });
      expect(
        await stripeGaps(page, await onlyFile(worker), {
          dpr,
          top: 0,
          end: height,
          xs: [device(5), device(width / 2), device(width) - 5],
        }),
      ).toEqual({ width: device(width), height: device(height), gaps: [] });
      expect(await blurred(shots)).toEqual([]);
    });

    test(`PAGE-1.26 넓어서 조각이 가로로도 나뉘고 낮아지는 문서를 찍으면 그림이 문서 크기 × ${String(dpr)}이고 어느 줄에도 빈 띠가 없다`, async ({
      context,
      extensionId,
    }) => {
      const width = tileSide + 800;
      const height = 2400;
      expectTiles(width, height, 2, 2);
      const { worker, page, tabId, shots } = await setup(context);
      await drawBands(page, { height, width });
      await run(context, extensionId, page, '전체 캡처');
      expect(await finished(worker, tabId, 60_000)).toMatchObject({ status: 'succeeded' });
      expect(
        await stripeGaps(page, await onlyFile(worker), {
          dpr,
          top: 0,
          end: height,
          xs: [device(5), device(tileSide / 2), device(tileSide + 400), device(width) - 5],
        }),
      ).toEqual({ width: device(width), height: device(height), gaps: [] });
      expect(await blurred(shots)).toEqual([]);
    });

    test(`PAGE-1.26 PAGE-1.12 안쪽 상자의 내용이 조각 여럿이면 펼쳐 찍은 그림이 상자 크기 × ${String(dpr)}이고 어느 줄에도 빈 띠가 없다`, async ({
      context,
      extensionId,
    }) => {
      const height = tileSide + 2000;
      const { worker, page, tabId, shots } = await setup(context);
      await drawBands(page, { height, box: 'grows' });
      const width = await page.evaluate(
        () => document.getElementById('box')?.getBoundingClientRect().width ?? 0,
      );
      expectTiles(width, height, 1, 2);
      await run(context, extensionId, page, '전체 캡처');
      const record = await finished(worker, tabId, 60_000);
      expect(record).toMatchObject({ status: 'succeeded' });
      expect(String(Reflect.get(Object(record), 'summary'))).not.toContain(
        strings.partial['box-stuck'],
      );
      const checked = await stripeGaps(page, await onlyFile(worker), {
        dpr,
        top: 0,
        end: height,
        xs: [device(5), device(width / 2), device(width) - 5],
      });
      expect({ width: checked.width, gaps: checked.gaps }).toEqual({
        width: device(width),
        gaps: [],
      });
      // 펼친 상자는 늘린 화면 높이(100vh)라 그 소수점만큼(1 CSS 픽셀 안) 내용보다 높을 수 있다(2026-10-21 실험: 내용 15,106에
      // 상자 15,106.4). 그림은 상자의 크기다.
      expect(Math.abs(checked.height - device(height))).toBeLessThanOrEqual(1);
      expect(await blurred(shots)).toEqual([]);
    });

    test(`PAGE-1.26 PAGE-1.15 화면 밖까지 조각 여럿만큼 끌어 고른 영역을 찍으면 그림이 영역 크기 × ${String(dpr)}이고 어느 줄에도 빈 띠가 없다`, async ({
      context,
      extensionId,
      profileDirectory,
    }) => {
      const { worker, page, tabId, shots } = await setup(context);
      await drawBands(page, { height: tileSide + 3000 });
      const viewport = await page.evaluate(() => innerHeight);
      const drag = await recordDrag(page);
      await grantActiveTab(profileDirectory, extensionId, page);
      await run(context, extensionId, page, '영역 캡처');
      await page.bringToFront();
      await expect(page.locator(selectionHost)).toHaveCount(1);
      await page.mouse.move(100, 100);
      await page.mouse.down();
      await page.mouse.move(400, viewport - 2, { steps: 4 });
      // 고른 높이가 한 조각보다 커질 때까지 저절로 스크롤되기를 기다린다.
      await expect
        .poll(() => page.evaluate(() => scrollY), { timeout: 30_000 })
        .toBeGreaterThan(tileSide - viewport + 300);
      await page.mouse.up();
      expect(await finished(worker, tabId, 60_000)).toMatchObject({ status: 'succeeded' });
      const rect = await drag();
      expectTiles(rect.width, rect.height, 1, 2);
      expect(
        await stripeGaps(page, await onlyFile(worker), {
          dpr,
          top: rect.y,
          end: rect.y + rect.height,
          xs: [device(5), device(rect.width / 2), device(rect.width) - 5],
        }),
      ).toEqual({ width: device(rect.width), height: device(rect.height), gaps: [] });
      expect(await blurred(shots)).toEqual([]);
    });

    // 아래는 조각을 잇지 않지만 페이지 확대에서만 단위가 어긋나는 길이다(확대 100%는 page-capture.spec.ts가 본다).
    if (zoom === 1) return;

    test('PAGE-1.26 PAGE-1.10 확대한 페이지에서도 화면 밖의 브라우저·스크립트 지연 로딩 이미지가 모두 찍힌다', async ({
      context,
      extensionId,
    }) => {
      await addScriptLazyLoading(context);
      const { worker, page, tabId, shots } = await setup(context, 'capture-lazy.html');
      // 확대가 정해진 채 처음부터 실린 페이지로 한다(사이트마다 기억한 확대).
      await page.reload({ waitUntil: 'domcontentloaded' });
      await run(context, extensionId, page, '전체 캡처');
      expect(await finished(worker, tabId)).toMatchObject({ status: 'succeeded' });
      const info = await pngInfo(
        page,
        await onlyFile(worker),
        [2600, 3600, 4600, 5600].map((y): [number, number] => [device(200), device(y)]),
      );
      expect(info.colors).toEqual(['#ff0000', '#0000ff', '#ff0000', '#0000ff']);
      expect(await page.evaluate((): unknown => Reflect.get(window, '__scrolls'))).toEqual([]);
      expect(await blurred(shots)).toEqual([]);
    });

    test('PAGE-1.26 PAGE-1.13 확대한 페이지에서 보이는 화면만 찍으면 그림이 보이는 화면 × 배율이고 빈 곳이 없다', async ({
      context,
      extensionId,
    }) => {
      const { worker, page, tabId, shots } = await setup(context);
      await drawBands(page, { height: 4000, box: 'fixed' });
      // 확대한 페이지의 보이는 화면 너비는 CSS 픽셀로 소수다(clientWidth는 그것을 반올림한 것).
      const width = await page.evaluate(() => visualViewport?.width ?? 0);
      await run(context, extensionId, page, '전체 캡처');
      const record = await finished(worker, tabId);
      expect(record).toMatchObject({ status: 'succeeded' });
      expect(String(Reflect.get(Object(record), 'summary'))).toContain(
        strings.partial['box-stuck'],
      );
      // 보이는 화면의 높이는 디버깅 안내 막대 때문에 찍는 동안 바뀐다(page-capture.spec.ts의 PAGE-1.13). 너비와 모든 줄을 본다.
      const checked = await stripeGaps(page, await onlyFile(worker), {
        dpr,
        top: 0,
        end: 4000,
        xs: [device(5), device(width / 2), device(width * 0.9)],
      });
      expect({ width: checked.width, gaps: checked.gaps }).toEqual({
        width: device(width),
        gaps: [],
      });
      expect(await blurred(shots)).toEqual([]);
    });

    test('PAGE-1.26 PAGE-1.3 확대한 페이지에서 보이는 화면 안의 영역을 디버거 없이 찍으면 그 영역만 배율대로 저장된다', async ({
      context,
      extensionId,
      profileDirectory,
    }) => {
      const { worker, page, tabId, shots } = await setup(context);
      await drawBands(page, { height: 4000 });
      await page.evaluate(() => {
        window.scrollTo(0, 1000);
      });
      const drag = await recordDrag(page);
      await grantActiveTab(profileDirectory, extensionId, page);
      await run(context, extensionId, page, '영역 캡처');
      await page.bringToFront();
      await expect(page.locator(selectionHost)).toHaveCount(1);
      await page.mouse.move(100, 100);
      await page.mouse.down();
      await page.mouse.move(250, 200, { steps: 4 });
      await page.mouse.move(400, 300, { steps: 4 });
      await page.mouse.up();
      expect(await finished(worker, tabId)).toMatchObject({ status: 'succeeded' });
      const rect = await drag();
      expect(
        await stripeGaps(page, await onlyFile(worker), {
          dpr,
          top: rect.y,
          end: rect.y + rect.height,
          xs: [device(5), device(rect.width / 2), device(rect.width) - 5],
        }),
      ).toEqual({ width: device(rect.width), height: device(rect.height), gaps: [] });
      expect(await shots()).toEqual([]);
    });
  });
}
