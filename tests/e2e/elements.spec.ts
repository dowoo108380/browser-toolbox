import type { BrowserContext, Frame, Page } from '@playwright/test';
import { elementTimeoutMs } from '../../src/dom/index.ts';
import {
  appliedAttribute,
  fixtureElementFeature,
  fixtureTarget,
  waitingAttribute,
} from '../extension/fixture-elements.ts';
import {
  documentWithoutExtension,
  expect,
  fixtureOrigin,
  indicatorTexts,
  openPopupOn,
  problemRecords as problems,
  serviceWorkerOf,
  test,
} from './support/extension.ts';

// COM-6 외부 화면 변경 드러내기(결정 0026)를 실제 Chromium에서 본다. 제품에는 아직 외부 사이트 기능이 없어 시험 빌드
// (결정 0025)의 "시험 요소 기능"(시험 페이지의 "시험 대상 영역"에 기댐)을 쓴다. 찾기 시작한 때부터의 15초는 실제로
// 기다린다. 5분(COM-6.6)과 숨겨진 1분(COM-6.7), 켠 때부터 셈(COM-6.5)은 가짜 시계로 실행 틀의 DOM 시험
// (src/page/runtime.dom.test.ts)에서 본다. 시험 요소 기능은 최상위에서만 작용한다고 정의되어 있어, 기능 정의의 프레임
// 범위도 여기서 본다.

test.use({ extensionBuild: 'fixture' });

const targetSelector = '[role="region"][aria-label="시험 대상 영역"]';

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

test('결정 0004 최상위에서만 작용하는 기능(시험 요소 기능)은 iframe에서 시작하지 않고, 모든 프레임에서 작용하는 기능(미디어 배속)은 두 프레임에서 작용한다', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  // 최상위에는 시험 대상 영역과 영상이, iframe에는 영상만 있다.
  await page.goto(`${fixtureOrigin}/elements-frames.html`);
  const child = page.frames().find((frame) => frame !== page.mainFrame());
  if (child === undefined) throw new Error('iframe이 없다.');
  const hasWaiting = (frame: Frame) =>
    frame.evaluate((name) => document.documentElement.hasAttribute(name), waitingAttribute);

  const { popup, feature } = await popupOn(context, extensionId, page);
  await feature.check();
  // 최상위에서 대상 영역을 찾아 작용한다.
  await expect
    .poll(() =>
      page.evaluate(
        ([selector, name]) => document.querySelector(selector)?.hasAttribute(name) ?? false,
        [targetSelector, appliedAttribute] as const,
      ),
    )
    .toBe(true);
  expect(await hasWaiting(page.mainFrame())).toBe(true);
  // 그 설정이 저장된 뒤에 미디어 배속을 켠다. 그래서 iframe에 배속 표시창이 뜬 때는 그 프레임의 실행 틀이 시험 요소
  // 기능도 켜진 설정을 적용한 뒤다(서비스 워커는 저장된 설정에 바뀐 것만 덧씌워 쓴다).
  const speed = await switchOn(popup, '미디어', '미디어 배속');
  await speed.check();
  await popup.close();
  await expect.poll(() => indicatorTexts(page)).toEqual(['1×', '1×']);
  // iframe 문서에는 시험 요소 기능이 시작하며 다는 표시가 없다(시작했다면 대상이 없어 15초 뒤 찾지 못함도 기록한다).
  expect(await hasWaiting(child)).toBe(false);
});
