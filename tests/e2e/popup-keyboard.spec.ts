import { features } from '../../src/features/list.ts';
import { expect, fixtureOrigin, hostCount, openPopupOn, test } from './support/extension.ts';

// COM-2.5: 마우스 없이 키보드만으로 모든 기능을 켜고 끄고 실행할 수 있다(COM-2 기대 동작 6, quality 022). 실제 확장의
// 팝업에서 Tab과 방향키로 모든 범주를 지나며 범주마다 기능의 조작 요소에 가서, 스위치는 Space로 켜고 끄고 실행 단추는 Enter로
// 실행한다. 실행 단추는 동작마다 하나다(결정 0046). 캡처(PAGE-1)는 전체 캡처를 끝까지 하고, 영역 캡처는 시작한 뒤 페이지에서
// Esc로 취소한다.

test('COM-2.5 키보드만으로 팝업의 모든 기능을 켜고 끄고 실행한다', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`${fixtureOrigin}/video.html`);
  const popup = await openPopupOn(context, extensionId, page);
  const tabs = popup.getByRole('tab');
  await expect(popup.getByRole('switch').first()).toBeEnabled();
  const categories = await tabs.count();
  expect(categories).toBeGreaterThan(0);

  // Ctrl+K로 검색 칸에 가서 시작한다. Tab으로 범주 목록(고른 범주)에 들어간다.
  await popup.keyboard.press('Control+KeyK');
  await expect(popup.getByRole('combobox', { name: '기능 검색' })).toBeFocused();
  await popup.keyboard.press('Tab');
  await expect(tabs.first()).toBeFocused();

  const task = popup.locator('.task');
  const used = new Set<string>();
  for (let category = 0; category < categories; category += 1) {
    // 기능 항목의 첫 조작 요소들: 켜고 끄는 기능의 스위치, 실행 기능의 동작마다의 단추(차례대로).
    const controls = popup.getByRole('tabpanel').locator('[role=switch], button[data-action]');
    const count = await controls.count();
    for (let index = 0; index < count; index += 1) {
      const target = controls.nth(index);
      // 범주 목록에서 Tab을 index+1번 누르면 그 범주의 index번째 조작 요소다.
      await popup.keyboard.press('Tab');
      await expect(target).toBeFocused();
      const action = await target.getAttribute('data-action');
      if (action === null) {
        await popup.keyboard.press('Space');
        await expect(target).toBeChecked();
        await popup.keyboard.press('Space');
        await expect(target).not.toBeChecked();
        used.add((await target.getAttribute('data-feature')) ?? '');
        continue;
      }
      const name = (await target.textContent()) ?? '';
      await expect(target).not.toHaveAttribute('aria-disabled', 'true');
      await popup.keyboard.press('Enter');
      if (action === 'area') {
        await expect(task).toHaveText(`${name}: 진행 중이다.`);
        // 고르는 화면이 뜬 뒤 페이지에서 Esc로 취소한다.
        await expect(
          page.locator('browser-toolbox-ui[data-browser-toolbox="page-capture-selection"]'),
        ).toHaveCount(1);
        await page.keyboard.press('Escape');
        await expect(task).toHaveText(/^영역 캡처: 취소했다\. /);
      } else {
        await expect(task).toHaveText(new RegExp(`^${name}: 끝났다\\. `), { timeout: 20_000 });
      }
      used.add(`${(await target.getAttribute('data-feature')) ?? ''}:${action}`);
    }
    // 범주 목록으로 돌아가 다음 범주로 간다.
    for (let back = 0; back < count; back += 1) await popup.keyboard.press('Shift+Tab');
    await expect(tabs.nth(category)).toBeFocused();
    await popup.keyboard.press('ArrowDown');
  }
  // 모든 범주를 지나며 기능 목록의 켜고 끄는 기능은 한 번씩 켜고 껐고, 실행 기능은 동작마다 한 번씩 실행했다.
  expect([...used].sort()).toEqual(
    features
      .flatMap((feature) =>
        feature.kind === 'action'
          ? feature.actions.map((choice) => `${feature.id}:${choice.id}`)
          : [feature.id],
      )
      .sort(),
  );

  // 켜기가 실제로 페이지에 작용하는지 한 번 본다(미디어 배속의 표시창).
  await popup.keyboard.press('Control+KeyK');
  await popup.keyboard.type('배속');
  await popup.keyboard.press('Enter');
  // 초점은 그 기능 항목을 그린 뒤에 옮겨진다.
  await expect(popup.getByRole('switch', { name: '미디어 배속' })).toBeFocused();
  await popup.keyboard.press('Space');
  await expect.poll(() => hostCount(page)).toBe(1);
});
