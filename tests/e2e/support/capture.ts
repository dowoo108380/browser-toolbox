import { readFileSync } from 'node:fs';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { connectBrowserCdp } from './browser-cdp.ts';
import { expect, openPopupOn } from './extension.ts';

// 캡처(PAGE-1)의 확장 전체 시험 도우미. 팝업 문서를 탭으로 열어(openPopupOn) 단추를 누르고, 서비스 워커의 작업 기록으로 끝을
// 기다린다. 저장한 파일은 다운로드 기록의 경로에서 읽는다(Playwright가 다운로드를 맡아 이름은 Chrome이 정한 것이 아니다, R-11.
// 실제 이름과 폴더는 page-capture-raw.spec.ts가 본다). 그림은 페이지에서 풀어 크기와 점의 색을 읽는다.

// capture-markers.html의 띠 색(500px마다)과 capture-box.html의 띠 색(400px마다). 시험 페이지와 같은 차례다.
export const bandColors = [
  '#e6194b',
  '#3cb44b',
  '#ffe119',
  '#4363d8',
  '#f58231',
  '#911eb4',
  '#42d4f4',
  '#f032e6',
  '#bfef45',
  '#fabed4',
  '#469990',
  '#dcbeff',
] as const;

export type CaptureButton = '전체 캡처' | '영역 캡처';

// page를 지금 탭으로 둔 팝업에서 그 단추를 누른다. 팝업을 돌려준다(닫으면 팝업을 닫은 것과 같다).
export async function startCapture(
  context: BrowserContext,
  extensionId: string,
  page: Page,
  button: CaptureButton,
): Promise<Page> {
  const popup = await openPopupOn(context, extensionId, page);
  await popup.getByRole('tab', { name: '페이지' }).click();
  const run = popup.getByRole('button', { name: button, exact: true });
  await expect(run).not.toHaveAttribute('aria-disabled', 'true');
  await run.click();
  return popup;
}

// 사이트의 스크립트 지연 로딩을 모든 페이지에 넣는다(capture-lazy.html의 img.late): 화면에 들어오면 data-src를 src로 단다.
// 페이지의 스크롤도 기록한다(window.__scrolls).
export async function addScriptLazyLoading(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const scrolls: number[] = [];
    Reflect.set(window, '__scrolls', scrolls);
    addEventListener('scroll', () => scrolls.push(scrollY));
    addEventListener('DOMContentLoaded', () => {
      const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting || !(entry.target instanceof HTMLImageElement)) continue;
          entry.target.src = entry.target.dataset['src'] ?? '';
          observer.unobserve(entry.target);
        }
      });
      for (const image of document.querySelectorAll('img.late')) observer.observe(image);
    });
  });
}

// 그 탭의 작업 기록(없으면 null).
export function taskOf(worker: Worker, tabId: number): Promise<unknown> {
  return worker.evaluate(async (id) => {
    const { tasks }: Record<string, unknown> = await chrome.storage.session.get('tasks');
    if (typeof tasks !== 'object' || tasks === null) return null;
    const record: unknown = Reflect.get(tasks, String(id));
    return record ?? null;
  }, tabId);
}

// 그 탭의 작업이 끝날 때까지 기다리고 그 기록을 준다.
export async function finished(worker: Worker, tabId: number, timeout = 30_000) {
  await expect
    .poll(
      async (): Promise<unknown> => Reflect.get(Object(await taskOf(worker, tabId)), 'status'),
      {
        timeout,
      },
    )
    .toMatch(/^(succeeded|failed)$/);
  return taskOf(worker, tabId);
}

// 끝난 다운로드의 파일(내용).
export async function savedFiles(worker: Worker): Promise<Buffer[]> {
  const files = await worker.evaluate(async () =>
    (await chrome.downloads.search({ state: 'complete' })).map((item) => item.filename),
  );
  return files.map((file) => readFileSync(file));
}

