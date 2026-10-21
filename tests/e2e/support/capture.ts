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
