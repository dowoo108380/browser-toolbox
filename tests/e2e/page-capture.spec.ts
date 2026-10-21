import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { strings } from '../../src/features/page-capture/strings.ts';
import {
  addScriptLazyLoading,
  bandColors,
  clipboardPng,
  clipboardText,
  clipboardTypes,
  countAttaches,
  debuggerAttached,
  finished,
  grantActiveTab,
  pngInfo,
  savedFiles,
  startCapture,
  taskOf,
  writeClipboardText,
} from './support/capture.ts';
import {
  expect,
  fixtureOrigin,
  indicatorTexts,
  openPopup,
  openPopupOn,
  reloadExtension,
  serviceWorkerOf,
  test,
  watchServiceWorker,
} from './support/extension.ts';
import { tabIdOf } from './support/tasks.ts';

// 전체·영역 캡처(PAGE-1, 결정 0046–0048)를 빌드한 확장으로 본다. 화면 배율 1.25로 띄우고, Playwright가 화면 크기를 흉내 내지
// 않게 한다(캡처가 디버거로 화면 높이를 바꾼다). 저장한 파일은 다운로드 기록의 경로에서 읽는다. 작업의 기록을 읽는 시험은
// 시작한 뒤 팝업을 닫는다: 열린 팝업이 끝난 결과를 보이면 그 기록을 확인한 것으로 지운다(COM-10). 실제 저장 이름·폴더와 활성
// 상태 유지와 함께 쓰기(TAB-2.6)는 page-capture-raw.spec.ts가, 안내 막대의 취소(PAGE-1.24)는 연결 시험과 수동 절차가 본다.

const dpr = 1.25;
test.use({
  realViewport: true,
  chromiumArgs: [`--force-device-scale-factor=${String(dpr)}`, '--window-size=1280,800'],
});
// 끝나지 않는 이미지를 5초 기다리는 시험과 서비스 워커를 다시 띄우는 시험이 있다.
test.describe.configure({ timeout: 60_000 });

const device = (css: number) => Math.round(css * dpr);
const selectionHost = 'browser-toolbox-ui[data-browser-toolbox="page-capture-selection"]';
// Playwright가 다운로드를 맡아 자기 폴더에 GUID 이름으로 저장하므로(R-11) 확장은 요청한 하위 폴더에 저장되지 않은 것으로 보고
// "고른 곳에"라고 쓴다(결정 0047). 실제 폴더와 이름과 그 문구는 page-capture-raw.spec.ts가 본다.
const savedPattern = /^고른 곳에 .+로 저장했다\. 클립보드에도 복사했다\./;

// 끝나지 않는 이미지가 있는 페이지는 load가 오지 않으므로 DOMContentLoaded까지만 기다린다.
async function setup(context: BrowserContext, file: string) {
  const worker = await serviceWorkerOf(context);
  const page = await context.newPage();
  await page.goto(`${fixtureOrigin}/${file}`, { waitUntil: 'domcontentloaded' });
  const tabId = await tabIdOf(worker, page);
  return { worker, page, tabId };
}

// 팝업에서 시작하고 팝업을 닫는다.
async function run(
  context: BrowserContext,
  extensionId: string,
  page: Page,
  button: '전체 캡처' | '영역 캡처',
) {
  const popup = await startCapture(context, extensionId, page, button);
  await popup.close();
}

const summaryOf = (record: unknown) => String(Reflect.get(Object(record), 'summary'));
const messageOf = (record: unknown) =>
  String(Reflect.get(Object(Reflect.get(Object(record), 'error')), 'message'));

async function onlyFile(worker: Worker): Promise<Buffer> {
  const files = await savedFiles(worker);
  expect(files).toHaveLength(1);
  const [file] = files;
  if (file === undefined) throw new Error('저장한 파일이 없다.');
  return file;
}

