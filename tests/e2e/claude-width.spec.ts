import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { settingsUpdate } from '../../src/contracts/index.ts';
import { elementTimeoutMs, pageElementAttribute } from '../../src/dom/index.ts';
import {
  documentWithoutExtension,
  expect,
  fixtureOrigin,
  openPopupOn,
  problemRecords,
  serviceWorkerOf,
  test,
} from './support/extension.ts';

// CLD-1 claude.ai의 대화 열·작성란 너비를 제품 빌드와 실제 Chromium으로 본다(결정 0029, 0039, 0040). Playwright가
// https://claude.ai/ 아래의 요청을 본뜬 시험 페이지(tests/fixtures/claude.html, 2026-10-20에 사용자의 Chrome에서 본 두 화면)로
// 답해, manifest대로 Claude 묶음이 실린다. 시험 페이지의 화면은 비어 있고 두 화면이 template에 있어, 시험이 사이트처럼 실린
// 뒤에(그리고 페이지 안 이동 때 주소를 바꾼 뒤에) 주소에 맞는 화면을 그려 넣는다. 실제 화면은 수동 절차
// (tests/manual/claude-width.md)로도 본다.

const fixture = readFileSync(
  path.join(import.meta.dirname, '..', 'fixtures', 'claude.html'),
  'utf8',
);

// 너비를 잴 요소. 시험 페이지의 구조로 고른다(사이트 모듈의 단서와 따로).
const threadSelector = '.transcript';
const composerSelector = '[data-composer-card-holder]';
// 가로로 넘치는지 볼 스크롤 구역(두 화면).
const scrollers = '[data-autoscroll-container], [data-new-page-scroll-column]';

const wide = { width: 1800, height: 900 };
const narrow = { width: 900, height: 800 };

// 켜기 전 넓은 창의 너비. 대화 화면은 둘 다 사이트의 변수 48rem, 새 채팅 화면의 작성란은 자리의 최대 너비 40rem이다.
const original = {
  conversation: { thread: 768, composer: 768 },
  newChat: { thread: null, composer: 640 },
};
// 좁은 창(900px)의 너비. 정한 1200px보다 좁아 켜도 같다. 옆 메뉴 288px를 뺀 612px에서, 대화 화면은 열의 안쪽 여백 20px씩,
// 새 채팅 화면은 틀의 안쪽 여백 56px씩을 뺀다.
const narrowed = {
  conversation: { thread: 572, composer: 572 },
  newChat: { thread: null, composer: 500 },
};

type Screen = 'chat' | 'new';

const screenOf = (pathname: string): Screen => (pathname === '/new' ? 'new' : 'chat');

// 사이트처럼 지금 화면을 그린다(앞 화면을 숨긴 채 남기지 않고 바꾼다).
function draw(page: Page, screen: Screen) {
  return page.evaluate((name) => {
    const template = document.querySelector(`template[data-screen="${name}"]`);
    const outlet = document.querySelector('[data-route-outlet]');
    if (!(template instanceof HTMLTemplateElement) || outlet === null) {
      throw new Error('시험 페이지의 화면 틀이 없다.');
    }
    outlet.replaceChildren(template.content.cloneNode(true));
  }, screen);
}

async function routeClaude(context: BrowserContext) {
  await context.route('https://claude.ai/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture }),
  );
}

async function openClaude(context: BrowserContext, pathname: string, viewport = wide) {
  await routeClaude(context);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.setViewportSize(viewport);
  await goTo(page, pathname);
  return { page, errors };
}

// 문서를 다시 싣는 이동.
async function goTo(page: Page, pathname: string) {
  await page.goto(`https://claude.ai${pathname}`);
  await draw(page, screenOf(pathname));
}

