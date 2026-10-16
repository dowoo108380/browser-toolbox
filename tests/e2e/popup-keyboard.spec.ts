import { features } from '../../src/features/list.ts';
import { expect, fixtureOrigin, hostCount, openPopupOn, test } from './support/extension.ts';

// COM-2.5: 마우스 없이 키보드만으로 모든 기능을 켜고 끄고 실행할 수 있다(COM-2 기대 동작 6, quality 022). 실제 확장의
// 팝업에서 Tab과 방향키로 모든 범주를 지나며 범주마다 기능의 조작 요소에 가서 Space로 켜고 끈다. 지금 기능은 모두
// "켜고 끄기" 종류다. 실행 종류가 생기면 그 단추도 여기서 Enter로 실행한다.

test('COM-2.5 키보드만으로 팝업의 모든 기능을 켜고 끈다', async ({ context, extensionId }) => {
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

  const toggled: string[] = [];
  for (let category = 0; category < categories; category += 1) {
    const switches = popup.getByRole('tabpanel').getByRole('switch');
    const count = await switches.count();
    for (let index = 0; index < count; index += 1) {
      const target = switches.nth(index);
      // 범주 목록에서 Tab을 index+1번 누르면 그 범주의 index번째 조작 요소다(기능 항목마다 스위치 하나).
      await popup.keyboard.press('Tab');
      await expect(target).toBeFocused();
      await popup.keyboard.press('Space');
      await expect(target).toBeChecked();
      await popup.keyboard.press('Space');
      await expect(target).not.toBeChecked();
      toggled.push((await target.getAttribute('data-feature')) ?? '');
    }
    // 범주 목록으로 돌아가 다음 범주로 간다.
    for (let back = 0; back < count; back += 1) await popup.keyboard.press('Shift+Tab');
    await expect(tabs.nth(category)).toBeFocused();
    await popup.keyboard.press('ArrowDown');
  }
  // 모든 범주를 지나며 기능 목록의 모든 기능을 한 번씩 켜고 껐다(지금 기능 정의의 종류는 켜고 끄기뿐이다).
  expect(toggled.sort()).toEqual(features.map((feature) => feature.id).sort());

  // 켜기가 실제로 페이지에 작용하는지 한 번 본다(미디어 배속의 표시창).
  await popup.keyboard.press('Control+KeyK');
  await popup.keyboard.type('배속');
  await popup.keyboard.press('Enter');
  // 초점은 그 기능 항목을 그린 뒤에 옮겨진다.
  await expect(popup.getByRole('switch', { name: '미디어 배속' })).toBeFocused();
  await popup.keyboard.press('Space');
  await expect.poll(() => hostCount(page)).toBe(1);
});
