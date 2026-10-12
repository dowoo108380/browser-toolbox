import { connectBrowserCdp } from './support/browser-cdp.ts';
import {
  distPath,
  expect,
  fixtureOrigin,
  hostCount,
  indicatorTexts,
  openPopup,
  test,
} from './support/extension.ts';

// 확장을 다시 불러온 뒤 열린 탭의 옛 스크립트(결정 0008, N-13).
// 사용자가 "다시 로드"를 누르는 것과 같은 일을 CDP Extensions.loadUnpacked로 한다(R-04).

test.use({ browserDebugging: true });

test('COM-7.1 COM-7.2 확장을 다시 불러오면 영상은 2배 그대로이고, 옛 스크립트가 더한 표시창이 남지 않는다', async ({
  context,
  extensionId,
  profileDirectory,
}) => {
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  await page.goto(`${fixtureOrigin}/video.html`);
  const childFrame = page.frames().find((frame) => frame.url().includes('video-only'));
  if (childFrame === undefined) throw new Error('iframe을 찾지 못했다.');
  // 새 버전이 보낸 물러남 이벤트가 각 문서에 닿는지 페이지 쪽에서 센다(결정 0008의 주된 방법).
  for (const frame of [page.mainFrame(), childFrame]) {
    await frame.evaluate(() => {
      document.documentElement.dataset['retireEvents'] = '0';
      document.addEventListener('browser-toolbox:retire', () => {
        const count = Number(document.documentElement.dataset['retireEvents']);
        document.documentElement.dataset['retireEvents'] = String(count + 1);
      });
    });
  }

  const popup = await openPopup(context, extensionId);
  await popup.getByRole('switch', { name: '미디어 배속' }).check();
  await expect.poll(() => indicatorTexts(page)).toEqual(['1×', '1×']);
  await page.evaluate(() => {
    const video = document.querySelector('video');
    if (video) video.playbackRate = 2;
  });
  await expect.poll(() => indicatorTexts(page)).toEqual(['1×', '2×']);

  const cdp = await connectBrowserCdp(profileDirectory);
  try {
    const result = await cdp.send('Extensions.loadUnpacked', { path: distPath });
    expect(result).toEqual({ id: extensionId });
  } finally {
    cdp.close();
  }

  for (const frame of [page.mainFrame(), childFrame]) {
    await expect
      .poll(() => frame.evaluate(() => document.documentElement.dataset['retireEvents']))
      .not.toBe('0');
  }
  await expect.poll(() => hostCount(page)).toBe(0);
  await expect.poll(() => hostCount(childFrame)).toBe(0);
  expect(await page.evaluate(() => document.querySelector('video')?.playbackRate)).toBe(2);
  expect(pageErrors).toEqual([]);
});
