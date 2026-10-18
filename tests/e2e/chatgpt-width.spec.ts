import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { settingsUpdate } from '../../src/contracts/index.ts';
import { elementTimeoutMs, pageElementAttribute } from '../../src/dom/index.ts';
import { composer, thread } from '../../src/sites/chatgpt/index.ts';
import {
  documentWithoutExtension,
  expect,
  fixtureOrigin,
  openPopupOn,
  problemRecords,
  serviceWorkerOf,
  test,
} from './support/extension.ts';

// GPT-2 대화 열·작성란 너비를 제품 빌드와 실제 Chromium으로 본다(결정 0029, 0031). Playwright가 https://chatgpt.com/ 아래의
// 요청을 본뜬 시험 페이지(tests/fixtures/chatgpt.html, 2026-10-18에 로그인하지 않은 화면을 본뜸)로 답해, manifest대로 ChatGPT
// 묶음이 실린다. 로그인한 실제 화면은 수동 절차(tests/manual/chatgpt-width.md)로 본다.

const chatgptPage = readFileSync(
  path.join(import.meta.dirname, '..', 'fixtures', 'chatgpt.html'),
  'utf8',
);

// 창 1800px에서 시험 페이지의 대화 열은 1412px(옆 메뉴 260, 좌우 여백 64씩), 작성란은 768px(사이트의 최대 너비)이다.
const wide = { width: 1800, height: 900 };
const original = { thread: 1412, composer: 768 };

async function openChatgpt(context: BrowserContext, pathname: string, viewport = wide) {
  await context.route('https://chatgpt.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: chatgptPage }),
  );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.setViewportSize(viewport);
  await page.goto(`https://chatgpt.com${pathname}`);
  return { page, errors };
}

// chatgpt.com의 페이지 안 이동을 흉내 낸다: 문서를 다시 싣지 않고 주소를 바꾸고, 사이트처럼 대화 열과 작성란을 새 요소로
// 바꿔 그린다. 새 대화 화면(/)에는 대화 열이 없다.
async function navigateInPage(page: Page, pathname: string) {
  await page.evaluate(
    ([to, threadSelector, composerSelector]) => {
      history.pushState(null, '', to);
      const transcript = document.querySelector(threadSelector);
      if (to === '/') transcript?.remove();
      else transcript?.replaceWith(transcript.cloneNode(true));
      const positioner = document.querySelector(composerSelector);
      positioner?.replaceWith(positioner.cloneNode(true));
    },
    [pathname, thread.selector, composer.selector] as const,
  );
  expect(new URL(page.url()).pathname).toBe(pathname);
}

// 사이트가 화면을 바꿔 대화 화면에 대화 열이 없어진 것을 흉내 낸다.
function removeThread(page: Page) {
  return page.evaluate((selector) => document.querySelector(selector)?.remove(), thread.selector);
}

// 대화 열이 나중에 나타난다(시험 페이지의 것과 같은 모양).
function addThread(page: Page) {
  return page.evaluate(() => {
    const transcript = document.createElement('ol');
    transcript.setAttribute('aria-label', 'Conversation');
    transcript.setAttribute('data-conversation-transcript', '');
    for (const [role, text] of [
      ['user', 'Hello'],
      ['assistant', 'Hello! How can I help you today?'],
    ] as const) {
      const message = document.createElement('li');
      message.setAttribute('data-message-role', role);
      message.textContent = text;
      transcript.append(message);
    }
    document.querySelector('[data-mobile-thread-content]')?.append(transcript);
  });
}

// 대화 열과 작성란의 그려진 너비(px). 없으면 null이다.
function widths(page: Page) {
  return page.evaluate(
    ([threadSelector, composerSelector]) => {
      const widthOf = (selector: string) => {
        const element = document.querySelector(selector);
        return element === null ? null : Math.round(element.getBoundingClientRect().width);
      };
      return { thread: widthOf(threadSelector), composer: widthOf(composerSelector) };
    },
    [thread.selector, composer.selector] as const,
  );
}

// page를 지금 탭으로 둔 팝업의 ChatGPT 범주에서 이 기능의 스위치와 이유를 고른다.
async function popupOn(context: BrowserContext, extensionId: string, page: Page) {
  const popup = await openPopupOn(context, extensionId, page);
  await popup.getByRole('tab', { name: 'ChatGPT' }).click();
  const feature = popup.getByRole('switch', { name: '대화 열·작성란 너비' });
  await expect(feature).toBeEnabled();
  return { popup, feature, reason: popup.locator('#feature-unavailable-chatgpt-width') };
}

// 팝업이 보내는 것과 같은 설정 바꾸기를 확장 화면(팝업 문서)에서 보낸다.
async function update(popup: Page, patch: Readonly<Record<string, unknown>>) {
  const answer: unknown = await popup.evaluate(
    ({ type, payload }) => chrome.runtime.sendMessage({ type, payload }),
    { type: settingsUpdate.type, payload: { featureId: 'chatgpt-width', patch } },
  );
  expect(answer).toEqual({ ok: true, value: { revision: expect.any(Number) } });
}

