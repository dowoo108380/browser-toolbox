import { describe, expect, it, vi } from 'vitest';
import {
  type OffscreenRequest,
  offscreenCopyImage,
  offscreenUrl,
  storageEnsureReady,
  tabToggleSet,
  taskStart,
} from '../../src/contracts/index.ts';
import { taskParts } from '../../src/entries/generated/sw.ts';
import type { Measure, Picked, Plan } from '../../src/features/page-capture/core/capture.ts';
import { capturePath } from '../../src/features/page-capture/core/filename.ts';
import { features } from '../../src/features/list.ts';
import { createFakeStore } from '../../src/platform/fake.ts';
import type { InjectedAnswer, OffscreenRequester } from '../../src/platform/index.ts';
import { type AppError, type Result, appError, err, ok } from '../../src/shared/index.ts';
import { parseTasks, tasksKey } from '../../src/storage/index.ts';
import { type CaptureDeps, startTestBackground } from '../support/background.ts';
import { type FakeBrowser, createFakeBrowser } from '../support/fake-browser.ts';

// 캡처(PAGE-1)의 서비스 워커 쪽을 실제 모듈끼리 잇는다(quality 094, 결정 0042의 다시 볼 조건): 서비스 워커(라우터, 작업 실행, 디버거
// 관리, 탭마다 켜고 끄기, 저장·클립보드 서비스)와 두 기능의 서비스 워커 쪽(캡처, 활성 상태 유지). 이어 붙이기는 이 브라우저의
// OffscreenCanvas로 실제로 한다. 가짜는 Chrome 경계뿐이다: 저장소, 탭·창·디버거(tests/support/fake-browser.ts), 페이지에 넣은
// 스크립트의 답, 보이는 화면 찍기, 오프스크린 문서와 다운로드.

const startTime = 1_790_000_000_000;
const href = 'https://www.example.test/page';
const docSize = { width: 800, height: 3000 };
const viewport = { width: 800, height: 600 };

const documentPlan: Plan = {
  target: 'document',
  rect: { x: 0, y: 0, ...docSize },
  viewport,
  dpr: 1,
};

// 크기와 색의 PNG(base64, data URL).
async function png(width: number, height: number, color = '#3366cc'): Promise<string> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('캔버스가 없다.');
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    });
    reader.readAsDataURL(blob);
  });
}

