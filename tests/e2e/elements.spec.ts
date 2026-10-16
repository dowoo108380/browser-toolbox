import type { BrowserContext, Page, Worker } from '@playwright/test';
import { elementTimeoutMs, pageElementAttribute } from '../../src/dom/index.ts';
import {
  appliedAttribute,
  fixtureElementFeature,
  fixtureTarget,
  waitingAttribute,
} from '../extension/fixture-elements.ts';
import {
  expect,
  fixtureOrigin,
  indicatorTexts,
  openPopupOn,
  serviceWorkerOf,
  test,
} from './support/extension.ts';

// COM-6 외부 화면 변경 드러내기(결정 0026)를 실제 Chromium에서 본다. 제품에는 아직 외부 사이트 기능이 없어 시험 빌드
// (결정 0025)의 "시험 요소 기능"(시험 페이지의 "시험 대상 영역"에 기댐)을 쓴다. 찾기 시작한 때부터의 15초는 실제로
// 기다린다. 5분(COM-6.6)과 숨겨진 1분(COM-6.7), 켠 때부터 셈(COM-6.5)은 가짜 시계로 실행 틀의 DOM 시험
// (src/page/runtime.dom.test.ts)에서 본다.

test.use({ extensionBuild: 'fixture' });

const targetSelector = '[role="region"][aria-label="시험 대상 영역"]';

// 확장이 페이지에 넣은 요소(배속 표시창 등)를 뺀 문서. 찾지 못한 기능이 되돌린 뒤 켜기 전과 같은지 본다.
function documentWithoutExtension(page: Page): Promise<string> {
  return page.evaluate((attribute) => {
    const copy = document.documentElement.cloneNode(true);
    if (!(copy instanceof Element)) throw new Error('문서 루트를 복제하지 못했다.');
    for (const element of copy.querySelectorAll(`[${attribute}]`)) element.remove();
    return copy.outerHTML;
  }, pageElementAttribute);
}

function problems(worker: Worker): Promise<unknown[]> {
  return worker.evaluate(async () => {
    const { problems: records }: Record<string, unknown> =
      await chrome.storage.local.get('problems');
    const list: unknown[] = Array.isArray(records) ? records : [];
    return list;
  });
}

// page를 지금 탭으로 둔 팝업에서 그 범주의 스위치를 고른다.
async function switchOn(popup: Page, category: string, name: string) {
  await popup.getByRole('tab', { name: category }).click();
  return popup.getByRole('switch', { name });
}

async function popupOn(context: BrowserContext, extensionId: string, page: Page) {
  const popup = await openPopupOn(context, extensionId, page);
  const feature = await switchOn(popup, '페이지', fixtureElementFeature.name);
  await expect(feature).toBeEnabled();
  return {
    popup,
    feature,
    reason: popup.locator(`#feature-unavailable-${fixtureElementFeature.id}`),
  };
}

test('COM-6.1 COM-6.2 COM-6.3 COM-6.4 대상 요소가 없으면 15초 뒤 그 기능만 멈춰 되돌리고 팝업에 찾지 못함과 요소 이름을 보이며 기록하고, 나중에 나타나면 작용해 그 표시가 사라진다', async ({
  context,
  extensionId,
}) => {
  test.setTimeout(90_000);
  const worker = await serviceWorkerOf(context);
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  await page.goto(`${fixtureOrigin}/elements.html`);
  // 외부 사이트가 화면을 바꿔 기능이 기대는 요소가 없어졌다.
  await page.evaluate((selector) => document.querySelector(selector)?.remove(), targetSelector);
  const before = await documentWithoutExtension(page);

  const first = await popupOn(context, extensionId, page);
  const speed = await switchOn(first.popup, '미디어', '미디어 배속');
  await speed.check();
  await first.popup.getByRole('tab', { name: '페이지' }).click();
  const enabledAt = Date.now();
  await first.feature.check();
  await first.popup.close();
  // 찾기 전에 적용한 변경이 보인다(아직 찾는 중).
  await expect
    .poll(() =>
      page.evaluate((name) => document.documentElement.hasAttribute(name), waitingAttribute),
    )
    .toBe(true);
  await expect.poll(() => indicatorTexts(page)).toEqual(['1×']);

  // COM-6.1 15초 뒤에 찾지 못함이 되어 기록이 남는다(켜자마자가 아니다).
  const expected = {
    featureId: fixtureElementFeature.id,
    kind: 'not-found',
    element: { id: fixtureTarget.id, name: fixtureTarget.name },
  };
  await expect
    .poll(() => problems(worker), { timeout: elementTimeoutMs + 10_000 })
    .toContainEqual(expect.objectContaining(expected));
  const [record, ...others] = await problems(worker);
  expect(others).toEqual([]);
  expect(record).toEqual({ ...expected, at: expect.any(Number) });
  const at = typeof record === 'object' && record !== null && 'at' in record ? record.at : null;
  expect(typeof at === 'number' && at >= enabledAt + elementTimeoutMs - 100).toBe(true);

  // 기능을 켜기 전과 같은 DOM이다(그 기능이 단 것이 모두 되돌려졌다).
  expect(await documentWithoutExtension(page)).toBe(before);
  // 팝업의 그 기능에 찾지 못함과 요소 이름이 보이고, 스위치는 그대로 켜져 있다.
  const missing = await popupOn(context, extensionId, page);
  await expect(missing.reason).toHaveText('찾지 못함: 시험 대상 영역');
  await expect(missing.feature).toBeChecked();
  await missing.popup.close();

  // COM-6.2 같은 페이지의 다른 기능(미디어 배속)은 그대로 돈다.
  await page.evaluate(() => {
    const video = document.querySelector('video');
    if (video !== null) video.playbackRate = 2;
  });
  await expect.poll(() => indicatorTexts(page)).toEqual(['2×']);

  // COM-6.3 대상 요소가 나중에 나타나면 기능이 작용하고, 다시 연 팝업에 찾지 못함 표시가 없다.
  await page.evaluate(() => {
    const region = document.createElement('section');
    region.setAttribute('role', 'region');
    region.setAttribute('aria-label', '시험 대상 영역');
    document.querySelector('main')?.prepend(region);
  });
  await expect
    .poll(() =>
      page.evaluate(
        ([selector, name]) => document.querySelector(selector)?.hasAttribute(name) ?? false,
        [targetSelector, appliedAttribute] as const,
      ),
    )
    .toBe(true);
  const found = await popupOn(context, extensionId, page);
  await expect(found.feature).toBeChecked();
  await expect(found.reason).toHaveCount(0);
  await found.popup.close();
  expect(await problems(worker)).toHaveLength(1);

  // COM-6.4 페이지 콘솔에 확장이 낸 처리되지 않은 오류가 없다.
  expect(pageErrors).toEqual([]);
});
