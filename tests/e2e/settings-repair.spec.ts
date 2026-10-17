import { expect, fixtureOrigin, openPopup, test, watchServiceWorker } from './support/extension.ts';

// COM-3.4: 저장소에 해석할 수 없는 항목을 넣고 서비스 워커를 다시 시작하면, 서비스 워커가 그 항목을 기본값으로
// 고쳐 쓰기 전에 복구 알림을 남긴다. 그 뒤에 연 팝업은 고친 값만 읽지만 알림으로 기능 이름과 사이트 이름을 안다
// (결정 0016, 0017). 모르는 기능의 사이트 항목은 손상이 아니라 그대로 남는다.

test('COM-3.4 서비스 워커가 손상 항목(기능, 사이트)을 먼저 고쳐 쓴 뒤 연 팝업에 그 이름이 나오고, 확인하면 다시 열어도 없다', async ({
  context,
  extensionId,
}) => {
  const first = context.serviceWorkers()[0];
  if (first === undefined) throw new Error('서비스 워커가 없다.');
  await expect
    .poll(() => first.evaluate(() => chrome.storage.local.get('settings')))
    .toMatchObject({ settings: { version: 1 } });
  await first.evaluate(async () => {
    await chrome.storage.local.set({
      settings: {
        version: 1,
        revision: 5,
        features: { 'media-speed': { enabled: 'no' } },
        // 사이트 값이 객체가 아니면 그 사이트 전체가 손상이다. 모르는 기능의 사이트 항목은 손상이 아니다.
        sites: { 'broken.test': 5, 'kept.test': { 'future-feature': { mode: 1 } } },
      },
    });
  });

  // 서비스 워커를 멈춘 뒤, 페이지를 열어 다시 시작하게 한다. 콘텐츠 스크립트가 손상을 보고 고쳐 쓰기를 부탁하고,
  // 서비스 워커도 시작하면서 고친다. 팝업은 그 뒤에 연다.
  const page = await context.newPage();
  await (await watchServiceWorker(page)).stop();
  await page.goto(`${fixtureOrigin}/blank.html`);
  await expect
    .poll(async () => {
      const worker = context.serviceWorkers().at(-1);
      if (worker === undefined) return null;
      return worker
        .evaluate(async () => {
          const items = await chrome.storage.local.get(['settings', 'repairNotice']);
          const settings: unknown = items['settings'];
          const notice: unknown = items['repairNotice'];
          const part = (name: string): unknown => {
            if (typeof settings !== 'object' || settings === null) return null;
            const value: unknown = Reflect.get(settings, name);
            return value ?? null;
          };
          const features = part('features');
          return {
            features:
              typeof features === 'object' && features !== null ? Object.keys(features) : null,
            sites: part('sites'),
            notice,
          };
        })
        .catch(() => null);
    })
    .toEqual({
      features: [],
      sites: { 'kept.test': { 'future-feature': { mode: 1 } } },
      notice: expect.objectContaining({
        whole: false,
        features: ['media-speed'],
        sites: [{ host: 'broken.test', featureId: null }],
      }),
    });

  const popup = await openPopup(context, extensionId);
  const repair = popup.getByRole('region', { name: '설정 복구 알림' });
  await expect(repair).toContainText('기본값으로 바꿨다: 미디어 배속.');
  await expect(repair).toContainText('기본값으로 바꿨다: broken.test.');
  await expect(repair).not.toContainText('kept.test');
  const toggle = popup.getByRole('switch', { name: '미디어 배속' });
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
  await repair.getByRole('button', { name: '확인' }).click();
  await expect(repair).toHaveCount(0);
  await expect
    .poll(() => popup.evaluate(() => chrome.storage.local.get('repairNotice')))
    .toMatchObject({ repairNotice: { whole: false, features: [], sites: [] } });
  await popup.close();

  const again = await openPopup(context, extensionId);
  await expect(again.getByRole('switch', { name: '미디어 배속' })).toBeEnabled();
  await expect(again.getByRole('region', { name: '설정 복구 알림' })).toHaveCount(0);
});