async function sizeOf(blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

async function colorAt(blob: Blob, x: number, y: number) {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) throw new Error('캔버스가 없다.');
  context.drawImage(bitmap, 0, 0);
  const [r = 0, g = 0, b = 0] = context.getImageData(x, y, 1, 1).data;
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

interface PageScript {
  readonly plan?: Plan;
  readonly measure?: Measure;
  readonly picked?: Picked;
  // 그 일의 답한 문서(없으면 doc-1).
  readonly documentOf?: (method: string) => string;
  // 그 일의 답을 시험이 풀 때까지 붙잡는다.
  readonly hold?: string;
  // 그 일을 부를 때 그 문서가 사라져 있다(platform의 callInjected가 unavailable로 답한다).
  readonly goneAt?: string;
  // Chrome이 저장할 곳을 물어 사용자가 다른 곳을 골랐다(platform의 downloadFile이 inFolder 거짓으로 답한다).
  readonly savedElsewhere?: boolean;
}

// 페이지에 넣은 스크립트, 보이는 화면, 오프스크린 문서와 다운로드의 가짜.
function captureWorld(script: PageScript = {}) {
  const calls: string[] = [];
  const saved: { readonly path: string; readonly blob: Blob }[] = [];
  const copied: Blob[] = [];
  const blobs = new Map<string, Blob>();
  let release: () => void = () => undefined;
  const answer = (method: string): unknown => {
    switch (method) {
      case 'prepare':
        return script.plan ?? documentPlan;
      case 'measure':
        return (
          script.measure ?? { rect: { x: 0, y: 0, ...docSize }, overflow: 0, viewport, dpr: 1 }
        );
      case 'waitImages':
        return { pending: 0 };
      case 'select':
        return script.picked ?? null;
      default:
        return null;
    }
  };
  const request: OffscreenRequester = <Kind extends string, Payload, Value>(
    definition: OffscreenRequest<Kind, Payload, Value>,
    payload: Payload,
  ): Promise<Result<Value, AppError>> => {
    const value = (() => {
      if (definition.kind === offscreenUrl.kind) {
        const url = `blob:fake-${String(blobs.size)}`;
        const blob: unknown = Reflect.get(Object(payload), 'blob');
        if (blob instanceof Blob) blobs.set(url, blob);
        return { url };
      }
      if (definition.kind === offscreenCopyImage.kind) {
        const blob: unknown = Reflect.get(Object(payload), 'blob');
        if (blob instanceof Blob) copied.push(blob);
        return { copied: true };
      }
      return null;
    })();
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- 요청마다 정한 답이다.
    return Promise.resolve(ok(value as Value));
  };
  const deps: CaptureDeps = {
    injectScript: () => Promise.resolve(ok(null)),
    callInjected: async (_tabId, _key, method): Promise<Result<InjectedAnswer, AppError>> => {
      calls.push(method);
      if (script.goneAt === method) return err(appError('unavailable', '페이지가 바뀌었다.'));
      if (script.hold === method) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      const documentId = script.documentOf?.(method) ?? 'doc-1';
      return ok({ documentId, href, value: answer(method) });
    },
    captureVisibleTab: async () => ok(await png(1200, 900, '#00ff00')),
    openOffscreen: () => Promise.resolve(ok(null)),
    closeOffscreen: () => Promise.resolve(ok(null)),
    offscreenRequest: request,
    downloadFile: (url, path) => {
      const blob = blobs.get(url);
      if (blob === undefined) return Promise.resolve(err(appError('platform', '주소가 없다.')));
      saved.push({ path, blob });
      return Promise.resolve(
        ok({ name: path.slice(path.indexOf('/') + 1), inFolder: script.savedElsewhere !== true }),
      );
    },
  };
  return {
    deps,
    calls,
    saved,
    copied,
    release: () => {
      release();
    },
  };
}

// 디버거의 가짜는 Chrome과 같은 단위로 답한다(R-10, e2e/page-capture-scale이 실제 Chrome에서 본다): 페이지
// 확대(zoom, CSS 픽셀 하나가 DIP 몇 개인지)를 Page.getLayoutMetrics로 알리고, 찍기는 그 영역(DIP)에 화면 배율(scale)을 곱한
// 크기의 PNG로 답한다. 페이지가 재는 배율(devicePixelRatio)은 scale × zoom이다.
// 그림의 색은 colorOf가 영역의 위(DIP)로 정한다(조각마다 색을 달리해 이은 자리를 본다).
function answerShots(
  browser: FakeBrowser,
  {
    scale = 1,
    zoom = 1,
    colorOf = () => '#3366cc',
  }: {
    readonly scale?: number;
    readonly zoom?: number;
    readonly colorOf?: (y: number) => string;
  } = {},
) {
  browser.answerDebugger(async (_tabId, method, params) => {
    if (method === 'Page.getLayoutMetrics') return ok({ cssVisualViewport: { zoom } });
    if (method !== 'Page.captureScreenshot') return ok({});
    const clip: unknown = params['clip'];
    const width = Number(Reflect.get(Object(clip), 'width'));
    const height = Number(Reflect.get(Object(clip), 'height'));
    const color = colorOf(Number(Reflect.get(Object(clip), 'y')));
    const data = await png(Math.round(width * scale), Math.round(height * scale), color);
    return ok({ data: data.slice(data.indexOf(',') + 1) });
  });
}

async function start(
  browser: FakeBrowser,
  capture: ReturnType<typeof captureWorld>,
  session = createFakeStore(),
) {
  const popup = startTestBackground({
    store: createFakeStore(),
    features,
    startTime,
    session,
    taskParts,
    browser,
    capture: capture.deps,
  });
  await popup(storageEnsureReady, {});
  return { popup, session };
}

function taskOf(session: ReturnType<typeof createFakeStore>, tabId: number) {
  return parseTasks(session.peek(tasksKey))?.[String(tabId)] ?? null;
}

async function ended(session: ReturnType<typeof createFakeStore>, tabId: number) {
  await vi.waitFor(
    () => {
      expect(taskOf(session, tabId)?.status).not.toBe('running');
    },
    { timeout: 10_000 },
  );
  return taskOf(session, tabId);
}

describe('PAGE-1 전체 캡처의 연결', () => {
  it('PAGE-1.1 PAGE-1.19 PAGE-1.20 PAGE-1.22 PAGE-1.23 디버거를 붙여 늘렸다 되돌리고 찍어 이은 그림을 저장·복사하고, 끝나면 뗀다', async () => {
    const browser = createFakeBrowser();
    browser.open({ id: 1, active: true, url: href });
    answerShots(browser);
    const capture = captureWorld();
    const { popup, session } = await start(browser, capture);
    expect(await popup(taskStart, { featureId: 'page-capture', action: 'full', tabId: 1 })).toEqual(
      ok({ taskId: 'task-1' }),
    );
    const record = await ended(session, 1);
    const path = capturePath('full', startTime, 'www.example.test');
    expect(record).toMatchObject({
      status: 'succeeded',
      summary: `다운로드 폴더의 full_page_screenshots에 ${path.slice(path.indexOf('/') + 1)}로 저장했다. 클립보드에도 복사했다.`,
    });
    expect(capture.saved.map((file) => file.path)).toEqual([path]);
    const [file] = capture.saved;
    if (file === undefined) throw new Error('저장하지 않았다.');
    expect(await sizeOf(file.blob)).toEqual(docSize);
    expect(capture.copied).toEqual([file.blob]);
    expect(capture.calls).toEqual([
      'prepare',
      'settle',
      'waitImages',
      'measure',
      'restore',
      'ping',
    ]);
    // 화면 높이를 바꾸거나 찍기 전에 페이지 확대를 묻는다(디버거 명령의 길이는 DIP다).
    expect(browser.commands.map((call) => call.method)).toEqual([
      'Page.getLayoutMetrics',
      'Emulation.setDeviceMetricsOverride',
      'Emulation.clearDeviceMetricsOverride',
      'Page.getLayoutMetrics',
      'Page.captureScreenshot',
    ]);
    expect(browser.commands[1]?.params).toEqual({
      width: 0,
      height: 3000,
      deviceScaleFactor: 0,
      mobile: false,
    });
    expect(browser.attached()).toEqual([]);
  });

  it('PAGE-1.26 페이지를 확대한 탭(화면 배율 1.25, 확대 125%)에서는 화면 높이와 찍을 영역을 DIP(CSS 픽셀 × 확대)로 보내고, 조각을 페이지 배율의 자리에 이어 맨 끝까지 빈 줄이 없다', async () => {
    const browser = createFakeBrowser();
    browser.open({ id: 1, active: true, url: href });
    // 둘째 조각은 Chrome이 크기를 따로 반올림해(5,508 × 1.5625 = 8,606.25 → 8,606) 그 자리(16,381–24,988)보다 1픽셀 작다.
    answerShots(browser, {
      scale: 1.25,
      zoom: 1.25,
      colorOf: (y) => (y === 0 ? '#ff0000' : '#0000ff'),
    });
    const tall = { width: 800, height: 15_992 };
    const dpr = 1.5625;
    const capture = captureWorld({
      plan: { target: 'document', rect: { x: 0, y: 0, ...tall }, viewport, dpr },
      measure: { rect: { x: 0, y: 0, ...tall }, overflow: 0, viewport, dpr },
    });
    const { popup, session } = await start(browser, capture);
    await popup(taskStart, { featureId: 'page-capture', action: 'full', tabId: 1 });
    expect((await ended(session, 1))?.status).toBe('succeeded');
    const sent = (method: string) =>
      browser.commands.filter((call) => call.method === method).map((call) => call.params);
    expect(sent('Emulation.setDeviceMetricsOverride')).toEqual([
      { width: 0, height: 19_990, deviceScaleFactor: 0, mobile: false },
    ]);
    expect(
      sent('Page.captureScreenshot').map((params): unknown => Reflect.get(Object(params), 'clip')),
    ).toEqual([
      { x: 0, y: 0, width: 1000, height: 13_106.25, scale: 1 },
      { x: 0, y: 13_105, width: 1000, height: 6885, scale: 1 },
    ]);
    const [file] = capture.saved;
    if (file === undefined) throw new Error('저장하지 않았다.');
    expect(await sizeOf(file.blob)).toEqual({ width: 1250, height: 24_988 });
    expect(
      await Promise.all(
        [
          [10, 16_380],
          [10, 16_381],
          [10, 24_987],
          [1249, 24_987],
        ].map(([x = 0, y = 0]) => colorAt(file.blob, x, y)),
      ),
    ).toEqual(['#ff0000', '#0000ff', '#0000ff', '#0000ff']);
  }, 30_000);

  it('TAB-2.6 PAGE-1.23 결정 0042 활성 상태 유지가 붙인 연결을 함께 쓰고, 캡처가 끝나도 그 연결과 초점 흉내가 남는다', async () => {
    const browser = createFakeBrowser();
    browser.open({ id: 1, active: true, url: 'https://other.example.test/' });
    browser.open({ id: 2, url: href });
    answerShots(browser);
    const capture = captureWorld();
    const { popup, session } = await start(browser, capture);
    expect(
      await popup(tabToggleSet, { featureId: 'tab-keep-active', tabIds: [2], on: true }),
    ).toEqual(ok(null));
    await vi.waitFor(() => {
      expect(browser.attached()).toEqual([2]);
    });
    const before = browser.commands.length;
    await popup(taskStart, { featureId: 'page-capture', action: 'full', tabId: 2 });
    expect((await ended(session, 2))?.status).toBe('succeeded');
    const byCapture = browser.commands.slice(before).map((call) => call.method);
    // 캡처는 자기가 바꾼 화면 높이만 되돌리고, 활성 상태 유지의 초점 흉내는 건드리지 않는다(쓰는 쪽의 약속).
    expect(byCapture).not.toContain('Emulation.setFocusEmulationEnabled');
    expect(byCapture).toContain('Emulation.clearDeviceMetricsOverride');
    expect(browser.attached()).toEqual([2]);
    // 활성 상태 유지가 그만 쓰면(보는 탭이 됨) 그때 초점 흉내를 끄고 뗀다.
    browser.activate(2);
    await vi.waitFor(() => {
      expect(browser.attached()).toEqual([]);
    });
    expect(browser.commands.at(-1)).toMatchObject({
      method: 'Emulation.setFocusEmulationEnabled',
      params: { enabled: false },
    });
  });

  it('PAGE-1.24 찍는 동안 디버깅 안내 막대에서 취소하면 멈추고 저장하지 않으며, 페이지를 되돌린다', async () => {
    const browser = createFakeBrowser();
    browser.open({ id: 1, active: true, url: href });
    answerShots(browser);
    const capture = captureWorld({ hold: 'waitImages' });
    const { popup, session } = await start(browser, capture);
    await popup(taskStart, { featureId: 'page-capture', action: 'full', tabId: 1 });
    await vi.waitFor(() => {
      expect(capture.calls).toContain('waitImages');
    });
    browser.cancelDebugging();
    capture.release();
    expect(await ended(session, 1)).toMatchObject({
      status: 'failed',
      error: appError('cancelled', '디버깅 안내 막대에서 취소해 캡처를 멈췄다.'),
    });
    expect(capture.saved).toEqual([]);
    expect(capture.calls.at(-1)).toBe('restore');
  });

  it('PAGE-1.5 찍는 동안 그 탭이 다른 문서가 되면 저장도 복사도 하지 않는다', async () => {
    const browser = createFakeBrowser();
    browser.open({ id: 1, active: true, url: href });
    answerShots(browser);
    const capture = captureWorld({
      documentOf: (method) => (method === 'ping' ? 'doc-2' : 'doc-1'),
    });
    const { popup, session } = await start(browser, capture);
    await popup(taskStart, { featureId: 'page-capture', action: 'full', tabId: 1 });
    expect(await ended(session, 1)).toMatchObject({
      status: 'failed',
      error: appError('unavailable', '찍는 동안 페이지가 바뀌어 저장하지 않았다.'),
    });
    expect(capture.saved).toEqual([]);
    expect(capture.copied).toEqual([]);
    expect(browser.attached()).toEqual([]);
  });

  it('PAGE-1.5 이미지를 기다리는 동안 다른 페이지로 옮겨 넣은 스크립트가 사라지면 페이지가 바뀌었다고 실패하고, 저장도 복사도 하지 않는다', async () => {
    const browser = createFakeBrowser();
    browser.open({ id: 1, active: true, url: href });
    answerShots(browser);
    const capture = captureWorld({ goneAt: 'waitImages' });
    const { popup, session } = await start(browser, capture);
    await popup(taskStart, { featureId: 'page-capture', action: 'full', tabId: 1 });
    expect(await ended(session, 1)).toMatchObject({
      status: 'failed',
      error: appError('unavailable', '찍는 동안 페이지가 바뀌어 저장하지 않았다.'),
    });
    expect(capture.saved).toEqual([]);
    expect(capture.copied).toEqual([]);
    expect(browser.attached()).toEqual([]);
  });

  it('PAGE-1.7 디버거를 붙이지 못하면 그 이유로 실패하고 저장하지 않는다', async () => {
    const browser = createFakeBrowser();
    browser.open({ id: 1, active: true, url: href });
    browser.refuse(1);
    const capture = captureWorld();
    const { popup, session } = await start(browser, capture);
    await popup(taskStart, { featureId: 'page-capture', action: 'full', tabId: 1 });
    expect(await ended(session, 1)).toMatchObject({
      status: 'failed',
      error: { kind: 'permission' },
    });
    expect(capture.saved).toEqual([]);
    expect(capture.calls).toEqual([]);
  });

  it('PAGE-1.8 웹 페이지가 아닌 탭에서는 시작해도 이유와 함께 실패한다', async () => {
    const browser = createFakeBrowser();
    browser.open({ id: 1, active: true, url: 'chrome://settings/' });
    const capture = captureWorld();
    const { popup, session } = await start(browser, capture);
    await popup(taskStart, { featureId: 'page-capture', action: 'full', tabId: 1 });
    expect(await ended(session, 1)).toMatchObject({
      status: 'failed',
      error: appError('unavailable', '웹 페이지(http·https)에서만 찍을 수 있다.'),
    });
    expect(capture.calls).toEqual([]);
  });

  it('PAGE-1.21 복사 한도보다 큰 그림은 파일로만 저장하고 그 까닭을 남긴다', async () => {
    const browser = createFakeBrowser();
    browser.open({ id: 1, active: true, url: href });
    answerShots(browser, { scale: 4 });
    const big = { width: 1300, height: 2600 };
    const capture = captureWorld({
      plan: { target: 'document', rect: { x: 0, y: 0, ...big }, viewport, dpr: 4 },
      measure: { rect: { x: 0, y: 0, ...big }, overflow: 0, viewport, dpr: 4 },
    });
    const { popup, session } = await start(browser, capture);
    await popup(taskStart, { featureId: 'page-capture', action: 'full', tabId: 1 });
    const record = await ended(session, 1);
    expect(record?.status === 'succeeded' ? record.summary : null).toContain(
      '그림이 커서(가로 5,200 × 세로 10,400 화소) 클립보드에는 복사하지 않았다(50,000,000 화소까지 복사한다).',
    );
    expect(capture.saved).toHaveLength(1);
    expect(capture.copied).toEqual([]);
  }, 30_000);

  it('PAGE-1.19 Chrome이 저장할 곳을 물어 사용자가 다른 곳에 저장하면 결과에 다운로드 폴더라고 쓰지 않는다', async () => {
    const browser = createFakeBrowser();
    browser.open({ id: 1, active: true, url: href });
    answerShots(browser);
    const capture = captureWorld({ savedElsewhere: true });
    const { popup, session } = await start(browser, capture);
    await popup(taskStart, { featureId: 'page-capture', action: 'full', tabId: 1 });
    const path = capturePath('full', startTime, 'www.example.test');
    expect(await ended(session, 1)).toMatchObject({
      status: 'succeeded',
      summary: `고른 곳에 ${path.slice(path.indexOf('/') + 1)}로 저장했다. 클립보드에도 복사했다.`,
    });
  });
});

describe('PAGE-1 영역 캡처의 연결', () => {
  it('PAGE-1.3 PAGE-1.14 보이는 화면 안에서 고르면 디버거 없이 보이는 화면을 찍어 고른 영역만 저장한다', async () => {
    const browser = createFakeBrowser();
    browser.open({ id: 1, active: true, url: href });
    const capture = captureWorld({
      picked: {
        kind: 'picked',
        rect: { x: 100, y: 700, width: 200, height: 100 },
        view: { x: 0, y: 600, width: 800, height: 600 },
        start: { x: 0, y: 600 },
        dpr: 1.5,
      },
    });
    const { popup, session } = await start(browser, capture);
    await popup(taskStart, { featureId: 'page-capture', action: 'area', tabId: 1 });
    expect((await ended(session, 1))?.status).toBe('succeeded');
    const [file] = capture.saved;
    if (file === undefined) throw new Error('저장하지 않았다.');
    expect(file.path).toBe(capturePath('area', startTime, 'www.example.test'));
    expect(await sizeOf(file.blob)).toEqual({ width: 300, height: 150 });
    expect(await colorAt(file.blob, 150, 75)).toBe('#00ff00');
    expect(browser.commands).toEqual([]);
    expect(capture.calls).toEqual(['select', 'ping']);
  });

  it('PAGE-1.6 고르기를 끝내면 그 까닭으로 취소하고 저장하지 않는다', async () => {
    const browser = createFakeBrowser();
    browser.open({ id: 1, active: true, url: href });
    const capture = captureWorld({ picked: { kind: 'ended', reason: 'escape' } });
    const { popup, session } = await start(browser, capture);
    await popup(taskStart, { featureId: 'page-capture', action: 'area', tabId: 1 });
    expect(await ended(session, 1)).toMatchObject({
      status: 'failed',
      error: appError('cancelled', 'Esc를 눌러 영역 고르기를 멈췄다.'),
    });
    expect(capture.saved).toEqual([]);
  });

  it('PAGE-1.5 고르는 동안 그 문서가 사라지면(다른 문서로 떠남) "찍는 동안 페이지가 바뀜"이 아니라 페이지를 떠나 취소한 것으로 끝내고, 사라진 문서를 되돌리지 않는다', async () => {
    const browser = createFakeBrowser();
    browser.open({ id: 1, active: true, url: href });
    const capture = captureWorld({ goneAt: 'select' });
    const { popup, session } = await start(browser, capture);
    await popup(taskStart, { featureId: 'page-capture', action: 'area', tabId: 1 });
    expect(await ended(session, 1)).toMatchObject({
      status: 'failed',
      error: appError('cancelled', '페이지를 떠나 영역 고르기를 멈췄다.'),
    });
    expect(capture.saved).toEqual([]);
    expect(capture.copied).toEqual([]);
    expect(capture.calls).toEqual(['select']);
  });
});

describe('PAGE-1.25 결정 0038 서비스 워커가 찍는 도중 멈춤', () => {
  it('다음 서비스 워커가 시작할 때 남은 연결을 떼고(늘린 화면 높이도 함께 없어진다) 페이지를 되돌린 뒤 작업을 실패로 끝낸다', async () => {
    const browser = createFakeBrowser();
    browser.open({ id: 1, active: true, url: href });
    // 앞 서비스 워커가 붙인 연결이 남았다.
    await browser.deps.attachDebugger(1);
    const session = createFakeStore({
      [tasksKey]: {
        '1': { id: 'old', featureId: 'page-capture', action: 'full', status: 'running' },
      },
    });
    const capture = captureWorld();
    await start(browser, capture, session);
    expect(await ended(session, 1)).toMatchObject({
      status: 'failed',
      error: { kind: 'unexpected' },
    });
    expect(browser.attached()).toEqual([]);
    expect(capture.calls).toEqual(['restore']);
  });
});