// 그 PNG를 페이지에서 풀어 크기와 점들(기기 픽셀)의 색을 준다.
export function pngInfo(page: Page, png: Buffer, points: readonly (readonly [number, number])[]) {
  return page.evaluate(
    async ({ base64, at }) => {
      const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (context === null) throw new Error('캔버스가 없다.');
      context.drawImage(bitmap, 0, 0);
      const colors = at.map(([x, y]) => {
        const [r = 0, g = 0, b = 0] = context.getImageData(x, y, 1, 1).data;
        return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
      });
      return { width: bitmap.width, height: bitmap.height, colors };
    },
    { base64: png.toString('base64'), at: points },
  );
}

// capture-tiles.html에 200 CSS 픽셀마다 색이 다른 띠(bandColors를 되풀이)를 height만큼 넣는다. width가 있으면 띠가 그
// 너비다(없으면 창 너비). box가 있으면 띠는 화면 높이의 스크롤 상자 안에 있고 문서는 스크롤되지 않는다(안쪽 상자를 펼쳐 찍는 길).
// box가 'fixed'면 상자의 높이를 지금 화면 높이(px)로 정해 늘려도 펼쳐지지 않는다(보이는 화면만 찍는 길).
export function drawBands(
  page: Page,
  options: { readonly height: number; readonly width?: number; readonly box?: 'grows' | 'fixed' },
): Promise<void> {
  return page.evaluate(
    ({ height, width, box, colors }) => {
      let parent = document.body;
      if (box !== undefined) {
        document.documentElement.classList.add('boxed');
        parent = document.createElement('div');
        parent.id = 'box';
        if (box === 'fixed') parent.style.height = `${String(innerHeight)}px`;
        document.body.append(parent);
      }
      for (let band = 0; band * 200 < height; band += 1) {
        const div = document.createElement('div');
        div.className = 'band';
        div.style.background = colors[band % colors.length] ?? '';
        // 마지막 띠는 남은 높이만큼이다(내용의 높이가 height다).
        div.style.height = `${String(Math.min(200, height - band * 200))}px`;
        if (width !== undefined) div.style.width = `${String(width)}px`;
        parent.append(div);
      }
    },
    { ...options, colors: bandColors },
  );
}

// 그 탭의 페이지 확대를 정하고(Chrome이 사이트마다 기억하는 확대와 같다) 페이지가 그 배율이 되기를 기다린다.
export async function setPageZoom(
  worker: Worker,
  page: Page,
  tabId: number,
  zoom: number,
  dpr: number,
): Promise<void> {
  await worker.evaluate(({ id, factor }) => chrome.tabs.setZoom(id, factor), {
    id: tabId,
    factor: zoom,
  });
  await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBe(dpr);
}

// 그 PNG의 세로 줄들(기기 픽셀 x)을 위에서 아래까지 모두 읽어, drawBands의 띠(200 CSS 픽셀마다 bandColors를 되풀이)와
// 색이 다른 곳을 이어진 구간(기기 픽셀 from–to, 그 처음의 색과 불투명도)으로 준다. top은 그림의 맨 위가 문서에서 몇
// CSS 픽셀인지, end는 띠가 끝나는 곳(문서의 CSS 픽셀)이다. 띠의 경계와 끝의 둘레(1.5 기기 픽셀)는 반올림에 따라 어느 쪽
// 색이어도 되므로 보지 않는다. 그 밖의 모든 줄을 보므로 조각 사이나 맨 아래의 빈 띠(그리지 않은 자리)와 어긋나게 놓인 조각을
// 놓치지 않는다.
export function stripeGaps(
  page: Page,
  png: Buffer,
  {
    dpr,
    top,
    end,
    xs,
  }: {
    readonly dpr: number;
    readonly top: number;
    readonly end: number;
    readonly xs: readonly number[];
  },
) {
  return page.evaluate(
    async ({ base64, scale, offset, last, columns, colors }) => {
      const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (context === null) throw new Error('캔버스가 없다.');
      context.drawImage(bitmap, 0, 0);
      const hex = (data: Uint8ClampedArray, at: number) =>
        `#${[0, 1, 2]
          .map((part) => (data[at + part] ?? 0).toString(16).padStart(2, '0'))
          .join('')}`;
      const gaps: { x: number; from: number; to: number; color: string; alpha: number }[] = [];
      for (const x of columns) {
        const { data } = context.getImageData(x, 0, 1, bitmap.height);
        let open: (typeof gaps)[number] | null = null;
        for (let row = 0; row < bitmap.height; row += 1) {
          const css = (row + 0.5) / scale + offset;
          const nearest = Math.round(css / 200) * 200;
          if (Math.abs(css - nearest) < 1.5 / scale || css > last - 1.5 / scale) continue;
          const expected = colors[Math.floor(css / 200) % colors.length];
          const color = hex(data, row * 4);
          const alpha = data[row * 4 + 3] ?? 0;
          if (color === expected && alpha === 255) {
            open = null;
            continue;
          }
          if (open === null) {
            open = { x, from: row, to: row, color, alpha };
            gaps.push(open);
          } else {
            open.to = row;
          }
        }
      }
      return { width: bitmap.width, height: bitmap.height, gaps };
    },
    {
      base64: png.toString('base64'),
      scale: dpr,
      offset: top,
      last: end,
      columns: xs,
      colors: bandColors,
    },
  );
}