// claude.ai의 페이지 안 이동을 흉내 낸다: 문서를 다시 싣지 않고 주소를 바꾼 뒤(이동 신호를 받은 때에는 앞 화면이 아직
// 보인다) 새 화면을 그린다.
async function navigateInPage(page: Page, pathname: string) {
  await page.evaluate((to) => {
    history.pushState(null, '', to);
  }, pathname);
  await draw(page, screenOf(pathname));
  expect(new URL(page.url()).pathname).toBe(pathname);
}

// 대화 화면에서 메시지를 보내 사이트가 답을 만들기 시작한 때처럼 한다(2026-10-20에 사용자의 Chrome에서 봄, 이슈 #9): 보낸
// 메시지의 행을 더하고 열에서 상태 속성 data-transcript-stays-put-scope를 뗀다. 열과 그 안의 상자, 너비는 그대로다.
function startAnswer(page: Page) {
  return page.evaluate(() => {
    const column = document.querySelector('.column');
    const transcript = document.querySelector('.transcript');
    if (column === null || transcript === null) throw new Error('대화 화면이 없다.');
    const row = document.createElement('div');
    row.setAttribute('data-transcript-row', '');
    row.setAttribute('data-turn-key', '');
    row.textContent = 'Question';
    transcript.append(row);
    column.removeAttribute('data-transcript-stays-put-scope');
  });
}

// 보이는 대화 열과 작성란의 그려진 너비(px). 없으면 null이다.
function widths(page: Page) {
  return page.evaluate(
    ([thread, composer]) => {
      const widthOf = (selector: string) => {
        const element = document.querySelector(selector);
        return element === null ? null : Math.round(element.getBoundingClientRect().width);
      };
      return { thread: widthOf(thread), composer: widthOf(composer) };
    },
    [threadSelector, composerSelector] as const,
  );
}

const styled = (page: Page, name: string) =>
  page.evaluate(
    ([attribute, value]) => document.querySelector(`style[${attribute}="${value}"]`) !== null,
    [pageElementAttribute, name] as const,
  );

// page를 지금 탭으로 둔 팝업의 Claude 범주에서 이 기능의 스위치와 이유를 고른다.
async function popupOn(context: BrowserContext, extensionId: string, page: Page) {
  const popup = await openPopupOn(context, extensionId, page);
  await popup.getByRole('tab', { name: 'Claude' }).click();
  const feature = popup.getByRole('switch', { name: '대화 열·작성란 너비' });
  await expect(feature).toBeEnabled();
  return { popup, feature, reason: popup.locator('#feature-unavailable-claude-width') };
}

// 팝업이 보내는 것과 같은 설정 바꾸기를 확장 화면(팝업 문서)에서 보낸다.
async function update(popup: Page, featureId: string, patch: Readonly<Record<string, unknown>>) {
  const answer: unknown = await popup.evaluate(
    ({ type, payload }) => chrome.runtime.sendMessage({ type, payload }),
    { type: settingsUpdate.type, payload: { featureId, patch } },
  );
  expect(answer).toEqual({ ok: true, value: { revision: expect.any(Number) } });
}

test('CLD-1.1 CLD-1.4 COM-1.3 켜면 대화 화면의 대화 열과 작성란의 최대 너비가 정한 값(처음 1200px)이고, 바꾸면 따라가며, 끄면 켜기 전과 같다', async ({
  context,
  extensionId,
}) => {
  const { page, errors } = await openClaude(context, '/chat/abc');
  expect(await widths(page)).toEqual(original.conversation);
  const before = await page.evaluate(() => document.documentElement.outerHTML);

  const { popup, feature, reason } = await popupOn(context, extensionId, page);
  await expect(reason).toHaveCount(0);
  await feature.check();
  await expect.poll(() => widths(page)).toEqual({ thread: 1200, composer: 1200 });
  await update(popup, 'claude-width', { width: 1000 });
  await expect.poll(() => widths(page)).toEqual({ thread: 1000, composer: 1000 });
  // 페이지에 넣은 것은 표식이 있는 스타일 요소 하나다(결정 0031, 0039).
  expect(
    await page.evaluate(
      (attribute) => [...document.querySelectorAll(`[${attribute}]`)].map((e) => e.localName),
      pageElementAttribute,
    ),
  ).toEqual(['style']);

  await feature.uncheck();
  await expect.poll(() => widths(page)).toEqual(original.conversation);
  expect(await page.evaluate(() => document.documentElement.outerHTML)).toBe(before);
  expect(errors).toEqual([]);
});

