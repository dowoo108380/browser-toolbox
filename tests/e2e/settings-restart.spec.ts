import type { Worker } from '@playwright/test';
import {
  expect,
  fixtureOrigin,
  hostCount,
  indicatorTexts,
  launchWithExtension,
  openPopup,
  serviceWorkerOf,
  test,
} from './support/extension.ts';

// COM-3.1: 설정은 바꾸는 즉시 저장되고 브라우저를 다시 시작해도 남는다(COM-3 기대 동작 1). 팝업으로 바꾼 뒤 브라우저를
// 정상으로 닫고 같은 프로필로 다시 띄운다. 저장된 설정이 그대로이고(다시 시작한 서비스 워커가 고쳐 쓰지 않음), 팝업과
// 새로 연 페이지가 바꾼 값대로 동작하는지 본다. 쓰는 도중 강제로 끝나는 경우는 N-15 시험(settings-atomicity)이 본다.

test('COM-3.1 팝업에서 바꾼 설정이 브라우저를 다시 시작한 뒤에도 남아 팝업과 새 페이지에 그대로 쓰인다', async ({
  context,
  extensionId,
  profileDirectory,
}) => {
  const readSettings = async (worker: Worker) => {
    const items: Record<string, unknown> = await worker.evaluate(() =>
      chrome.storage.local.get('settings'),
    );
    return items['settings'];
  };
  const first = await serviceWorkerOf(context);
  await expect.poll(() => readSettings(first)).toMatchObject({ version: 1 });

  const popup = await openPopup(context, extensionId);
  await popup.getByRole('switch', { name: '미디어 배속' }).check();
  await expect
    .poll(() => readSettings(first))
    .toMatchObject({ features: { 'media-speed': { enabled: true } } });
  const saved = await readSettings(first);
  await context.close();

  const restarted = await launchWithExtension(profileDirectory);
  try {
    const worker = await serviceWorkerOf(restarted);
    // 같은 확장(같은 폴더에서 불러와 id가 같다)의 같은 저장소다.
    expect(new URL(worker.url()).host).toBe(extensionId);
    const again = await openPopup(restarted, extensionId);
    const toggle = again.getByRole('switch', { name: '미디어 배속' });
    // 첫 깨우기의 응답을 받은 뒤에 본다. 그때는 서비스 워커가 시작할 때의 준비도 끝났다(준비는 한 줄에서 차례로 한다).
    await expect(toggle).toBeEnabled();
    await expect(toggle).toBeChecked();
    expect(await readSettings(worker)).toEqual(saved);

    const page = await restarted.newPage();
    await page.goto(`${fixtureOrigin}/video.html`);
    await expect.poll(() => hostCount(page)).toBe(1);
    await expect.poll(() => indicatorTexts(page)).toEqual(['1×', '1×']);
  } finally {
    await restarted.close();
  }
});