test.describe('전체 캡처', () => {
  test('PAGE-1.1 PAGE-1.2 PAGE-1.9 PAGE-1.20 PAGE-1.23 중간까지 스크롤한 긴 페이지를 찍으면 배율을 곱한 크기에 표식이 모두 있고 고정 헤더가 맨 위에 한 번 나오며, 클립보드에는 HTML 없이 같은 그림만 있고 끝나면 스크롤 자리가 돌아오고 디버거가 떨어진다', async ({
    context,
    extensionId,
  }) => {
    const { worker, page, tabId } = await setup(context, 'capture-markers.html');
    await page.evaluate(() => {
      window.scrollTo(0, 2500);
    });
    const width = await page.evaluate(() => document.documentElement.clientWidth);
    const attaches = await countAttaches(worker);
    await run(context, extensionId, page, '전체 캡처');
    const record = await finished(worker, tabId);
    expect(record).toMatchObject({ status: 'succeeded' });
    expect(summaryOf(record)).toMatch(savedPattern);
    const x = device(width / 2);
    const points: [number, number][] = [
      [x, device(30)],
      ...bandColors
        .slice(0, 10)
        .map((_color, band): [number, number] => [x, device(band * 500 + 250)]),
      // 스크롤했던 자리(2500px)에 고정 헤더가 다시 찍히지 않았다.
      [x, device(2530)],
    ];
    const info = await pngInfo(page, await onlyFile(worker), points);
    expect({ width: info.width, height: info.height }).toEqual({
      width: device(width),
      height: device(5000),
    });
    expect(info.colors).toEqual(['#000000', ...bandColors.slice(0, 10), bandColors[5]]);
    const copied = await clipboardPng(page);
    if (copied === null) throw new Error('클립보드에 그림이 없다.');
    expect(await pngInfo(page, copied, points)).toEqual(info);
    expect(await clipboardTypes(page)).toEqual([['image/png']]);
    expect(await page.evaluate(() => scrollY)).toBe(2500);
    expect(await debuggerAttached(worker, tabId)).toBe(false);
    expect(await attaches()).toBe(1);
  });

  test('PAGE-1.11 PAGE-1.22 불러오기가 끝나지 않는 이미지가 있어도 5초 남짓 기다린 뒤 저장하고, 그동안 팝업에 진행 중이 보이며 끝나면 저장한 파일 이름과 복사했는지가 보인다', async ({
    context,
    extensionId,
  }) => {
    const { worker, page } = await setup(context, 'capture-stuck.html');
    const started = Date.now();
    const popup = await startCapture(context, extensionId, page, '전체 캡처');
    const status = popup.locator('.task');
    await expect(status).toHaveText('전체 캡처: 진행 중이다.');
    await expect(status).toHaveText(/^전체 캡처: 끝났다\. /, { timeout: 20_000 });
    const took = Date.now() - started;
    expect(took).toBeGreaterThan(4500);
    expect(took).toBeLessThan(15_000);
    const shown = (await status.textContent()) ?? '';
    expect(shown.slice('전체 캡처: 끝났다. '.length)).toMatch(
      new RegExp(`${savedPattern.source}$`),
    );
    await onlyFile(worker);
  });

  test('PAGE-1.10 화면 밖의 브라우저 지연 로딩 이미지와 스크롤해야 불러오는 스크립트 지연 로딩 이미지가 모두 찍히고, 기다리는 동안 페이지가 스크롤되지 않는다', async ({
    context,
    extensionId,
  }) => {
    await addScriptLazyLoading(context);
    const { worker, page, tabId } = await setup(context, 'capture-lazy.html');
    await run(context, extensionId, page, '전체 캡처');
    expect(await finished(worker, tabId)).toMatchObject({ status: 'succeeded' });
    const info = await pngInfo(
      page,
      await onlyFile(worker),
      [2600, 3600, 4600, 5600].map((y): [number, number] => [device(200), device(y)]),
    );
    expect(info.colors).toEqual(['#ff0000', '#0000ff', '#ff0000', '#0000ff']);
    expect(await page.evaluate((): unknown => Reflect.get(window, '__scrolls'))).toEqual([]);
  });

  test('PAGE-1.12 안쪽 상자만 스크롤되는 페이지는 그 상자의 내용 전체를 찍고, 상자 안의 고정 머리와 입력란이 한 번씩 나오며, 끝나면 상자의 스크롤 자리가 돌아온다', async ({
    context,
    extensionId,
  }) => {
    const { worker, page, tabId } = await setup(context, 'capture-box.html');
    const width = await page.evaluate(() => {
      const box = document.getElementById('box');
      if (box === null) throw new Error('상자가 없다.');
      box.scrollTop = 1500;
      return box.getBoundingClientRect().width;
    });
    await run(context, extensionId, page, '전체 캡처');
    const record = await finished(worker, tabId);
    expect(record).toMatchObject({ status: 'succeeded' });
    expect(summaryOf(record)).toMatch(new RegExp(`${savedPattern.source}$`));
    const height = 40 + 12 * 400 + 100;
    const x = device(width / 2);
    const info = await pngInfo(page, await onlyFile(worker), [
      [x, device(20)],
      ...bandColors.map((_color, band): [number, number] => [x, device(40 + band * 400 + 200)]),
      [x, device(height - 50)],
    ]);
    expect({ width: info.width, height: info.height }).toEqual({
      width: device(width),
      height: device(height),
    });
    expect(info.colors).toEqual(['#123456', ...bandColors, '#654321']);
    expect(await page.evaluate(() => document.getElementById('box')?.scrollTop)).toBe(1500);
  });

  for (const [file, reason, what] of [
    ['capture-small-box.html', strings.partial['no-box'], '스크롤되는 상자가 화면 대부분이 아니면'],
    [
      'capture-box-fixed.html',
      strings.partial['box-stuck'],
      '스크롤 상자가 늘려도 펼쳐지지 않으면',
    ],
  ] as const) {
    test(`PAGE-1.13 ${what} 보이는 화면을 찍고 그 까닭을 알린다`, async ({
      context,
      extensionId,
    }) => {
      const { worker, page, tabId } = await setup(context, file);
      // 보이는 화면의 높이는 찍는 동안 바뀐다: 디버거를 붙이면 Chrome이 디버깅 안내 막대를 띄워 화면이 그만큼 낮아진다(2026-10-21
      // 실험: 706px → 650px. 떼고도 몇 초 남는다). 그래서 찍기 전과 찍는 동안의 높이를 모두 모아 그중 하나와 같은지 본다. 높이는
      // 정수로 반올림하지 않은 보이는 화면의 크기다(visualViewport. innerHeight 650이 649.6이었다).
      const width = await page.evaluate(() => {
        const view = visualViewport;
        if (view === null) throw new Error('visualViewport가 없다.');
        const heights = [view.height];
        Reflect.set(window, '__heights', heights);
        view.addEventListener('resize', () => heights.push(view.height));
        return view.width;
      });
      await run(context, extensionId, page, '전체 캡처');
      const record = await finished(worker, tabId);
      expect(record).toMatchObject({ status: 'succeeded' });
      expect(summaryOf(record)).toContain(reason);
      const heights = await page.evaluate((): unknown => Reflect.get(window, '__heights'));
      const info = await pngInfo(page, await onlyFile(worker), []);
      expect(info.width).toBe(device(width));
      expect(
        Array.isArray(heights) ? heights.map((height) => device(Number(height))) : [],
      ).toContain(info.height);
    });
  }

  test('PAGE-1.4 한도보다 큰 페이지는 시작 전에 페이지 크기와 한도를 알리고 파일이 생기지 않는다', async ({
    context,
    extensionId,
  }) => {
    const { worker, page, tabId } = await setup(context, 'capture-huge.html');
    await run(context, extensionId, page, '전체 캡처');
    const record = await finished(worker, tabId);
    expect(record).toMatchObject({ status: 'failed', error: { kind: 'limit' } });
    expect(messageOf(record)).toMatch(
      /^페이지가 너무 크다\(가로 [\d,]+ × 세로 87,500 화소\)\. 한 변 65,535화소, 넓이 268,435,456화소까지 찍을 수 있다\.$/,
    );
    expect(await savedFiles(worker)).toEqual([]);
    expect(await debuggerAttached(worker, tabId)).toBe(false);
  });

  test('PAGE-1.5 찍는 동안 페이지를 이동하면 파일이 생기지 않고 클립보드가 바뀌지 않으며, 팝업에 그 까닭이 보이고 디버거가 떨어진다', async ({
    context,
    extensionId,
  }) => {
    const { worker, page, tabId } = await setup(context, 'capture-stuck.html');
    await writeClipboardText(page, '캡처 전');
    const popup = await startCapture(context, extensionId, page, '전체 캡처');
    const status = popup.locator('.task');
    await expect(status).toHaveText('전체 캡처: 진행 중이다.');
    // 끝나지 않는 이미지를 기다리는 동안 다른 페이지로 간다.
    await page.waitForTimeout(1000);
    await page.goto(`${fixtureOrigin}/blank.html`);
    await expect(status).toHaveText(`전체 캡처: 실패했다. ${strings.pageChanged}`);
    expect(await savedFiles(worker)).toEqual([]);
    expect(await clipboardText(page)).toBe('캡처 전');
    expect(await debuggerAttached(worker, tabId)).toBe(false);
  });
});

