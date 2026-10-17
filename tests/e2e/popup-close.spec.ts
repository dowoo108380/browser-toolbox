import { expect, openPopup, test, watchServiceWorker } from './support/extension.ts';

// N-12: 팝업은 초점을 잃으면 닫힌다. 서비스 워커가 깨어나는 중에 팝업이 요청을 보내고 곧바로 닫히면
// 요청이 닿지 않았다(05단계 확인: 잠든 서비스 워커에서 20번 중 19번). 팝업은 열릴 때 서비스 워커를 깨우고,
// 그 응답을 받기 전에는 스위치를 쓸 수 없게 한다(Playwright는 쓸 수 있게 된 뒤에 누른다).
// 팝업을 30초 넘게 열어 두는 경우는 Playwright가 서비스 워커에 붙어 있어 잠들지 않으므로 여기서 재현하지 못한다(R-23).

test('N-12 서비스 워커가 잠든 뒤 팝업을 열어 스위치를 누르자마자 닫혀도 설정이 저장된다', async ({
  context,
  extensionId,
}) => {
  const first = context.serviceWorkers()[0];
  if (first === undefined) throw new Error('서비스 워커가 없다.');
  await expect
    .poll(() => first.evaluate(() => chrome.storage.local.get('settings')))
    .toMatchObject({ settings: { version: 1 } });

  // 서비스 워커를 멈춰 Chrome이 쉬는 서비스 워커를 멈춘 상태를 만든다.
  await (await watchServiceWorker(await context.newPage())).stop();

  const popup = await openPopup(context, extensionId);
  const toggle = popup.getByRole('switch', { name: '미디어 배속' });
  await expect(toggle).toBeVisible();
  // 누른 뒤 응답을 기다리지 않고 닫는다.
  await toggle.click({ noWaitAfter: true });
  await popup.close();

  const check = await openPopup(context, extensionId);
  await expect
    .poll(() => check.evaluate(() => chrome.storage.local.get('settings')))
    .toMatchObject({ settings: { features: { 'media-speed': { enabled: true } } } });
});
