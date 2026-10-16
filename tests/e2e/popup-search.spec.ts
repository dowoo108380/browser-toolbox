import { expect, openPopup, test } from './support/extension.ts';

// COM-2.1: 실제 확장의 팝업에서 키보드만으로 기능을 찾아 그 기능으로 간다(결정 0023). 기능은 실제 기능 목록(지금은
// 미디어 배속 하나)이고, 키는 Playwright가 Chromium에 보내는 실제 키 입력이다.

test('COM-2.1 팝업에서 Ctrl+K를 누르면 검색 칸에 초점이 가고, "배속"을 넣으면 맞는 기능만 보이며, Enter를 누르면 그 기능의 스위치로 간다', async ({
  context,
  extensionId,
}) => {
  const popup = await openPopup(context, extensionId);
  const toggle = popup.getByRole('switch', { name: '미디어 배속' });
  await expect(toggle).toBeEnabled();

  await popup.keyboard.press('Control+KeyK');
  const search = popup.getByRole('combobox', { name: '기능 검색' });
  await expect(search).toBeFocused();

  // 맞는 것이 없으면 그렇다고 보인다.
  await popup.keyboard.type('자막');
  await expect(popup.getByText('맞는 기능이 없다.')).toBeVisible();
  await popup.keyboard.press('Escape');
  await expect(search).toHaveValue('');
  await expect(toggle).toBeVisible();

  await popup.keyboard.type('배속');
  await expect(popup.getByRole('option')).toHaveText([/^미디어 배속/]);
  await expect(toggle).toBeHidden();
  await popup.keyboard.press('Enter');
  await expect(search).toHaveValue('');
  await expect(popup.getByRole('tab', { name: '미디어', selected: true })).toBeVisible();
  await expect(toggle).toBeFocused();
});
