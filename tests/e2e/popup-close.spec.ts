import { expect, openPopup, test } from './support/extension.ts';

// N-12: 팝업은 초점을 잃으면 닫힌다. 서비스 워커가 깨어나는 중에 팝업이 요청을 보내고 곧바로 닫히면
// 요청이 닿지 않았다(05단계 확인: 잠든 서비스 워커에서 20번 중 19번). 팝업이 열릴 때 서비스 워커를 깨워 막는다.

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
  const helper = await context.newPage();
  const session = await context.newCDPSession(helper);
  const statuses: string[] = [];
  session.on('ServiceWorker.workerVersionUpdated', (event) => {
    for (const version of event.versions) statuses.push(version.runningStatus);
  });
  await session.send('ServiceWorker.enable');
  await session.send('ServiceWorker.stopAllWorkers');
  await expect.poll(() => statuses.at(-1)).toBe('stopped');

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