test('CLD-1.1 CLD-1.2 다른 대화로 가거나 새 채팅을 열어도(문서를 다시 싣든 안 싣든) 정한 너비가 그대로이고, 새 채팅 화면의 작성란도 그 너비다', async ({
  context,
  extensionId,
}) => {
  const { page, errors } = await openClaude(context, '/chat/abc');
  const { feature } = await popupOn(context, extensionId, page);
  await feature.check();
  await expect.poll(() => widths(page)).toEqual({ thread: 1200, composer: 1200 });

  // 페이지 안 이동: 사이트가 화면을 새 요소로 다시 그린다.
  await navigateInPage(page, '/chat/def');
  expect(await widths(page)).toEqual({ thread: 1200, composer: 1200 });
  await navigateInPage(page, '/new');
  expect(await widths(page)).toEqual({ thread: null, composer: 1200 });

  // 문서를 다시 싣는 이동.
  await goTo(page, '/new');
  await expect.poll(() => widths(page)).toEqual({ thread: null, composer: 1200 });
  await goTo(page, '/chat/ghi');
  await expect.poll(() => widths(page)).toEqual({ thread: 1200, composer: 1200 });

  // 끄면 새 채팅 화면의 작성란도 사이트의 너비로 돌아간다.
  await navigateInPage(page, '/new');
  await feature.uncheck();
  await expect.poll(() => widths(page)).toEqual(original.newChat);
  expect(errors).toEqual([]);
});

test('CLD-1.3 창이 정한 너비보다 좁으면 두 화면 모두 창에 맞추고 가로 스크롤 막대가 없다', async ({
  context,
  extensionId,
}) => {
  const { page } = await openClaude(context, '/chat/abc', narrow);
  expect(await widths(page)).toEqual(narrowed.conversation);
  const { feature } = await popupOn(context, extensionId, page);
  await feature.check();
  await expect.poll(() => styled(page, 'claude-width')).toBe(true);
  const overflow = () =>
    page.evaluate(
      (selector) =>
        [document.documentElement, ...document.querySelectorAll(selector)].map(
          (element) => element.scrollWidth - element.clientWidth,
        ),
      scrollers,
    );
  expect(await widths(page)).toEqual(narrowed.conversation);
  expect(await overflow()).toEqual([0, 0]);

  await navigateInPage(page, '/new');
  expect(await widths(page)).toEqual(narrowed.newChat);
  expect(await overflow()).toEqual([0, 0]);
});