test('GPT-2.1 GPT-2.4 COM-1.3 켜면 대화 열과 작성란의 최대 너비가 정한 값(처음 1200px)이고, 바꾸면 따라가며, 끄면 켜기 전과 같다', async ({
  context,
  extensionId,
}) => {
  const { page, errors } = await openChatgpt(context, '/c/abc');
  expect(await widths(page)).toEqual(original);
  const before = await page.evaluate(() => document.documentElement.outerHTML);

  const { popup, feature, reason } = await popupOn(context, extensionId, page);
  await expect(reason).toHaveCount(0);
  await feature.check();
  await expect.poll(() => widths(page)).toEqual({ thread: 1200, composer: 1200 });
  await update(popup, { width: 1000 });
  await expect.poll(() => widths(page)).toEqual({ thread: 1000, composer: 1000 });
  // 페이지에 넣은 것은 표식이 있는 스타일 요소 하나다(결정 0031).
  expect(
    await page.evaluate(
      (attribute) => [...document.querySelectorAll(`[${attribute}]`)].map((e) => e.localName),
      pageElementAttribute,
    ),
  ).toEqual(['style']);

  await feature.uncheck();
  await expect.poll(() => widths(page)).toEqual(original);
  expect(await page.evaluate(() => document.documentElement.outerHTML)).toBe(before);
  expect(errors).toEqual([]);
});

test('GPT-2.1 COM-2.5 결정 0030 팝업의 숫자 칸으로 키보드만 써서 너비를 정하고, 범위 밖의 값은 저장하지 않으며 Esc로 저장된 값에 돌아간다', async ({
  context,
  extensionId,
}) => {
  const worker = await serviceWorkerOf(context);
  const { page } = await openChatgpt(context, '/c/abc');
  const { popup, feature } = await popupOn(context, extensionId, page);
  await feature.check();
  await expect.poll(() => widths(page)).toEqual({ thread: 1200, composer: 1200 });

  // 스위치 다음의 조작이 숫자 칸이고, 저장된 값(처음 1200)을 보인다.
  const field = popup.getByRole('spinbutton', { name: '최대 너비(px)' });
  await feature.focus();
  await popup.keyboard.press('Tab');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('1200');

  await popup.keyboard.press('Control+A');
  await popup.keyboard.type('1300');
  await popup.keyboard.press('Enter');
  await expect.poll(() => widths(page)).toEqual({ thread: 1300, composer: 1300 });
  // ↑는 한 단계(10px) 넓힌다.
  await popup.keyboard.press('ArrowUp');
  await expect.poll(() => widths(page)).toEqual({ thread: 1310, composer: 1310 });
  const storedWidth = () =>
    worker.evaluate(async () => {
      const { settings }: Record<string, unknown> = await chrome.storage.local.get('settings');
      return settings;
    });
  await expect
    .poll(storedWidth)
    .toMatchObject({ features: { 'chatgpt-width': { enabled: true, width: 1310 } } });

  // 범위 밖이면 저장하지 않고 이유를 보이며, Esc로 저장된 값에 돌아간다.
  await popup.keyboard.press('Control+A');
  await popup.keyboard.type('500');
  await popup.keyboard.press('Enter');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(popup.locator('.controls .error')).toBeVisible();
  await popup.keyboard.press('Escape');
  await expect(field).toHaveValue('1310');
  await expect(field).toHaveAttribute('aria-invalid', 'false');
  expect(await widths(page)).toEqual({ thread: 1310, composer: 1310 });
  expect(await storedWidth()).toMatchObject({
    features: { 'chatgpt-width': { enabled: true, width: 1310 } },
  });
});

test('GPT-2.2 다른 대화로 가거나 새 대화를 열어도(문서를 다시 싣든 안 싣든) 정한 너비가 그대로다', async ({
  context,
  extensionId,
}) => {
  const { page, errors } = await openChatgpt(context, '/c/abc');
  const { popup, feature } = await popupOn(context, extensionId, page);
  await feature.check();
  await expect.poll(() => widths(page)).toEqual({ thread: 1200, composer: 1200 });

  // 페이지 안 이동: 사이트가 화면을 새 요소로 다시 그린다.
  await navigateInPage(page, '/c/def');
  expect(await widths(page)).toEqual({ thread: 1200, composer: 1200 });
  await navigateInPage(page, '/');
  expect(await widths(page)).toEqual({ thread: null, composer: 1200 });

  // 문서를 다시 싣는 이동.
  await page.goto('https://chatgpt.com/uc/ghi');
  await expect.poll(() => widths(page)).toEqual({ thread: 1200, composer: 1200 });
  await popup.close();
  expect(errors).toEqual([]);
});

