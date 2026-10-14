import type { Frame } from '@playwright/test';
import { connectBrowserCdp } from './support/browser-cdp.ts';
import {
  distPath,
  expect,
  fixtureOrigin,
  hostCount,
  indicatorTexts,
  insecureFixtureOrigin,
  openPopup,
  test,
} from './support/extension.ts';

// 확장을 다시 불러온 뒤 열린 탭의 옛 스크립트(결정 0008, N-13).
// 사용자가 "다시 로드"를 누르는 것과 같은 일을 CDP Extensions.loadUnpacked로 한다(R-04).
// 새 판이 프레임에 넣는 정리 함수는 그 페이지의 문맥에서 돈다. 일반 http 페이지는 보안 문맥이 아니라
// 보안 문맥에서만 있는 API가 없으므로, 루프백 출처(보안 문맥)와 일반 http 출처에서 같은 일을 확인한다.

test.use({ browserDebugging: true });

const origins = [
  { label: '루프백 출처(보안 문맥)', origin: fixtureOrigin, secure: true },
  { label: '일반 http 출처(보안 문맥 아님)', origin: insecureFixtureOrigin, secure: false },
];

for (const { label, origin, secure } of origins) {
  test(`COM-7.1 COM-7.2 ${label}: 확장을 다시 불러오면 영상은 2배 그대로이고, 옛 스크립트가 더한 표시창이 남지 않는다`, async ({
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
    await page.goto(`${origin}/video.html`);
    const childFrame = page.frames().find((frame) => frame.url().includes('video-only'));
    if (childFrame === undefined) throw new Error('iframe을 찾지 못했다.');
    const frames: readonly Frame[] = [page.mainFrame(), childFrame];
    // 이 시험이 보려는 문맥인지 먼저 확인한다. iframe은 조상이 보안 문맥이 아니면 보안 문맥이 아니다.
    for (const frame of frames) {
      expect(await frame.evaluate(() => isSecureContext)).toBe(secure);
    }
    // 새 버전이 보낸 물러남 이벤트가 각 문서에 닿는지 페이지 쪽에서 센다(결정 0008의 주된 방법).
    for (const frame of frames) {
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
    // 다시 로드 뒤 코드가 더 돌지 않는 옛 세계가 남긴 요소를 흉내 낸다(결정 0008 고친 기록, 드러난 것 1).
    // 그런 세계는 iframe에서 자주 생기지만 늘 생기지는 않는다. 이 요소는 새 판의 정리 함수만 지울 수 있다.
    for (const frame of frames) {
      await frame.evaluate(() => {
        const stale = document.createElement('browser-toolbox-ui');
        stale.setAttribute('data-browser-toolbox', 'stale');
        document.documentElement.append(stale);
      });
      expect(await hostCount(frame)).toBe(2);
    }

    const cdp = await connectBrowserCdp(profileDirectory);
    try {
      const result = await cdp.send('Extensions.loadUnpacked', { path: distPath });
      expect(result).toEqual({ id: extensionId });
    } finally {
      cdp.close();
    }

    for (const frame of frames) {
      await expect
        .poll(() => frame.evaluate(() => document.documentElement.dataset['retireEvents']))
        .not.toBe('0');
      await expect.poll(() => hostCount(frame)).toBe(0);
    }
    expect(await page.evaluate(() => document.querySelector('video')?.playbackRate)).toBe(2);
    expect(pageErrors).toEqual([]);
  });
}