// 클립보드의 그림(PNG). 5초 안에 그림이 오지 않으면 null이다. 확장은 복사를 맡긴 뒤 곧 답하고 브라우저가 그 쓰기를 따로 끝낸다
// (결정 0047). 화면 없는 Chromium의 클립보드는 그 브라우저 안의 것이다(사용자의 클립보드를 건드리지 않는다, Chromium
// chrome_browser_main_extra_parts_headless.cc). 읽는 페이지의 출처에 읽기 권한을 준다.
export async function clipboardPng(page: Page): Promise<Buffer | null> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(page.url()).origin,
  });
  const read = () =>
    page.evaluate(async () => {
      for (const item of await navigator.clipboard.read()) {
        if (!item.types.includes('image/png')) continue;
        const bytes = new Uint8Array(await (await item.getType('image/png')).arrayBuffer());
        let text = '';
        for (const byte of bytes) text += String.fromCharCode(byte);
        return btoa(text);
      }
      return null;
    });
  for (const started = Date.now(); Date.now() - started < 5000;) {
    const base64 = await read();
    if (base64 !== null) return Buffer.from(base64, 'base64');
    await page.waitForTimeout(100);
  }
  return null;
}

// 클립보드의 항목마다 그 형식들. 캡처는 그림(image/png) 하나만 넣는다: HTML(text/html)이 함께 있으면 HTML을 먼저 받는
// 프로그램(Word 등)이 그림 대신 HTML을 붙인다(결정 0049).
export async function clipboardTypes(page: Page): Promise<string[][]> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(page.url()).origin,
  });
  return page.evaluate(async () =>
    (await navigator.clipboard.read()).map((item) => [...item.types].sort()),
  );
}

// 클립보드에 글을 쓴다(캡처가 클립보드를 바꾸지 않았는지 보려고 먼저 둔다).
export async function writeClipboardText(page: Page, text: string): Promise<void> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(page.url()).origin,
  });
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
}