test('CLD-1.5 COM-6.1 COM-6.3 COM-6.4 대화 열이 없으면 15초 뒤 그 기능만 멈춰 되돌리고 팝업에 찾지 못함과 "Claude 대화 열"을 보이며 기록하고, 나중에 나타나면 다시 작용한다', async ({
  context,
  extensionId,
}) => {
  test.setTimeout(90_000);
  const worker = await serviceWorkerOf(context);
  // 사이트가 화면을 바꿔 대화 화면에 대화 기록 상자가 없다.
  const { page, errors } = await openClaude(context, '/chat/abc');
  const removed = await page.evaluateHandle((selector) => {
    const transcript = document.querySelector(selector);
    const parent = transcript?.parentElement;
    if (transcript === null || parent === null || parent === undefined) {
      throw new Error('대화 기록 상자가 없다.');
    }
    transcript.remove();
    return [transcript, parent] as const;
  }, threadSelector);
  const before = await documentWithoutExtension(page);

  const first = await popupOn(context, extensionId, page);
  const enabledAt = Date.now();
  await first.feature.check();
  await first.popup.close();
  // 찾는 동안에는 작성란에 너비가 걸려 있다.
  await expect.poll(() => widths(page)).toEqual({ thread: null, composer: 1200 });

  await expect
    .poll(() => problemRecords(worker), { timeout: elementTimeoutMs + 10_000 })
    .toEqual([
      {
        featureId: 'claude-width',
        kind: 'not-found',
        element: { id: 'claude.thread', name: 'Claude 대화 열' },
        at: expect.any(Number),
      },
    ]);
  const [record] = await problemRecords(worker);
  const at = typeof record === 'object' && record !== null && 'at' in record ? record.at : null;
  expect(typeof at === 'number' && at >= enabledAt + elementTimeoutMs - 100).toBe(true);

  // 그 기능이 바꾼 것은 모두 되돌려졌다(작성란도 원래 너비).
  expect(await documentWithoutExtension(page)).toBe(before);
  expect(await widths(page)).toEqual({ thread: null, composer: original.conversation.composer });
  const missing = await popupOn(context, extensionId, page);
  await expect(missing.reason).toHaveText('찾지 못함: Claude 대화 열');
  await expect(missing.feature).toBeChecked();
  await missing.popup.close();

  // COM-6.3 대화 기록 상자가 나타나면 다시 작용하고, 다시 연 팝업에 찾지 못함이 없다.
  await removed.evaluate(([transcript, parent]) => {
    parent.prepend(transcript);
  });
  await expect.poll(() => widths(page)).toEqual({ thread: 1200, composer: 1200 });
  const found = await popupOn(context, extensionId, page);
  await expect(found.reason).toHaveCount(0);
  await found.popup.close();
  expect(await problemRecords(worker)).toHaveLength(1);
  // COM-6.4 페이지 콘솔에 확장이 낸 오류가 없다.
  expect(errors).toEqual([]);
});

test('CLD-1.6 COM-6.8 결정 0034 사이트가 열 너비 변수를 쓰지 않으면(요소는 그대로) 15초 뒤 그 기능만 멈춰 되돌리고 팝업에 "적용되지 않음: Claude 대화 열"을 보이며 기록한다', async ({
  context,
  extensionId,
}) => {
  test.setTimeout(90_000);
  const worker = await serviceWorkerOf(context);
  const { page, errors } = await openClaude(context, '/chat/abc');
  // 열과 대화 기록 상자가 최대 너비를 변수 없이 같은 값으로 둔다. 요소와 단서는 그대로다.
  await page.evaluate(() => {
    const rules = document.createElement('style');
    rules.textContent = '.column { max-width: 808px; } .transcript { max-width: 768px; }';
    document.head.append(rules);
  });
  const before = await documentWithoutExtension(page);

  const first = await popupOn(context, extensionId, page);
  const enabledAt = Date.now();
  await first.feature.check();
  await first.popup.close();
  // 스타일은 걸렸지만 대화 열과 작성란의 너비는 그대로다.
  await expect.poll(() => styled(page, 'claude-width')).toBe(true);
  expect(await widths(page)).toEqual(original.conversation);

  await expect
    .poll(() => problemRecords(worker), { timeout: elementTimeoutMs + 10_000 })
    .toEqual([
      {
        featureId: 'claude-width',
        kind: 'not-applied',
        element: { id: 'claude.thread', name: 'Claude 대화 열' },
        at: expect.any(Number),
      },
    ]);
  const [record] = await problemRecords(worker);
  const at = typeof record === 'object' && record !== null && 'at' in record ? record.at : null;
  expect(typeof at === 'number' && at >= enabledAt + elementTimeoutMs - 100).toBe(true);
  expect(await documentWithoutExtension(page)).toBe(before);
  const shown = await popupOn(context, extensionId, page);
  await expect(shown.reason).toHaveText('적용되지 않음: Claude 대화 열');
  await expect(shown.feature).toBeChecked();
  await shown.popup.close();
  expect(errors).toEqual([]);
});

