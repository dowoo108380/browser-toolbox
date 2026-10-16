import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, fixtureOrigin, openPopupOn, serviceWorkerOf, test } from './support/extension.ts';

// quality 023·024: 확장 화면의 조작 요소에 역할·이름·상태가 있고, 자동 접근성 검사(axe)에서 WCAG 2.2 AA 위반이 없다
// (명도 대비 포함). 실제 확장의 팝업(빌드한 CSS)을 팝업이 보일 수 있는 여러 상태와 밝은·어두운 테마에서 본다.
// 스크린 리더로 직접 확인하는 것은 하지 않는다(사용자, 2026-10-12).

const wcag = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

// 밝은 테마와 어두운 테마에서 위반이 없는지 본다. 위반이 있으면 규칙과 요소를 보인다.
async function expectNoViolations(popup: Page, state: string) {
  for (const colorScheme of ['light', 'dark'] as const) {
    await popup.emulateMedia({ colorScheme });
    const { violations } = await new AxeBuilder({ page: popup }).withTags(wcag).analyze();
    const found = violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map((node) => node.target.join(' ')),
    }));
    expect(found, `${state}, ${colorScheme}`).toEqual([]);
  }
}

test('quality 023 024 팝업은 범주·기능 항목·쓸 수 없는 이유·검색 결과·결과 없음·복구 알림을 보일 때 접근성 위반이 없다', async ({
  context,
  extensionId,
}) => {
  // 미디어 배속의 저장된 값이 틀려 팝업이 복구 알림을 보이게 한다(결정 0016).
  const worker = await serviceWorkerOf(context);
  await expect
    .poll(() => worker.evaluate(() => chrome.storage.local.get('settings')))
    .toMatchObject({ settings: { version: 1 } });
  await worker.evaluate(async () => {
    const { settings }: Record<string, unknown> = await chrome.storage.local.get('settings');
    if (typeof settings !== 'object' || settings === null) throw new Error('설정이 없다.');
    await chrome.storage.local.set({
      settings: { ...settings, features: { 'media-speed': { enabled: 'no' } } },
    });
  });

  const internal = await context.newPage();
  await internal.goto('chrome://extensions');
  const popup = await openPopupOn(context, extensionId, internal);
  await expect(popup.getByText('쓸 수 없음: 확장이 이 페이지에 접근할 수 없음')).toBeVisible();
  await expect(popup.getByRole('region', { name: '설정 복구 알림' })).toBeVisible();
  await expect(popup.getByRole('switch', { name: '미디어 배속' })).toBeEnabled();
  await expectNoViolations(popup, '범주, 쓸 수 없는 이유, 복구 알림');

  await popup.keyboard.press('Control+KeyK');
  await popup.keyboard.type('배속');
  await popup.keyboard.press('ArrowDown');
  await expect(popup.getByRole('option', { selected: true })).toBeVisible();
  await expectNoViolations(popup, '검색 결과');

  await popup.keyboard.press('Escape');
  await popup.keyboard.type('없는 기능');
  await expect(popup.getByText('맞는 기능이 없다.')).toBeVisible();
  await expectNoViolations(popup, '결과 없음');

  const fixture = await context.newPage();
  await fixture.goto(`${fixtureOrigin}/blank.html`);
  const ready = await openPopupOn(context, extensionId, fixture);
  await expect(ready.getByRole('switch', { name: '미디어 배속' })).toBeEnabled();
  await expectNoViolations(ready, '쓸 수 있는 탭');
});
