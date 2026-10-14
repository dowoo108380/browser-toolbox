import {
  expect,
  fixtureOrigin,
  hostCount,
  indicatorTexts,
  openPopup,
  test,
} from './support/extension.ts';

// 열린 shadow root 안의 영상(MED 머리말: 모든 프레임의 미디어, 결정 0019).
// 실제 확장의 격리된 세계에서도 페이지가 만든 열린 shadow root를 훑고 관찰하는지 본다.
// 경우마다의 확인은 src/features/media-speed/page.dom.test.ts가 따로 본다.

test('MED-3.1 결정 0019 열린 shadow root 안의 영상에도 실제 배속을 띄우고, 나중에 더한 영상과 지운 영상을 따라간다', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  await page.goto(`${fixtureOrigin}/video-shadow.html`);
  // 영상 플레이어를 사용자 정의 요소로 만든 사이트처럼, 영상을 열린 shadow root 안의 겹친 열린 shadow root 안에 둔다.
  // 기능을 켜기 전에 둔다(처음부터 있는 영상).
  await page.evaluate(() => {
    const player = document.getElementById('player');
    if (player === null) throw new Error('시험 페이지에 #player가 없다.');
    const inner = document.createElement('div');
    player.attachShadow({ mode: 'open' }).append(inner);
    const video = document.createElement('video');
    video.style.cssText = 'display: block; width: 320px; height: 180px; background: #222';
    inner.attachShadow({ mode: 'open' }).append(video);
  });
  const popup = await openPopup(context, extensionId);
  await popup.getByRole('switch', { name: '미디어 배속' }).check();
  await popup.close();

  // 처음부터 겹친 열린 shadow root 안에 있던 영상. 표시창의 틀은 그 영상이 그려진 상자와 같다.
  await expect.poll(() => indicatorTexts(page)).toEqual(['1×']);
  const boxes = () =>
    page.evaluate(() => {
      const box = (element: Element | null | undefined) => {
        const rect = element?.getBoundingClientRect();
        return rect && [rect.left, rect.top, rect.width, rect.height];
      };
      const video = document
        .getElementById('player')
        ?.shadowRoot?.querySelector('div')
        ?.shadowRoot?.querySelector('video');
      return { video: box(video), host: box(document.querySelector('browser-toolbox-ui')) };
    });
  await expect
    .poll(async () => {
      const { video, host } = await boxes();
      return host !== undefined && JSON.stringify(host) === JSON.stringify(video);
    })
    .toBe(true);

  // 페이지가 영상이 든 열린 shadow root를 가진 요소를 나중에 더하고, 그 영상의 배속을 바꾼다.
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'later';
    const video = document.createElement('video');
    video.style.cssText = 'display: block; width: 320px; height: 180px';
    host.attachShadow({ mode: 'open' }).append(video);
    document.body.append(host);
    video.playbackRate = 2;
  });
  await expect.poll(() => indicatorTexts(page)).toEqual(['1×', '2×']);

  // 처음의 플레이어를 지우면 그 안의 영상의 표시창만 사라진다.
  await page.evaluate(() => document.getElementById('player')?.remove());
  await expect.poll(() => indicatorTexts(page)).toEqual(['2×']);
  expect(await hostCount(page)).toBe(1);
  expect(pageErrors).toEqual([]);
});
