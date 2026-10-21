import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cdp } from 'vitest/browser';
import { injectedApiKey, retireEventName } from '../../src/contracts/index.ts';
import type { PageApi } from '../../src/features/page-capture/api.ts';
import type { Picked } from '../../src/features/page-capture/core/capture.ts';
import { pageCapture } from '../../src/features/page-capture/feature.ts';
import { installPageApi } from '../../src/features/page-capture/inject.ts';

// 캡처의 페이지 쪽(PAGE-1, 결정 0046, 0048, src/features/page-capture/inject.ts). 실제 Chromium에서 문서와 안쪽 상자를 꾸미고 일을
// 부른다. 영역 고르기는 CDP의 진짜 마우스와 키 입력으로 한다(고르는 화면은 웹 페이지가 만든 이벤트를 받지 않는다). CDP는
// Playwright 공급자의 타입이 필요해 Node 타입이 있는 이 폴더에 둔다. 시험의 창은 414×896이다.

const selector = 'browser-toolbox-ui[data-browser-toolbox="page-capture-selection"]';

function api(): PageApi {
  installPageApi();
  const found: unknown = Reflect.get(globalThis, Symbol.for(injectedApiKey(pageCapture.id)));
  if (typeof found !== 'object' || found === null) throw new Error('일이 없다.');
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- installPageApi가 둔 그 일이다.
  return found as PageApi;
}

const page = () => api();

// 시험의 iframe 안 좌표로 진짜 입력을 보낸다(iframe은 왼쪽 위에 배율 1로 놓인다).
const input = () => cdp();
const mouse = async (
  type: 'mousePressed' | 'mouseMoved' | 'mouseReleased',
  x: number,
  y: number,
  button: 'left' | 'right' = 'left',
) => {
  await input().send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: type === 'mouseMoved' ? 'none' : button,
    buttons: type === 'mouseReleased' ? 0 : button === 'left' ? 1 : 2,
    clickCount: type === 'mouseMoved' ? 0 : 1,
  });
};
const drag = async (from: [number, number], to: [number, number]) => {
  await mouse('mousePressed', ...from);
  await mouse('mouseMoved', (from[0] + to[0]) / 2, (from[1] + to[1]) / 2);
  await mouse('mouseMoved', ...to);
  await mouse('mouseReleased', ...to);
};

// 고르기가 아직 끝나지 않았는지 본다.
async function pending(promise: Promise<Picked>): Promise<boolean> {
  const marker = Symbol('pending');
  const settled = await Promise.race([
    promise,
    new Promise<symbol>((resolve) => {
      setTimeout(() => {
        resolve(marker);
      }, 150);
    }),
  ]);
  return settled === marker;
}

const content = document.createElement('div');

beforeEach(() => {
  vi.stubGlobal('chrome', { runtime: { id: 'abcdefghijklmnopabcdefghijklmnop' } });
  document.body.style.margin = '0';
  document.body.append(content);
});

afterEach(() => {
  page().restore();
  content.replaceChildren();
  content.removeAttribute('style');
  content.remove();
  document.documentElement.removeAttribute('style');
  document.body.removeAttribute('style');
  for (const style of document.querySelectorAll('style[data-test]')) style.remove();
  window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
  vi.unstubAllGlobals();
});

function tallDocument(height: number) {
  content.style.height = `${String(height)}px`;
}

// 대화 화면을 본뜬 앱 틀(위 머리 60px, 옆 목록 100px, 나머지가 스크롤 상자). 상자 안의 내용 높이는 contentHeight다.
function appShell(contentHeight: number) {
  document.documentElement.style.cssText = 'height:100%;overflow:hidden';
  document.body.style.cssText = 'margin:0;height:100%;overflow:hidden';
  content.style.cssText = 'display:flex;flex-direction:column;height:100vh';
  const top = document.createElement('div');
  top.style.cssText = 'height:60px;flex:none';
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;flex:1;min-height:0';
  const side = document.createElement('div');
  side.style.cssText = 'width:100px;flex:none';
  const box = document.createElement('div');
  box.style.cssText = 'flex:1;overflow-y:auto;min-height:0';
  const inner = document.createElement('div');
  inner.style.height = `${String(contentHeight)}px`;
  box.append(inner);
  row.append(side, box);
  content.append(top, row);
  return box;
}