export function clipboardText(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

// 사용자가 그 탭에서 확장 아이콘을 누른 것처럼 실제 팝업을 열어 그 탭에 activeTab을 받은 뒤 팝업을 닫는다. 디버거 없이 보이는
// 화면을 찍는 데 필요하다(결정 0048). 브라우저 수준 CDP의 Extensions.triggerAction은 탭 대상(type tab)에만 된다(2026-10-21
// 실험). browserDebugging으로 띄운 브라우저에서만 된다.
export async function grantActiveTab(
  profileDirectory: string,
  extensionId: string,
  page: Page,
): Promise<void> {
  const cdp = await connectBrowserCdp(profileDirectory);
  const infos = async (filter?: readonly { readonly type: string }[]) => {
    const result = await cdp.send('Target.getTargets', filter === undefined ? {} : { filter });
    const list: unknown = Reflect.get(Object(result), 'targetInfos');
    return Array.isArray(list)
      ? list.map((info: unknown) => ({
          targetId: String(Reflect.get(Object(info), 'targetId')),
          type: String(Reflect.get(Object(info), 'type')),
          url: String(Reflect.get(Object(info), 'url')),
        }))
      : [];
  };
  try {
    const tab = (await infos([{ type: 'tab' }])).find((info) => info.url === page.url());
    if (tab === undefined) throw new Error('그 페이지의 탭 대상이 없다.');
    await cdp.send('Extensions.triggerAction', { id: extensionId, targetId: tab.targetId });
    const popupUrl = `chrome-extension://${extensionId}/popup.html`;
    await expect
      .poll(async () =>
        (await infos()).some((info) => info.type === 'page' && info.url === popupUrl),
      )
      .toBe(true);
    for (const info of await infos()) {
      if (info.type === 'page' && info.url === popupUrl) {
        await cdp.send('Target.closeTarget', { targetId: info.targetId });
      }
    }
  } finally {
    cdp.close();
  }
}

// 서비스 워커가 디버거로 찍는 조각을 적는다(그 뒤의 Page.captureScreenshot마다 요청한 영역과 Chrome이 준 그림의 크기). 그림의
// 크기는 PNG의 머리(IHDR)에서 읽는다. 조각이 페이지의 배율대로 그려졌는지(늘린 그림이 아닌지) 보려고 쓴다.
export async function recordShots(worker: Worker): Promise<
  () => Promise<
    {
      readonly clip: { readonly width: number; readonly height: number };
      readonly width: number;
      readonly height: number;
    }[]
  >
> {
  await worker.evaluate(() => {
    const original = chrome.debugger.sendCommand.bind(chrome.debugger);
    const shots: unknown[] = [];
    Reflect.set(globalThis, '__shots', shots);
    const wrapped = async (
      target: chrome.debugger.DebuggerSession,
      method: string,
      params?: Record<string, unknown>,
    ) => {
      const result: unknown = await original(target, method, params);
      if (method === 'Page.captureScreenshot') {
        const head = atob(String(Reflect.get(Object(result), 'data')).slice(0, 32));
        const word = (at: number) =>
          [0, 1, 2, 3].reduce((value, part) => value * 256 + head.charCodeAt(at + part), 0);
        shots.push({ clip: params?.['clip'], width: word(16), height: word(20) });
      }
      return result;
    };
    Reflect.set(chrome.debugger, 'sendCommand', wrapped);
  });
  return () =>
    worker.evaluate(() => {
      const shots: unknown = Reflect.get(globalThis, '__shots');
      return Array.isArray(shots)
        ? shots.map((shot: unknown) => {
            const clip: unknown = Reflect.get(Object(shot), 'clip');
            return {
              clip: {
                width: Number(Reflect.get(Object(clip), 'width')),
                height: Number(Reflect.get(Object(clip), 'height')),
              },
              width: Number(Reflect.get(Object(shot), 'width')),
              height: Number(Reflect.get(Object(shot), 'height')),
            };
          })
        : [];
    });
}

// 서비스 워커의 디버거 붙이기를 센다(그 뒤의 chrome.debugger.attach 호출 수). 확장의 platform이 부를 때마다 이 전역을 읽는다.
export async function countAttaches(worker: Worker): Promise<() => Promise<number>> {
  await worker.evaluate(() => {
    const original = chrome.debugger.attach.bind(chrome.debugger);
    Reflect.set(globalThis, '__attaches', 0);
    chrome.debugger.attach = (target, version) => {
      Reflect.set(globalThis, '__attaches', Number(Reflect.get(globalThis, '__attaches')) + 1);
      return original(target, version);
    };
  });
  return () => worker.evaluate(() => Number(Reflect.get(globalThis, '__attaches')));
}

// 그 탭에 이 확장의 디버거가 붙어 있는지. 대상의 attached는 Playwright의 연결도 세므로 쓰지 않고, 이 확장의 연결로 명령을
// 보내 본다(붙어 있지 않으면 Chrome이 거절한다). 페이지를 바꾸지 않는 명령이다.
export function debuggerAttached(worker: Worker, tabId: number): Promise<boolean> {
  return worker.evaluate(async (id) => {
    try {
      await chrome.debugger.sendCommand({ tabId: id }, 'Runtime.evaluate', { expression: '1' });
      return true;
    } catch {
      return false;
    }
  }, tabId);
}
