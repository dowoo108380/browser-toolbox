import {
  expect,
  fixtureOrigin,
  openPopup,
  openPopupOn,
  serviceWorkerOf,
  tabStatusOf,
  test,
} from './support/extension.ts';

// COM-2.3: 지금 탭에서 쓸 수 없는 기능은 이유를 보인다(결정 0023). 서비스 워커는 그 탭의 최상위 문서에 탐침을 넣어
// 이 확장의 실행 틀이 도는지 본다. 팝업 문서는 그 페이지가 있는 창의 뒤쪽 탭으로 열어 그 페이지를 지금 탭으로 보게
// 한다(실제 팝업과 같다). 새로 고쳐야 쓸 수 있는 탭(COM-7 기대 동작 2)은 확장을 다시 불러오는 시험(reload.spec.ts)이 본다.

test('COM-2.3 Chrome 내부 페이지(chrome://extensions)에서 팝업을 열면 페이지에 작용하는 기능에 쓸 수 없는 이유가 보이고, 스위치는 그대로 쓸 수 있다', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto('chrome://extensions');
  const popup = await openPopupOn(context, extensionId, page);
  const toggle = popup.getByRole('switch', { name: '미디어 배속' });
  await expect(popup.getByText('쓸 수 없음: 확장이 이 페이지에 접근할 수 없음')).toBeVisible();
  await expect(toggle).toHaveAccessibleDescription(/쓸 수 없음: 확장이 이 페이지에 접근할 수 없음/);

  // 켜고 끄기는 지금 탭이 아니라 모든 탭에 대한 설정이라 막지 않는다.
  await toggle.check();
  const worker = await serviceWorkerOf(context);
  await expect
    .poll(() => worker.evaluate(() => chrome.storage.local.get('settings')))
    .toMatchObject({ settings: { features: { 'media-speed': { enabled: true } } } });
  // 알려진 거절이라 문제로 기록하지 않는다.
  expect(await worker.evaluate(() => chrome.storage.local.get('problems'))).toEqual({});
});

test('결정 0023 탐침은 실행 틀이 도는 페이지를 ready로, 확장이 접근할 수 없는 페이지를 denied로 답한다', async ({
  context,
  extensionId,
}) => {
  const fixture = await context.newPage();
  await fixture.goto(`${fixtureOrigin}/blank.html`);
  const internal = await context.newPage();
  await internal.goto('chrome://extensions');
  const popup = await openPopup(context, extensionId);
  expect(await tabStatusOf(popup, fixture)).toEqual({
    ok: true,
    value: { page: 'ready', bundle: 'common', unmet: [] },
  });
  expect(await tabStatusOf(popup, internal)).toEqual({ ok: true, value: { page: 'denied' } });
  // 이 확장의 페이지(그 팝업 문서 자신)에도 넣을 수 없다.
  expect(await tabStatusOf(popup, popup)).toEqual({ ok: true, value: { page: 'denied' } });
});