describe('PAGE-1 전체 캡처의 대상(prepare)', () => {
  it('PAGE-1.9 문서가 스크롤되면 문서 전체이고, 맨 위로 옮겼다가 되돌리면 원래 스크롤 자리다', () => {
    tallDocument(3000);
    window.scrollTo({ left: 0, top: 1200, behavior: 'instant' });
    const plan = page().prepare();
    expect(plan).toEqual({
      target: 'document',
      rect: { x: 0, y: 0, width: document.documentElement.clientWidth, height: 3000 },
      viewport: { width: innerWidth, height: innerHeight },
      dpr: devicePixelRatio,
    });
    expect(scrollY).toBe(0);
    page().restore();
    expect(scrollY).toBe(1200);
  });

  it('PAGE-1.12 문서는 스크롤되지 않고 화면 대부분인 상자가 스크롤되면 그 상자이고, 되돌리면 상자의 스크롤 자리가 돌아온다', () => {
    const box = appShell(5000);
    box.scrollTop = 1000;
    const plan = page().prepare();
    const rect = box.getBoundingClientRect();
    expect(plan).toEqual({
      target: 'box',
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      overflow: 5000 - box.clientHeight,
      viewport: { width: innerWidth, height: innerHeight },
      dpr: devicePixelRatio,
    });
    expect(page().measure('box')).toMatchObject({ overflow: 5000 - box.clientHeight });
    // 화면 높이를 늘리면 상자가 스크롤되지 않아 스크롤 자리를 잃는다. 되돌리면 돌아온다.
    box.scrollTop = 0;
    page().restore();
    expect(box.scrollTop).toBe(1000);
  });

  it('PAGE-1.13 스크롤되는 상자가 화면 대부분이 아니면 보이는 화면이다', () => {
    appShell(400);
    const small = document.createElement('div');
    small.style.cssText = 'position:fixed;left:0;top:0;width:150px;height:150px;overflow:auto';
    const inner = document.createElement('div');
    inner.style.height = '2000px';
    small.append(inner);
    content.append(small);
    expect(page().prepare()).toEqual({ target: 'viewport' });
  });

  it('아무것도 스크롤되지 않으면 화면에 다 있는 문서다', () => {
    tallDocument(100);
    expect(page().prepare()).toMatchObject({
      target: 'document',
      rect: { x: 0, y: 0, height: innerHeight },
    });
  });

  it('html이 넘친 것을 감추면 문서가 길어도 문서를 스크롤할 수 없는 것으로 본다', () => {
    tallDocument(3000);
    document.documentElement.style.overflow = 'hidden';
    expect(page().prepare()).not.toMatchObject({ target: 'document' });
  });

  it('보이는 화면은 지금 스크롤 자리에서 스크롤 막대를 뺀 크기다(소수를 반올림하지 않는 visualViewport)', () => {
    tallDocument(3000);
    window.scrollTo({ left: 0, top: 500, behavior: 'instant' });
    expect(page().measure('viewport').rect).toEqual({
      x: 0,
      y: 500,
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    });
    expect(page().measure('viewport').rect).toEqual({
      x: visualViewport?.pageLeft,
      y: visualViewport?.pageTop,
      width: visualViewport?.width,
      height: visualViewport?.height,
    });
  });

  it('고른 상자가 없으면 상자를 재지 못한다', () => {
    expect(() => page().measure('box')).toThrow();
  });

  it('스크롤 자리로 옮겼다가 되돌린다', () => {
    tallDocument(3000);
    window.scrollTo({ left: 0, top: 300, behavior: 'instant' });
    page().position({ x: 0, y: 1500 });
    expect(scrollY).toBe(1500);
    page().restore();
    expect(scrollY).toBe(300);
    // 바꾼 것이 없으면 할 일이 없다.
    page().restore();
    expect(scrollY).toBe(300);
  });
});