test('CLD-1.6 COM-6.8 결정 0040 너비 규칙이 작용하면 두 화면 모두 넓은 창이든 정한 너비보다 좁은 창이든 15초가 지나도 적용되지 않음이 되지 않는다', async ({
  context,
  extensionId,
}) => {
  test.setTimeout(90_000);
  const worker = await serviceWorkerOf(context);
  await routeClaude(context);
  // 한 번의 15초로 네 경우를 함께 본다.
  const cases = [
    { pathname: '/chat/wide', viewport: wide, expected: { thread: 1200, composer: 1200 } },
    { pathname: '/chat/narrow', viewport: narrow, expected: narrowed.conversation },
    { pathname: '/new', viewport: wide, expected: { thread: null, composer: 1200 } },
    { pathname: '/new', viewport: narrow, expected: narrowed.newChat },
  ];
  const opened: ((typeof cases)[number] & { readonly page: Page })[] = [];
  for (const entry of cases) {
    const page = await context.newPage();
    await page.setViewportSize(entry.viewport);
    await goTo(page, entry.pathname);
    opened.push({ ...entry, page });
  }
  const [first] = opened;
  if (first === undefined) throw new Error('연 탭이 없다.');
  const { popup, feature } = await popupOn(context, extensionId, first.page);
  await feature.check();
  await popup.close();
  for (const { page, expected } of opened) {
    await expect.poll(() => widths(page)).toEqual(expected);
  }
  await first.page.waitForTimeout(elementTimeoutMs + 3000);
  expect(await problemRecords(worker)).toEqual([]);
  for (const { page, expected } of opened) {
    expect(await widths(page)).toEqual(expected);
  }
});

test('CLD-1.2 CLD-1.5 이슈 #9 답을 기다리는 동안(사이트가 열의 상태 속성을 뗌) 대화를 연 지 15초가 되어도, 다른 대화로 옮겨 곧 보낸 때와 새 채팅의 첫 메시지 뒤 모두 찾지 못함이 되지 않고 정한 너비가 그대로다', async ({
  context,
  extensionId,
}) => {
  test.setTimeout(90_000);
  const worker = await serviceWorkerOf(context);
  // 다른 대화로 옮기고 곧 메시지를 보낸다. 옮길 때 찾기와 확인(15초)이 새로 시작된다.
  const { page: moved, errors } = await openClaude(context, '/chat/abc');
  const { popup, feature } = await popupOn(context, extensionId, moved);
  await feature.check();
  await popup.close();
  await expect.poll(() => widths(moved)).toEqual({ thread: 1200, composer: 1200 });
  await navigateInPage(moved, '/chat/def');
  await startAnswer(moved);
  // 새 채팅에서 첫 메시지를 보낸다. 사이트는 주소를 대화 주소로 바꾸고 답을 만드는 중인 대화 화면을 그린다.
  const { page: first, errors: firstErrors } = await openClaude(context, '/new');
  await expect.poll(() => widths(first)).toEqual({ thread: null, composer: 1200 });
  await navigateInPage(first, '/chat/ghi');
  await startAnswer(first);

  // 두 탭 모두 이동한 때부터 15초가 지나도록 답을 만드는 중이다.
  await moved.waitForTimeout(elementTimeoutMs + 3000);
  expect(await problemRecords(worker)).toEqual([]);
  for (const page of [moved, first]) {
    expect(await styled(page, 'claude-width')).toBe(true);
    expect(await widths(page)).toEqual({ thread: 1200, composer: 1200 });
    const shown = await popupOn(context, extensionId, page);
    await expect(shown.reason).toHaveCount(0);
    await shown.popup.close();
  }
  expect([...errors, ...firstErrors]).toEqual([]);
});