test('PAGE-1.8 Chrome 내부 화면, 빈 탭, 내 컴퓨터의 파일에서 팝업을 열면 두 단추가 막혀 있고 쓸 수 없는 이유가 보인다', async ({
  context,
  extensionId,
}) => {
  const fileUrl = pathToFileURL(path.resolve(import.meta.dirname, '..', 'fixtures', 'blank.html'));
  for (const url of ['chrome://version/', 'about:blank', fileUrl.href]) {
    const page = await context.newPage();
    await page.goto(url);
    const popup = await openPopupOn(context, extensionId, page);
    await popup.getByRole('tab', { name: '페이지' }).click();
    for (const name of ['전체 캡처', '영역 캡처']) {
      await expect(popup.getByRole('button', { name, exact: true })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    }
    await expect(popup.locator('#feature-unavailable-page-capture')).toHaveText(
      '쓸 수 없음: 확장이 이 페이지에 접근할 수 없음',
    );
    await popup.close();
    await page.close();
  }
});

test.describe('영역 캡처', () => {
  // 디버거 없이 보이는 화면을 찍으려면 그 탭에 activeTab이 있어야 한다. 실제 팝업을 열어 받는다(grantActiveTab).
  test.use({ browserDebugging: true });

  // 그 페이지에서 영역 캡처를 시작하고 팝업을 닫는다(사용자가 페이지를 누르면 팝업이 닫힌다). 고르는 화면이 뜰 때까지 기다린다.
  async function startArea(
    context: BrowserContext,
    extensionId: string,
    profileDirectory: string,
    page: Page,
  ) {
    await grantActiveTab(profileDirectory, extensionId, page);
    await run(context, extensionId, page, '영역 캡처');
    await page.bringToFront();
    await expect(page.locator(selectionHost)).toHaveCount(1);
  }

  const bodyOf = (page: Page) => page.evaluate(() => document.body.outerHTML);

  test('PAGE-1.3 PAGE-1.14 PAGE-1.18 PAGE-1.20 보이는 화면 안에서 끌어 고르면 디버거 없이 그 영역만 저장하고 HTML 없이 그림만 복사하며, 페이지 위에 결과가 보이며 고르는 화면은 남지 않는다', async ({
    context,
    extensionId,
    profileDirectory,
  }) => {
    const { worker, page, tabId } = await setup(context, 'capture-markers.html');
    await page.evaluate(() => {
      window.scrollTo(0, 1000);
    });
    const before = await bodyOf(page);
    const attaches = await countAttaches(worker);
    await startArea(context, extensionId, profileDirectory, page);
    await page.mouse.move(100, 100);
    await page.mouse.down();
    await page.mouse.move(250, 200, { steps: 4 });
    await page.mouse.move(400, 300, { steps: 4 });
    await page.mouse.up();
    const record = await finished(worker, tabId);
    expect(record).toMatchObject({ status: 'succeeded' });
    expect(summaryOf(record)).toMatch(savedPattern);
    const points: [number, number][] = [
      [device(10), device(10)],
      [device(150), device(100)],
      [device(290), device(190)],
    ];
    const info = await pngInfo(page, await onlyFile(worker), points);
    // 문서의 1100–1300px: 1000–1500px의 띠(셋째).
    expect(info).toEqual({
      width: device(300),
      height: device(200),
      colors: [bandColors[2], bandColors[2], bandColors[2]],
    });
    const copied = await clipboardPng(page);
    if (copied === null) throw new Error('클립보드에 그림이 없다.');
    expect(await pngInfo(page, copied, points)).toEqual(info);
    expect(await clipboardTypes(page)).toEqual([['image/png']]);
    await expect
      .poll(() => indicatorTexts(page))
      .toEqual([`영역 캡처: 끝났다. ${summaryOf(record)}`]);
    expect(await page.locator(selectionHost).count()).toBe(0);
    expect(await bodyOf(page)).toBe(before);
    expect(await attaches()).toBe(0);
  });

  test('PAGE-1.6 고르다 Esc를 누르면 고르는 화면이 사라지고 페이지의 DOM이 캡처 전과 같으며 파일이 생기지 않는다', async ({
    context,
    extensionId,
    profileDirectory,
  }) => {
    const { worker, page, tabId } = await setup(context, 'capture-markers.html');
    const before = await bodyOf(page);
    await startArea(context, extensionId, profileDirectory, page);
    await page.keyboard.press('Escape');
    expect(await finished(worker, tabId)).toMatchObject({
      status: 'failed',
      error: { kind: 'cancelled', message: strings.ended.escape },
    });
    expect(await page.locator(selectionHost).count()).toBe(0);
    expect(await bodyOf(page)).toBe(before);
    expect(await savedFiles(worker)).toEqual([]);
  });

  test('PAGE-1.16 고르다 오른쪽 클릭하면 PAGE-1.6과 같다', async ({
    context,
    extensionId,
    profileDirectory,
  }) => {
    const { worker, page, tabId } = await setup(context, 'capture-markers.html');
    const before = await bodyOf(page);
    await startArea(context, extensionId, profileDirectory, page);
    await page.mouse.click(200, 200, { button: 'right' });
    expect(await finished(worker, tabId)).toMatchObject({
      status: 'failed',
      error: { kind: 'cancelled', message: strings.ended['right-click'] },
    });
    expect(await page.locator(selectionHost).count()).toBe(0);
    expect(await bodyOf(page)).toBe(before);
    expect(await savedFiles(worker)).toEqual([]);
  });

  test('PAGE-1.17 너무 작게 고르면 고르는 화면이 남아 다시 고르고, 그 영역이 저장된다', async ({
    context,
    extensionId,
    profileDirectory,
  }) => {
    const { worker, page, tabId } = await setup(context, 'capture-markers.html');
    await startArea(context, extensionId, profileDirectory, page);
    await page.mouse.move(100, 100);
    await page.mouse.down();
    await page.mouse.move(105, 103);
    await page.mouse.up();
    await page.waitForTimeout(500);
    expect(await page.locator(selectionHost).count()).toBe(1);
    expect(Reflect.get(Object(await taskOf(worker, tabId)), 'status')).toBe('running');
    await page.mouse.move(100, 100);
    await page.mouse.down();
    await page.mouse.move(200, 160, { steps: 4 });
    await page.mouse.up();
    expect(await finished(worker, tabId)).toMatchObject({ status: 'succeeded' });
    expect(await pngInfo(page, await onlyFile(worker), [])).toMatchObject({
      width: device(100),
      height: device(60),
    });
  });

  test('PAGE-1.15 화면 아래 가장자리로 끌고 있으면 페이지가 저절로 스크롤되어 화면보다 큰 영역을 고르고, 디버거로 찍어 고른 영역과 같은 그림을 저장한 뒤 디버거가 떨어진다', async ({
    context,
    extensionId,
    profileDirectory,
  }) => {
    const { worker, page, tabId } = await setup(context, 'capture-markers.html');
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const attaches = await countAttaches(worker);
    await startArea(context, extensionId, profileDirectory, page);
    await page.mouse.move(200, 200);
    await page.mouse.down();
    await page.mouse.move(400, viewport.height - 2, { steps: 4 });
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(viewport.height);
    await page.mouse.up();
    const end = await page.evaluate(() => scrollY);
    expect(await finished(worker, tabId)).toMatchObject({ status: 'succeeded' });
    const height = end + viewport.height - 2 - 200;
    const info = await pngInfo(page, await onlyFile(worker), [
      [device(100), device(150)],
      [device(100), device(height - 50)],
    ]);
    expect({ width: info.width, height: info.height }).toEqual({
      width: device(200),
      height: device(height),
    });
    // 끌기 시작한 문서의 200px(첫째 띠)과 놓은 곳 바로 위(그 자리의 띠). 고정 헤더는 끌기 시작한 화면의 맨 위(0–60px)라
    // 고른 영역에 들지 않는다.
    expect(info.colors).toEqual([bandColors[0], bandColors[Math.floor((200 + height - 50) / 500)]]);
    expect(await attaches()).toBe(1);
    expect(await debuggerAttached(worker, tabId)).toBe(false);
    expect(await page.evaluate(() => scrollY)).toBe(end);
  });

  test('PAGE-1.15 안쪽 상자만 스크롤되는 페이지에서는 가장자리로 끌어도 상자가 스크롤되지 않는다', async ({
    context,
    extensionId,
    profileDirectory,
  }) => {
    const { worker, page, tabId } = await setup(context, 'capture-box.html');
    const height = await page.evaluate(() => innerHeight);
    await startArea(context, extensionId, profileDirectory, page);
    await page.mouse.move(400, 300);
    await page.mouse.down();
    await page.mouse.move(500, height - 2, { steps: 4 });
    await page.waitForTimeout(1000);
    expect(await page.evaluate(() => [scrollY, document.getElementById('box')?.scrollTop])).toEqual(
      [0, 0],
    );
    await page.mouse.up();
    expect(await finished(worker, tabId)).toMatchObject({ status: 'succeeded' });
  });

  test('PAGE-1.25 영역을 고르는 도중 확장을 다시 불러오면 고르는 화면이 페이지에서 사라진다', async ({
    context,
    extensionId,
    profileDirectory,
  }) => {
    const { page } = await setup(context, 'capture-markers.html');
    const before = await page.evaluate(() => document.body.outerHTML);
    await startArea(context, extensionId, profileDirectory, page);
    await reloadExtension(profileDirectory, extensionId);
    await expect(page.locator(selectionHost)).toHaveCount(0);
    expect(await page.evaluate(() => document.body.outerHTML)).toBe(before);
  });
});

test('PAGE-1.25 전체 캡처 도중 서비스 워커가 멈추면 파일이 생기지 않고, 다음에 깨어난 서비스 워커가 남은 디버거를 떼고 페이지의 스크롤을 되돌리며, 팝업에 그 작업이 실패로 보인다', async ({
  context,
  extensionId,
}) => {
  const { page, tabId } = await setup(context, 'capture-stuck.html');
  await page.evaluate(() => {
    window.scrollTo(0, 800);
  });
  const height = await page.evaluate(() => innerHeight);
  const popup = await startCapture(context, extensionId, page, '전체 캡처');
  await expect(popup.locator('.task')).toHaveText('전체 캡처: 진행 중이다.');
  // 끝나지 않는 이미지를 기다리는 동안(디버거를 붙이고 맨 위로 스크롤한 상태) 멈춘다.
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await popup.close();
  const workerStatus = await watchServiceWorker(await context.newPage());
  await workerStatus.stop();
  // 확장 화면을 열면 서비스 워커가 다시 시작한다. 깨어난 서비스 워커가 남은 작업을 치우고 끝낸다.
  const waker = await openPopup(context, extensionId);
  await workerStatus.reach('running');
  await waker.close();
  const restarted = await serviceWorkerOf(context);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(800);
  expect(await debuggerAttached(restarted, tabId)).toBe(false);
  // 화면 높이는 늘어나 있지 않다. 이미지를 기다리는 동안에는 늘린 높이를 이미 되돌렸고, 늘린 채 멈춘 연결은 떼면 Chrome이 그
  // 높이를 없앤다(연결 시험 PAGE-1.25와 2026-10-21 실험). 처음보다 낮을 수는 있다: 서비스 워커가 붙인 채 강제로 멈춘 뒤 다음
  // 서비스 워커가 떼면 Chrome이 그 탭의 디버깅 안내 막대를 닫지 않았다(40초 넘게. 결정 0048의 받아들인 한계).
  expect(await page.evaluate(() => innerHeight)).toBeLessThanOrEqual(height);
  const reopened = await openPopupOn(context, extensionId, page);
  await expect(reopened.locator('.task')).toHaveText(/^전체 캡처: 실패했다\. /);
  expect(await savedFiles(restarted)).toEqual([]);
});