test('GPT-2.3 창이 정한 너비보다 좁으면 창에 맞추고 가로 스크롤 막대가 없다', async ({
  context,
  extensionId,
}) => {
  const { page } = await openChatgpt(context, '/c/abc', { width: 900, height: 800 });
  const before = await widths(page);
  const { feature } = await popupOn(context, extensionId, page);
  await feature.check();
  await expect
    .poll(() => page.evaluate((selector) => document.querySelector(selector) !== null, 'style'))
    .toBe(true);
  // 창 900px에서 대화 열이 담기는 구역은 512px, 작성란이 담기는 바닥은 616px이다. 정한 1200px보다 좁다.
  expect(await widths(page)).toEqual({ thread: 512, composer: 616 });
  expect(before).toEqual({ thread: 512, composer: 616 });
  const overflow = await page.evaluate(() =>
    [document.documentElement, ...document.querySelectorAll('[data-swipable-detail-body]')].map(
      (element) => element.scrollWidth - element.clientWidth,
    ),
  );
  expect(overflow).toEqual([0, 0]);
});

test('GPT-2.5 COM-6.1 COM-6.3 COM-6.4 대화 열이 없으면 15초 뒤 그 기능만 멈춰 되돌리고 팝업에 찾지 못함과 "ChatGPT 대화 열"을 보이며 기록하고, 나중에 나타나면 다시 작용한다', async ({
  context,
  extensionId,
}) => {
  test.setTimeout(90_000);
  const worker = await serviceWorkerOf(context);
  // 사이트가 화면을 바꿔 대화 화면에 대화 열이 없다.
  const { page, errors } = await openChatgpt(context, '/c/abc');
  await removeThread(page);
  const before = await documentWithoutExtension(page);

  const first = await popupOn(context, extensionId, page);
  const enabledAt = Date.now();
  await first.feature.check();
  await first.popup.close();
  // 찾는 동안에는 작성란에 너비가 걸려 있다.
  await expect.poll(() => widths(page)).toEqual({ thread: null, composer: 1200 });

  const expected = {
    featureId: 'chatgpt-width',
    kind: 'not-found',
    element: { id: 'chatgpt.thread', name: 'ChatGPT 대화 열' },
  };
  await expect
    .poll(() => problemRecords(worker), { timeout: elementTimeoutMs + 10_000 })
    .toEqual([{ ...expected, at: expect.any(Number) }]);
  const [record] = await problemRecords(worker);
  const at = typeof record === 'object' && record !== null && 'at' in record ? record.at : null;
  expect(typeof at === 'number' && at >= enabledAt + elementTimeoutMs - 100).toBe(true);

  // 그 기능이 바꾼 것은 모두 되돌려졌다(작성란도 원래 너비).
  expect(await documentWithoutExtension(page)).toBe(before);
  expect(await page.evaluate(() => document.querySelectorAll('style').length)).toBe(1);
  expect(await widths(page)).toEqual({ thread: null, composer: 768 });
  const missing = await popupOn(context, extensionId, page);
  await expect(missing.reason).toHaveText('찾지 못함: ChatGPT 대화 열');
  await expect(missing.feature).toBeChecked();
  await missing.popup.close();

  // COM-6.3 대화 열이 나타나면 다시 작용하고, 다시 연 팝업에 찾지 못함이 없다.
  await addThread(page);
  await expect.poll(() => widths(page)).toEqual({ thread: 1200, composer: 1200 });
  const found = await popupOn(context, extensionId, page);
  await expect(found.reason).toHaveCount(0);
  await found.popup.close();
  expect(await problemRecords(worker)).toHaveLength(1);
  // COM-6.4 페이지 콘솔에 확장이 낸 오류가 없다.
  expect(errors).toEqual([]);
});

test('결정 0031 대화 열이 없는 대화 화면에서 15초가 되기 전에 새 대화로 가면 대화 열을 찾지 않아 찾지 못함이 되지 않는다', async ({
  context,
  extensionId,
}) => {
  test.setTimeout(90_000);
  const worker = await serviceWorkerOf(context);
  const { page } = await openChatgpt(context, '/c/abc');
  await removeThread(page);
  const { popup, feature } = await popupOn(context, extensionId, page);
  await feature.check();
  await popup.close();
  await expect.poll(() => widths(page)).toEqual({ thread: null, composer: 1200 });
  await navigateInPage(page, '/');
  // 처음 찾기 시작한 때부터 15초가 넘도록 기다린다.
  await page.waitForTimeout(elementTimeoutMs + 3000);
  expect(await problemRecords(worker)).toEqual([]);
  expect(await widths(page)).toEqual({ thread: null, composer: 1200 });
});

test('COM-2 기대 동작 4 결정 0029 다른 사이트의 탭에서는 팝업이 이 기능을 chatgpt.com에서만 쓸 수 있다고 보이고, chatgpt.com에서는 보이지 않는다', async ({
  context,
  extensionId,
}) => {
  const other = await context.newPage();
  await other.goto(`${fixtureOrigin}/blank.html`);
  const elsewhere = await popupOn(context, extensionId, other);
  await expect(elsewhere.reason).toHaveText('쓸 수 없음: chatgpt.com에서만 쓸 수 있음');
  // 켜고 끄기는 모든 탭에 대한 설정이라 스위치는 막지 않는다(결정 0023).
  await expect(elsewhere.feature).toBeEnabled();
  await elsewhere.popup.close();

  const { page } = await openChatgpt(context, '/');
  const here = await popupOn(context, extensionId, page);
  await expect(here.reason).toHaveCount(0);
});
