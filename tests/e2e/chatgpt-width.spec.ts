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

// GPT-2 대화 열·작성란 너비를 제품 빌드와 실제 Chromium으로 본다(결정 0029, 0031, 0032). Playwright가 https://chatgpt.com/
// 아래의 요청을 본뜬 시험 페이지로 답해, manifest대로 ChatGPT 묶음이 실린다. 시험 페이지는 2026-10-18에 본 두 화면이다:
// 로그인하지 않은 화면(tests/fixtures/chatgpt.html)과 로그인한 화면(tests/fixtures/chatgpt-signed-in.html, 사용자의 Chrome).
// 로그인한 실제 화면은 수동 절차(tests/manual/chatgpt-width.md)로도 본다.

// 시험 페이지 하나의 화면. 너비는 창 1800px(넓음)과 900px(좁음)에서의 값이다.
interface Shell {
  readonly name: string;
  readonly fixture: string;
  // 너비를 잴 대화 열과 작성란. 숨긴 채 남은 앞 화면의 것은 재지 않는다(보이는 것만).
  readonly thread: string;
  readonly composer: string;
  // 화면마다의 상자. 사이트는 페이지 안에서 이동하면 지금 화면의 상자를 숨긴 채 남기고 새 화면의 상자를 그 뒤에 그린다
  // (로그인한 화면, 2026-10-19). null이면 보이는 요소를 새 요소로 바꿔 그린다(로그인하지 않은 화면의 이동은 보지 않았다).
  readonly surface: string | null;
  // 문서를 다시 싣는 이동으로 여는 다른 대화의 주소.
  readonly reloadPath: string;
  // 켜기 전 넓은 창의 너비, 좁은 창의 너비(정한 1200px보다 좁아 켜도 같다).
  readonly original: { readonly thread: number; readonly composer: number };
  readonly narrow: { readonly thread: number; readonly composer: number };
  // 가로로 넘치는지 볼 스크롤 구역.
  readonly scrollers: string;
}

const signedOut: Shell = {
  name: '로그인하지 않은 화면',
  fixture: 'chatgpt.html',
  thread: 'ol[data-conversation-transcript]',
  composer: '[data-composer-positioner]',
  surface: null,
  reloadPath: '/uc/ghi',
  // 대화 열: 1800 − 옆 메뉴 260 − 좌우 여백 64씩. 작성란: 사이트의 최대 너비.
  original: { thread: 1412, composer: 768 },
  // 대화 열: 900 − 260 − 128. 작성란: 900 − 260 − 바닥의 여백 12씩.
  narrow: { thread: 512, composer: 616 },
  scrollers: '[data-swipable-detail-body]',
};

const signedIn: Shell = {
  name: '로그인한 화면',
  fixture: 'chatgpt-signed-in.html',
  thread: '[data-thread-find-target]',
  composer: 'form[data-chatgpt-composer]',
  surface: '[data-app-shell-page-surface]',
  reloadPath: '/c/ghi',
  // 둘 다 사이트의 변수 48rem(바깥 상자는 그에 여백 20px씩을 더한 808px).
  original: { thread: 768, composer: 768 },
  // 900 − 260 = 640의 바깥 상자에서 여백 20px씩을 뺀 너비.
  narrow: { thread: 600, composer: 600 },
  scrollers: '.scroll',
};

const shells: readonly Shell[] = [signedOut, signedIn];

const wide = { width: 1800, height: 900 };
const narrow = { width: 900, height: 800 };

function fixtureOf(shell: Shell): string {
  return readFileSync(path.join(import.meta.dirname, '..', 'fixtures', shell.fixture), 'utf8');
}