describe('PAGE-1.10 PAGE-1.11 이미지 기다리기', () => {
  // 화면에서 먼 곳의 지연 로딩 이미지는 브라우저가 부르기 전이라 다 불러오지 않은 것이다.
  function farLazyImage(top: number) {
    const image = document.createElement('img');
    image.loading = 'lazy';
    image.width = 50;
    image.height = 50;
    image.src = `${location.origin}/never-${String(top)}.png`;
    image.style.cssText = `position:absolute;left:0;top:${String(top)}px`;
    content.append(image);
    return image;
  }

  it('그려질 이미지가 다 불렸으면 곧 끝낸다', async () => {
    const started = performance.now();
    expect(await page().waitImages(null, 2000)).toEqual({ pending: 0 });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('다 불리지 않은 이미지가 있으면 한도까지 기다리고 그 수를 준다', async () => {
    tallDocument(20_000);
    farLazyImage(15_000);
    const started = performance.now();
    expect(await page().waitImages(null, 300)).toEqual({ pending: 1 });
    expect(performance.now() - started).toBeGreaterThanOrEqual(290);
  });

  it('영역 밖의 이미지와 그려지지 않는 이미지는 기다리지 않는다', async () => {
    tallDocument(20_000);
    farLazyImage(15_000);
    farLazyImage(16_000).style.display = 'none';
    expect(await page().waitImages({ x: 0, y: 0, width: 300, height: 300 }, 2000)).toEqual({
      pending: 0,
    });
  });

  it('화면을 두 번 그리기를 기다린다', async () => {
    expect(await page().settle()).toBeNull();
  });
});

describe('PAGE-1 영역 고르기(select)', () => {
  it('PAGE-1.3 PAGE-1.18 끌어서 고른 네모를 문서 좌표로 주고, 고르는 화면은 남지 않는다', async () => {
    tallDocument(3000);
    window.scrollTo({ left: 0, top: 200, behavior: 'instant' });
    const before = document.body.innerHTML;
    const choosing = page().select();
    const host = document.querySelector(selector);
    expect(host?.matches(':popover-open')).toBe(true);
    // 닫힌 shadow root라 페이지는 안을 볼 수 없다.
    expect(host?.shadowRoot).toBeNull();
    await drag([20, 30], [220, 130]);
    expect(await choosing).toEqual({
      kind: 'picked',
      rect: { x: 20, y: 230, width: 200, height: 100 },
      view: { x: 0, y: 200, width: innerWidth, height: innerHeight },
      start: { x: 0, y: 200 },
      dpr: devicePixelRatio,
    });
    expect(document.querySelector(selector)).toBeNull();
    expect(document.body.innerHTML).toBe(before);
  });

  it('PAGE-1.6 Esc를 누르면 끝나고 고르는 화면이 사라진다', async () => {
    // 키 입력은 초점이 있는 창으로 간다. 고르는 화면을 띄우기 전에 이 창을 눌러 초점을 둔다.
    await mouse('mousePressed', 5, 5);
    await mouse('mouseReleased', 5, 5);
    const before = document.body.innerHTML;
    const choosing = page().select();
    await input().send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    });
    await input().send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    });
    expect(await choosing).toEqual({ kind: 'ended', reason: 'escape' });
    expect(document.querySelector(selector)).toBeNull();
    expect(document.body.innerHTML).toBe(before);
  });

  it('PAGE-1.16 오른쪽 클릭하면 끝나고 고르는 화면이 사라진다', async () => {
    const choosing = page().select();
    await mouse('mousePressed', 60, 60, 'right');
    await mouse('mouseReleased', 60, 60, 'right');
    expect(await choosing).toEqual({ kind: 'ended', reason: 'right-click' });
    expect(document.querySelector(selector)).toBeNull();
  });

  it('PAGE-1.17 너무 작게 고르면 끝내지 않고, 다시 끌어 고른 것을 준다', async () => {
    const choosing = page().select();
    await mouse('mousePressed', 40, 40);
    await mouse('mouseReleased', 45, 42);
    expect(await pending(choosing)).toBe(true);
    expect(document.querySelector(selector)).not.toBeNull();
    await drag([40, 40], [140, 90]);
    expect(await choosing).toMatchObject({
      kind: 'picked',
      rect: { x: 40, y: 40, width: 100, height: 50 },
    });
  });

  it('PAGE-1.15 화면 아래 가장자리로 끌고 있으면 문서가 저절로 스크롤되어 화면보다 큰 영역을 고른다', async () => {
    tallDocument(5000);
    const choosing = page().select();
    await mouse('mousePressed', 50, 100);
    await mouse('mouseMoved', 60, innerHeight - 1);
    await vi.waitFor(
      () => {
        expect(scrollY).toBeGreaterThan(innerHeight);
      },
      { timeout: 5000 },
    );
    await mouse('mouseReleased', 60, innerHeight - 1);
    const picked = await choosing;
    if (picked.kind !== 'picked') throw new Error('고르지 않았다.');
    expect(picked.rect.y).toBe(100);
    expect(picked.rect.height).toBeGreaterThan(innerHeight);
    expect(picked.start).toEqual({ x: 0, y: 0 });
    expect(picked.view.y).toBe(scrollY);
  });

  it('PAGE-1.15 안쪽 상자만 스크롤되는 페이지에서는 가장자리로 끌어도 상자가 스크롤되지 않는다', async () => {
    const box = appShell(5000);
    const choosing = page().select();
    await mouse('mousePressed', 150, 100);
    await mouse('mouseMoved', 160, innerHeight - 1);
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    expect(box.scrollTop).toBe(0);
    expect(scrollY).toBe(0);
    await mouse('mouseReleased', 160, innerHeight - 1);
    expect(await choosing).toMatchObject({ kind: 'picked' });
  });

  it('웹 페이지가 만든 입력으로는 고르거나 끝내지 않는다', async () => {
    const choosing = page().select();
    const host = document.querySelector(selector);
    for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
      host?.dispatchEvent(
        new PointerEvent(type, { bubbles: true, composed: true, clientX: 10, clientY: 10 }),
      );
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    expect(await pending(choosing)).toBe(true);
    page().restore();
    expect(await choosing).toEqual({ kind: 'ended', reason: 'error' });
  });

  it('되돌리면(작업이 멈춤) 고르는 화면을 지운다', async () => {
    const choosing = page().select();
    page().restore();
    expect(await choosing).toMatchObject({ kind: 'ended' });
    expect(document.querySelector(selector)).toBeNull();
  });

  it('확장을 다시 불러와 연결이 끊긴 뒤 물러남 이벤트가 오면 고르는 화면을 지운다. 연결된 채면 따르지 않는다', async () => {
    const choosing = page().select();
    document.dispatchEvent(new CustomEvent(retireEventName, { detail: 'token' }));
    expect(await pending(choosing)).toBe(true);
    vi.stubGlobal('chrome', { runtime: {} });
    document.dispatchEvent(new CustomEvent(retireEventName, { detail: 'token' }));
    expect(await choosing).toEqual({ kind: 'ended', reason: 'error' });
    expect(document.querySelector(selector)).toBeNull();
  });

  it('한 문서에 다시 넣어도 일은 처음 것 하나다', () => {
    const first = page();
    installPageApi();
    expect(page()).toBe(first);
  });

  it('페이지 스타일이 고르는 화면에 영향을 주지 않는다', async () => {
    const style = document.createElement('style');
    style.dataset['test'] = '';
    style.textContent =
      'browser-toolbox-ui, div { display: none !important; pointer-events: none !important; }';
    document.head.append(style);
    const choosing = page().select();
    await drag([10, 10], [110, 110]);
    expect(await choosing).toMatchObject({ kind: 'picked', rect: { width: 100, height: 100 } });
  });
});