test('CLD-1.1 COM-2.5 결정 0039 팝업의 숫자 칸으로 키보드만 써서 이 기능의 너비를 정한다', async ({
  context,
  extensionId,
}) => {
  const worker = await serviceWorkerOf(context);
  const { page } = await openClaude(context, '/chat/abc');
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
  await popup.keyboard.press('ArrowUp');
  await expect.poll(() => widths(page)).toEqual({ thread: 1310, composer: 1310 });
  await expect
    .poll(() =>
      worker.evaluate(async () => {
        const { settings }: Record<string, unknown> = await chrome.storage.local.get('settings');
        return settings;
      }),
    )
    .toMatchObject({ features: { 'claude-width': { enabled: true, width: 1310 } } });
});

test('CLD-1.7 COM-2 기대 동작 4 결정 0029 GPT-2와 CLD-1은 따로 켜고 끄고 따로 정하며, claude.ai가 아닌 탭에서는 이 기능을 claude.ai에서만 쓸 수 있다고 보인다', async ({
  context,
  extensionId,
}) => {
  const chatgptFixture = readFileSync(
    path.join(import.meta.dirname, '..', 'fixtures', 'chatgpt-signed-in.html'),
    'utf8',
  );
  await context.route('https://chatgpt.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: chatgptFixture }),
  );
  const chatgpt = await context.newPage();
  await chatgpt.setViewportSize(wide);
  await chatgpt.goto('https://chatgpt.com/c/abc');
  const chatgptWidths = () =>
    chatgpt.evaluate(() =>
      [...document.querySelectorAll('[data-thread-find-target], form[data-chatgpt-composer]')]
        .map((element) => Math.round(element.getBoundingClientRect().width))
        .filter((width) => width > 0),
    );
  expect(await chatgptWidths()).toEqual([768, 768]);
  const { page: claude } = await openClaude(context, '/chat/abc');

  // CLD-1만 켜면 chatgpt.com 탭은 그대로다.
  const { popup, feature } = await popupOn(context, extensionId, claude);
  await feature.check();
  await expect.poll(() => widths(claude)).toEqual({ thread: 1200, composer: 1200 });
  expect(await styled(chatgpt, 'chatgpt-width')).toBe(false);
  expect(await chatgptWidths()).toEqual([768, 768]);

  // GPT-2를 켜고 너비를 바꿔도 claude.ai 탭의 너비는 그대로다. 그 반대도 같다.
  await update(popup, 'chatgpt-width', { enabled: true, width: 1000 });
  await expect.poll(chatgptWidths).toEqual([1000, 1000]);
  expect(await widths(claude)).toEqual({ thread: 1200, composer: 1200 });
  await update(popup, 'claude-width', { width: 1400 });
  await expect.poll(() => widths(claude)).toEqual({ thread: 1400, composer: 1400 });
  expect(await chatgptWidths()).toEqual([1000, 1000]);
  // GPT-2를 꺼도 CLD-1은 그대로다.
  await update(popup, 'chatgpt-width', { enabled: false });
  await expect.poll(chatgptWidths).toEqual([768, 768]);
  expect(await widths(claude)).toEqual({ thread: 1400, composer: 1400 });
  await popup.close();

  // claude.ai가 아닌 탭(다른 사이트, chatgpt.com)에서는 이유를 보이고 스위치는 막지 않는다(결정 0023). claude.ai에서는 없다.
  const other = await context.newPage();
  await other.goto(`${fixtureOrigin}/blank.html`);
  for (const elsewhere of [other, chatgpt]) {
    const shown = await popupOn(context, extensionId, elsewhere);
    await expect(shown.reason).toHaveText('쓸 수 없음: claude.ai에서만 쓸 수 있음');
    await expect(shown.feature).toBeEnabled();
    await shown.popup.close();
  }
  const here = await popupOn(context, extensionId, claude);
  await expect(here.reason).toHaveCount(0);
});
