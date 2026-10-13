import { connectBrowserCdp } from './support/browser-cdp.ts';
import {
  distPath,
  expect,
  fixtureOrigin,
  hostCount,
  openPopup,
  test,
} from './support/extension.ts';

// 결정 0008의 보조 방법(N-13): 새 판이 물러남 이벤트를 보내지 못한 채 연결만 끊긴 경우.
// 확장을 지우면(CDP Extensions.uninstall) 새 서비스 워커가 없어 물러남 이벤트가 오지 않는다. 명령줄로 올린 확장은
// 지울 수 없으므로(Chromium: "not an unpacked extension") 먼저 Extensions.loadUnpacked로 다시 올린다.
// 다시 올린 판도 열린 탭에 물러남 이벤트를 보내고, 그 이벤트를 받은 연결된 실행 틀은 몇 초 동안 다시 확인한다(결정 0008).
// 그 다시 확인이 이 시험을 대신 통과시키지 않게, 그 이벤트가 이 탭을 지나간 뒤 새로 고쳐 새 판의 스크립트로 시작한다.
// 처음 설치 때의 이벤트와 구별하려고 기능을 켜 둔 채 다시 올린다. 다시 올린 판의 이벤트만 옛 표시창을 지운다.

test.use({ browserDebugging: true });

test('COM-7.2 물러남 이벤트 없이 연결만 끊겨도, 페이지 안 이동과 영상 사건에서 옛 스크립트가 물러난다', async ({
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
  const frames = () => {
    const child = page.frames().find((frame) => frame.url().includes('video-only'));
    if (child === undefined) throw new Error('iframe을 찾지 못했다.');
    return [page.mainFrame(), child] as const;
  };
  await page.goto(`${fixtureOrigin}/video.html`);
  const popup = await openPopup(context, extensionId);
  await popup.getByRole('switch', { name: '미디어 배속' }).check();
  await popup.close();
  for (const frame of frames()) await expect.poll(() => hostCount(frame)).toBe(1);

  const cdp = await connectBrowserCdp(profileDirectory);
  try {
    expect(await cdp.send('Extensions.loadUnpacked', { path: distPath })).toEqual({
      id: extensionId,
    });
    for (const frame of frames()) await expect.poll(() => hostCount(frame)).toBe(0);
  } catch (error) {
    cdp.close();
    throw error;
  }

  // 새 판의 스크립트로 다시 시작한다. 설정은 다시 올려도 남는다(COM-7 표).
  await page.reload();
  const [top, child] = frames();
  for (const frame of [top, child]) {
    await expect.poll(() => hostCount(frame)).toBe(1);
    // 이제부터 물러남 이벤트가 오지 않는다는 것을 페이지 쪽에서 센다.
    await frame.evaluate(() => {
      document.documentElement.dataset['retireEvents'] = '0';
      document.addEventListener('browser-toolbox:retire', () => {
        document.documentElement.dataset['retireEvents'] = '1';
      });
    });
  }

  try {
    await cdp.send('Extensions.uninstall', { id: extensionId });
  } finally {
    cdp.close();
  }

  // 계기마다의 확인은 src/page/runtime.dom.test.ts가 따로 본다. 실제 브라우저에서는 지울 때의 다른 사건으로
  // 먼저 알아차릴 수도 있다(정당한 계기다). 여기서는 물러남 이벤트 없이도 옛 스크립트가 남지 않는지 본다.
  // 최상위: 페이지 안에서 이동한다.
  await page.evaluate(() => {
    history.pushState(null, '', '#moved');
  });
  await expect.poll(() => hostCount(top)).toBe(0);

  // iframe: 기능이 반응할 사건(배속 바뀜)이 생긴다.
  await child.evaluate(() => {
    const video = document.querySelector('video');
    if (video) video.playbackRate = 1.5;
  });
  await expect.poll(() => hostCount(child)).toBe(0);

  for (const frame of [top, child]) {
    expect(await frame.evaluate(() => document.documentElement.dataset['retireEvents'])).toBe('0');
  }
  // 배속은 그대로다(COM-7 기대 동작 1).
  expect(await child.evaluate(() => document.querySelector('video')?.playbackRate)).toBe(1.5);
  expect(pageErrors).toEqual([]);
});