async function openChatgpt(
  context: BrowserContext,
  shell: Shell,
  pathname: string,
  viewport = wide,
) {
  const body = fixtureOf(shell);
  await context.route('https://chatgpt.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body }),
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

// chatgpt.com의 페이지 안 이동을 흉내 낸다: 문서를 다시 싣지 않고 주소를 바꾼 뒤(이동 신호를 받은 때에는 앞 화면이 아직
// 보인다) 사이트처럼 새 화면을 그린다. 화면마다의 상자가 있는 화면은 지금 화면의 상자를 숨긴 채 남기고 그 사본을 새 화면으로
// 뒤에 두고, 없는 화면은 보이는 대화 열과 작성란을 새 요소로 바꾼다. thread가 거짓이면 새 화면에 단서에 맞는 대화 열이 없다
// (새 대화 화면 /, 또는 사이트가 대화 열을 바꾼 화면).
async function navigateInPage(
  page: Page,
  shell: Shell,
  pathname: string,
  { thread = pathname !== '/' }: { thread?: boolean } = {},
) {
  await page.evaluate(
    ([to, threadSelector, composerSelector, surfaceSelector, withThread]) => {
      const visible = (selector: string) =>
        [...document.querySelectorAll(selector)].find(
          (element) => element.getBoundingClientRect().width > 0,
        );
      history.pushState(null, '', to);
      if (surfaceSelector !== null) {
        const current = visible(composerSelector)?.closest(surfaceSelector);
        if (!(current instanceof HTMLElement)) throw new Error('지금 화면의 상자가 없다.');
        const next = current.cloneNode(true);
        if (!(next instanceof Element)) throw new Error('상자를 베끼지 못했다.');
        if (!withThread)
          for (const element of next.querySelectorAll(threadSelector)) element.remove();
        current.style.display = 'none';
        current.after(next);
        return;
      }
      const transcript = visible(threadSelector);
      if (withThread) transcript?.replaceWith(transcript.cloneNode(true));
      else transcript?.remove();
      const form = visible(composerSelector);
      form?.replaceWith(form.cloneNode(true));
    },
    [pathname, shell.thread, shell.composer, shell.surface, thread] as const,
  );
  expect(new URL(page.url()).pathname).toBe(pathname);
}

// 사이트가 지금 화면을 바꿔 대화 열이 없어진 것을 흉내 낸다. 앞 화면이 숨긴 채 남긴 대화 열은 그대로 둔다: 단서에 맞아도
// 지금 화면의 것이 아니다(결정 0035). 돌려준 함수는 뗀 요소를 제자리에 다시 붙인다(요소가 나중에 나타남).
async function removeThread(page: Page, shell: Shell) {
  const removed = await page.evaluateHandle((selector) => {
    const places = [...document.querySelectorAll(selector)]
      .filter((element) => element.getBoundingClientRect().width > 0)
      .map((element) => [element, element.parentElement] as const);
    if (places.length === 0) throw new Error('보이는 대화 열이 없다.');
    for (const [element] of places) element.remove();
    return places;
  }, shell.thread);
  return () =>
    removed.evaluate((places) => {
      for (const [element, parent] of places) parent?.append(element);
    });
}

// 보이는 대화 열과 작성란의 그려진 너비(px). 없으면 null이다.
function widths(page: Page, shell: Shell) {
  return page.evaluate(
    ([threadSelector, composerSelector]) => {
      const widthOf = (selector: string) => {
        const shown = [...document.querySelectorAll(selector)]
          .map((element) => Math.round(element.getBoundingClientRect().width))
          .find((width) => width > 0);
        return shown ?? null;
      };
      return { thread: widthOf(threadSelector), composer: widthOf(composerSelector) };
    },
    [shell.thread, shell.composer] as const,
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

for (const shell of shells) {
  test(`GPT-2.1 GPT-2.4 COM-1.3 ${shell.name}: 켜면 대화 열과 작성란의 최대 너비가 정한 값(처음 1200px)이고, 바꾸면 따라가며, 끄면 켜기 전과 같다`, async ({
    context,
    extensionId,
  }) => {
    const { page, errors } = await openChatgpt(context, shell, '/c/abc');
    expect(await widths(page, shell)).toEqual(shell.original);
    const before = await page.evaluate(() => document.documentElement.outerHTML);

    const { popup, feature, reason } = await popupOn(context, extensionId, page);
    await expect(reason).toHaveCount(0);
    await feature.check();
    await expect.poll(() => widths(page, shell)).toEqual({ thread: 1200, composer: 1200 });
    await update(popup, { width: 1000 });
    await expect.poll(() => widths(page, shell)).toEqual({ thread: 1000, composer: 1000 });
    // 페이지에 넣은 것은 표식이 있는 스타일 요소 하나다(결정 0031).
    expect(
      await page.evaluate(
        (attribute) => [...document.querySelectorAll(`[${attribute}]`)].map((e) => e.localName),
        pageElementAttribute,
      ),
    ).toEqual(['style']);

    await feature.uncheck();
    await expect.poll(() => widths(page, shell)).toEqual(shell.original);
    expect(await page.evaluate(() => document.documentElement.outerHTML)).toBe(before);
    expect(errors).toEqual([]);
  });

  test(`GPT-2.2 ${shell.name}: 다른 대화로 가거나 새 대화를 열어도(문서를 다시 싣든 안 싣든) 정한 너비가 그대로다`, async ({
    context,
    extensionId,
  }) => {
    const { page, errors } = await openChatgpt(context, shell, '/c/abc');
    const { popup, feature } = await popupOn(context, extensionId, page);
    await feature.check();
    await expect.poll(() => widths(page, shell)).toEqual({ thread: 1200, composer: 1200 });

    // 페이지 안 이동: 사이트가 화면을 새 요소로 다시 그린다.
    await navigateInPage(page, shell, '/c/def');
    expect(await widths(page, shell)).toEqual({ thread: 1200, composer: 1200 });
    await navigateInPage(page, shell, '/');
    expect(await widths(page, shell)).toEqual({ thread: null, composer: 1200 });

    // 문서를 다시 싣는 이동.
    await page.goto(`https://chatgpt.com${shell.reloadPath}`);
    await expect.poll(() => widths(page, shell)).toEqual({ thread: 1200, composer: 1200 });
    await popup.close();
    expect(errors).toEqual([]);
  });

  test(`GPT-2.3 ${shell.name}: 창이 정한 너비보다 좁으면 창에 맞추고 가로 스크롤 막대가 없다`, async ({
    context,
    extensionId,
  }) => {
    const { page } = await openChatgpt(context, shell, '/c/abc', narrow);
    const before = await widths(page, shell);
    const { feature } = await popupOn(context, extensionId, page);
    await feature.check();
    await expect
      .poll(() =>
        page.evaluate(
          (attribute) => document.querySelector(`style[${attribute}]`) !== null,
          pageElementAttribute,
        ),
      )
      .toBe(true);
    // 창 900px에서 대화 열과 작성란이 담기는 상자는 정한 1200px보다 좁다.
    expect(await widths(page, shell)).toEqual(shell.narrow);
    expect(before).toEqual(shell.narrow);
    const overflow = await page.evaluate(
      (selector) =>
        [document.documentElement, ...document.querySelectorAll(selector)].map(
          (element) => element.scrollWidth - element.clientWidth,
        ),
      shell.scrollers,
    );
    expect(overflow.every((extra) => extra === 0)).toBe(true);
    expect(overflow.length).toBeGreaterThan(1);
  });

  test(`GPT-2.5 COM-6.1 COM-6.3 COM-6.4 ${shell.name}: 대화 열이 없으면 15초 뒤 그 기능만 멈춰 되돌리고 팝업에 찾지 못함과 "ChatGPT 대화 열"을 보이며 기록하고, 나중에 나타나면 다시 작용한다`, async ({
    context,
    extensionId,
  }) => {
    test.setTimeout(90_000);
    const worker = await serviceWorkerOf(context);
    // 사이트가 화면을 바꿔 대화 화면에 대화 열이 없다(로그인한 화면에는 숨긴 채 남은 앞 화면의 대화 열이 있다).
    const { page, errors } = await openChatgpt(context, shell, '/c/abc');
    const restoreThread = await removeThread(page, shell);
    const before = await documentWithoutExtension(page);

    const first = await popupOn(context, extensionId, page);
    const enabledAt = Date.now();
    await first.feature.check();
    await first.popup.close();
    // 찾는 동안에는 작성란에 너비가 걸려 있다.
    await expect.poll(() => widths(page, shell)).toEqual({ thread: null, composer: 1200 });

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
    expect(await widths(page, shell)).toEqual({ thread: null, composer: shell.original.composer });
    const missing = await popupOn(context, extensionId, page);
    await expect(missing.reason).toHaveText('찾지 못함: ChatGPT 대화 열');
    await expect(missing.feature).toBeChecked();
    await missing.popup.close();

    // COM-6.3 대화 열이 나타나면 다시 작용하고, 다시 연 팝업에 찾지 못함이 없다.
    await restoreThread();
    await expect.poll(() => widths(page, shell)).toEqual({ thread: 1200, composer: 1200 });
    const found = await popupOn(context, extensionId, page);
    await expect(found.reason).toHaveCount(0);
    await found.popup.close();
    expect(await problemRecords(worker)).toHaveLength(1);
    // COM-6.4 페이지 콘솔에 확장이 낸 오류가 없다.
    expect(errors).toEqual([]);
  });
}

test('GPT-2.1 COM-2.5 결정 0030 팝업의 숫자 칸으로 키보드만 써서 너비를 정하고, 범위 밖의 값은 저장하지 않으며 Esc로 저장된 값에 돌아간다', async ({
  context,
  extensionId,
}) => {
  const worker = await serviceWorkerOf(context);
  const { page } = await openChatgpt(context, signedOut, '/c/abc');
  const { popup, feature } = await popupOn(context, extensionId, page);
  await feature.check();
  await expect.poll(() => widths(page, signedOut)).toEqual({ thread: 1200, composer: 1200 });

  // 스위치 다음의 조작이 숫자 칸이고, 저장된 값(처음 1200)을 보인다.
  const field = popup.getByRole('spinbutton', { name: '최대 너비(px)' });
  await feature.focus();
  await popup.keyboard.press('Tab');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('1200');

  await popup.keyboard.press('Control+A');
  await popup.keyboard.type('1300');
  await popup.keyboard.press('Enter');
  await expect.poll(() => widths(page, signedOut)).toEqual({ thread: 1300, composer: 1300 });
  // ↑는 한 단계(10px) 넓힌다.
  await popup.keyboard.press('ArrowUp');
  await expect.poll(() => widths(page, signedOut)).toEqual({ thread: 1310, composer: 1310 });
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
  expect(await widths(page, signedOut)).toEqual({ thread: 1310, composer: 1310 });
  expect(await storedWidth()).toMatchObject({
    features: { 'chatgpt-width': { enabled: true, width: 1310 } },
  });
});

test('결정 0031 대화 열이 없는 대화 화면에서 15초가 되기 전에 새 대화로 가면 대화 열을 찾지 않아 찾지 못함이 되지 않는다', async ({
  context,
  extensionId,
}) => {
  test.setTimeout(90_000);
  const worker = await serviceWorkerOf(context);
  const { page } = await openChatgpt(context, signedOut, '/c/abc');
  await removeThread(page, signedOut);
  const { popup, feature } = await popupOn(context, extensionId, page);
  await feature.check();
  await popup.close();
  await expect.poll(() => widths(page, signedOut)).toEqual({ thread: null, composer: 1200 });
  await navigateInPage(page, signedOut, '/');
  // 처음 찾기 시작한 때부터 15초가 넘도록 기다린다.
  await page.waitForTimeout(elementTimeoutMs + 3000);
  expect(await problemRecords(worker)).toEqual([]);
  expect(await widths(page, signedOut)).toEqual({ thread: null, composer: 1200 });
});

// 로그인한 화면에서 사이트가 열 너비 변수를 그만 쓴 것을 흉내 낸다: 대화 열과 작성란의 바깥 상자가 최대 너비를 변수 없이 같은
// 값(808px)으로 둔다. 요소와 단서는 그대로다(결정 0032의 한계, 0034).
function dropWidthVariable(page: Page) {
  return page.evaluate(() => {
    const rules = document.createElement('style');
    rules.textContent = '.column { max-width: 808px; }';
    document.head.append(rules);
  });
}

test('GPT-2.6 COM-6.8 결정 0034 로그인한 화면에서 사이트가 열 너비 변수를 쓰지 않으면(요소는 그대로) 15초 뒤 그 기능만 멈춰 되돌리고 팝업에 "적용되지 않음: ChatGPT 대화 열"을 보이며 기록한다', async ({
  context,
  extensionId,
}) => {
  test.setTimeout(90_000);
  const worker = await serviceWorkerOf(context);
  const { page, errors } = await openChatgpt(context, signedIn, '/c/abc');
  await dropWidthVariable(page);
  const before = await documentWithoutExtension(page);

  const first = await popupOn(context, extensionId, page);
  const enabledAt = Date.now();
  await first.feature.check();
  await first.popup.close();
  // 스타일은 걸렸지만 대화 열과 작성란의 너비는 그대로다.
  await expect
    .poll(() =>
      page.evaluate(
        (attribute) => document.querySelector(`style[${attribute}]`) !== null,
        pageElementAttribute,
      ),
    )
    .toBe(true);
  expect(await widths(page, signedIn)).toEqual(signedIn.original);

  await expect
    .poll(() => problemRecords(worker), { timeout: elementTimeoutMs + 10_000 })
    .toEqual([
      {
        featureId: 'chatgpt-width',
        kind: 'not-applied',
        element: { id: 'chatgpt.thread', name: 'ChatGPT 대화 열' },
        at: expect.any(Number),
      },
    ]);
  const [record] = await problemRecords(worker);
  const at = typeof record === 'object' && record !== null && 'at' in record ? record.at : null;
  expect(typeof at === 'number' && at >= enabledAt + elementTimeoutMs - 100).toBe(true);
  // 그 기능이 바꾼 것은 모두 되돌려졌다.
  expect(await documentWithoutExtension(page)).toBe(before);
  expect(await widths(page, signedIn)).toEqual(signedIn.original);
  const shown = await popupOn(context, extensionId, page);
  await expect(shown.reason).toHaveText('적용되지 않음: ChatGPT 대화 열');
  await expect(shown.feature).toBeChecked();
  await shown.popup.close();
  expect(errors).toEqual([]);
});

test('GPT-2.3 COM-6.8 결정 0034 너비 규칙이 작용하면 두 화면 모두 넓은 창이든 정한 너비보다 좁은 창이든 15초가 지나도 적용되지 않음이 되지 않는다', async ({
  context,
  extensionId,
}) => {
  test.setTimeout(90_000);
  const worker = await serviceWorkerOf(context);
  // 한 번의 15초로 네 경우를 함께 본다. 주소로 화면을 가른다(로그인하지 않은 화면의 대화는 /uc/, 로그인한 화면은 /c/).
  const bodies = { signedOut: fixtureOf(signedOut), signedIn: fixtureOf(signedIn) };
  await context.route('https://chatgpt.com/**', (route) => {
    const { pathname } = new URL(route.request().url());
    const body = pathname.startsWith('/uc/') ? bodies.signedOut : bodies.signedIn;
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
  });
  const cases = [
    {
      shell: signedOut,
      pathname: '/uc/wide',
      viewport: wide,
      expected: { thread: 1200, composer: 1200 },
    },
    { shell: signedOut, pathname: '/uc/narrow', viewport: narrow, expected: signedOut.narrow },
    {
      shell: signedIn,
      pathname: '/c/wide',
      viewport: wide,
      expected: { thread: 1200, composer: 1200 },
    },
    { shell: signedIn, pathname: '/c/narrow', viewport: narrow, expected: signedIn.narrow },
  ];
  const opened: ((typeof cases)[number] & { readonly page: Page })[] = [];
  for (const entry of cases) {
    const page = await context.newPage();
    await page.setViewportSize(entry.viewport);
    await page.goto(`https://chatgpt.com${entry.pathname}`);
    opened.push({ ...entry, page });
  }
  const [first] = opened;
  if (first === undefined) throw new Error('연 탭이 없다.');
  const { popup, feature } = await popupOn(context, extensionId, first.page);
  await feature.check();
  await popup.close();
  for (const { page, shell, expected } of opened) {
    await expect.poll(() => widths(page, shell)).toEqual(expected);
  }
  await first.page.waitForTimeout(elementTimeoutMs + 3000);
  expect(await problemRecords(worker)).toEqual([]);
  for (const { page, shell, expected } of opened) {
    expect(await widths(page, shell)).toEqual(expected);
  }
});

test('COM-6 기대 동작 4 결정 0033 대화 열을 찾지 못해 멈춘 뒤(15초가 지난 뒤) 새 대화로 가면 그 화면에 있어야 할 작성란만 찾아 너비가 돌아오고 찾지 못함이 없어진다', async ({
  context,
  extensionId,
}) => {
  test.setTimeout(120_000);
  const worker = await serviceWorkerOf(context);
  const { page, errors } = await openChatgpt(context, signedOut, '/c/abc');
  await removeThread(page, signedOut);
  const enabled = await popupOn(context, extensionId, page);
  await enabled.feature.check();
  await enabled.popup.close();
  await expect.poll(() => widths(page, signedOut)).toEqual({ thread: null, composer: 1200 });
  await expect
    .poll(() => problemRecords(worker), { timeout: elementTimeoutMs + 10_000 })
    .toHaveLength(1);
  // 찾지 못해 기능이 멈췄다(작성란도 원래 너비).
  expect(await widths(page, signedOut)).toEqual({ thread: null, composer: 768 });

  await navigateInPage(page, signedOut, '/');
  await expect.poll(() => widths(page, signedOut)).toEqual({ thread: null, composer: 1200 });
  const moved = await popupOn(context, extensionId, page);
  await expect(moved.reason).toHaveCount(0);
  await moved.popup.close();
  // 새 대화 화면에서 15초가 넘도록 기다려도 앞 화면의 대화 열을 찾지 못함으로 다시 알리지 않는다.
  await page.waitForTimeout(elementTimeoutMs + 3000);
  expect(await problemRecords(worker)).toHaveLength(1);
  expect(await widths(page, signedOut)).toEqual({ thread: null, composer: 1200 });
  expect(errors).toEqual([]);
});

test('GPT-2.2 GPT-2.5 COM-6.1 결정 0035 로그인한 화면에서 기존 대화를 오가며 앞 화면이 숨은 채 남아도, 새 화면의 대화 열이 단서에 맞으면 15초가 지나도 기록이 없고 맞지 않으면 15초 뒤 그 기능만 멈춰 되돌리고 찾지 못함으로 기록한다', async ({
  context,
  extensionId,
}) => {
  test.setTimeout(120_000);
  const worker = await serviceWorkerOf(context);
  const { page, errors } = await openChatgpt(context, signedIn, '/c/abc');
  const enabled = await popupOn(context, extensionId, page);
  await enabled.feature.check();
  await enabled.popup.close();
  await expect.poll(() => widths(page, signedIn)).toEqual({ thread: 1200, composer: 1200 });

  await navigateInPage(page, signedIn, '/c/def');
  await page.waitForTimeout(elementTimeoutMs + 3000);
  expect(await problemRecords(worker)).toEqual([]);
  expect(await widths(page, signedIn)).toEqual({ thread: 1200, composer: 1200 });

  // 사이트가 새 화면의 대화 열을 바꿔 단서에 맞지 않는다. 이동 신호를 받은 때에는 앞 화면(/c/def)의 대화 열이 아직 보인다.
  await navigateInPage(page, signedIn, '/c/ghi', { thread: false });
  await expect
    .poll(() => problemRecords(worker), { timeout: elementTimeoutMs + 10_000 })
    .toEqual([
      {
        featureId: 'chatgpt-width',
        kind: 'not-found',
        element: { id: 'chatgpt.thread', name: 'ChatGPT 대화 열' },
        at: expect.any(Number),
      },
    ]);
  expect(await widths(page, signedIn)).toEqual({
    thread: null,
    composer: signedIn.original.composer,
  });
  const missing = await popupOn(context, extensionId, page);
  await expect(missing.reason).toHaveText('찾지 못함: ChatGPT 대화 열');
  await missing.popup.close();
  expect(errors).toEqual([]);
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

  const { page } = await openChatgpt(context, signedOut, '/');
  const here = await popupOn(context, extensionId, page);
  await expect(here.reason).toHaveCount(0);
});
