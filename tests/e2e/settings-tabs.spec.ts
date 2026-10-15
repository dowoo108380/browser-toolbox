import type { Frame, Page } from '@playwright/test';
import { expect, fixtureOrigin, openPopup, serviceWorkerOf, test } from './support/extension.ts';

// COM-3.2: 탭 두 개가 열린 상태에서 팝업으로 설정을 바꾸면 두 탭에 모두 1초 안에 반영된다(COM-3 기대 동작 2: 열린
// 모든 탭에 바로). 탭마다 최상위와 출처가 다른 iframe이 있어 네 프레임을 본다. 켜기는 확장의 화면 요소가 생길 때,
// 끄기는 없어질 때 반영된 것이다. 시간은 Playwright가 오가는 시간을 빼려고 브라우저 안에서 잰다: 팝업에서 스위치를 누른
// 때(click 이벤트)와 각 프레임에서 요소가 생기거나 없어진 때(MutationObserver)의 Date.now() 차이다. 같은 컴퓨터의
// 시계라 프로세스가 달라도 견줄 수 있다.

const limitMs = 1000;

// 프레임에서 확장의 화면 요소가 처음 생긴 때와, 그 뒤 모두 없어진 때를 적어 두게 한다.
function watchHosts(frame: Frame): Promise<void> {
  return frame.evaluate(() => {
    new MutationObserver(() => {
      const present = document.querySelector('browser-toolbox-ui') !== null;
      if (present && Reflect.get(window, 'hostAddedAt') === undefined) {
        Reflect.set(window, 'hostAddedAt', Date.now());
      }
      if (
        !present &&
        Reflect.get(window, 'hostAddedAt') !== undefined &&
        Reflect.get(window, 'hostRemovedAt') === undefined
      ) {
        Reflect.set(window, 'hostRemovedAt', Date.now());
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

// 다음 클릭이 일어난 때를 name에 적어 두게 한다.
function watchClick(popup: Page, name: string): Promise<void> {
  return popup.evaluate((key) => {
    document.addEventListener(
      'click',
      () => {
        Reflect.set(window, key, Date.now());
      },
      { capture: true, once: true },
    );
  }, name);
}

// 적어 둔 때(ms). 아직 없으면 null이다.
function timeOf(target: Frame | Page, name: string): Promise<number | null> {
  return target.evaluate((key): number | null => {
    const value: unknown = Reflect.get(window, key);
    return typeof value === 'number' ? value : null;
  }, name);
}

test('COM-3.2 탭 두 개가 열린 상태에서 팝업으로 켜고 끄면 두 탭의 모든 프레임에 1초 안에 반영된다', async ({
  context,
  extensionId,
}) => {
  const worker = await serviceWorkerOf(context);
  await expect
    .poll(() => worker.evaluate(() => chrome.storage.local.get('settings')))
    .toMatchObject({ settings: { version: 1 } });

  const frames: Frame[] = [];
  for (let index = 0; index < 2; index += 1) {
    const tab = await context.newPage();
    await tab.goto(`${fixtureOrigin}/video.html`);
    await expect(tab.frameLocator('#frame').locator('video')).toBeVisible();
    frames.push(...tab.frames());
  }
  expect(frames).toHaveLength(4);
  for (const frame of frames) await watchHosts(frame);

  const popup = await openPopup(context, extensionId);
  const toggle = popup.getByRole('switch', { name: '미디어 배속' });
  await expect(toggle).toBeEnabled();

  for (const { change, clicked, reflected } of [
    { change: () => toggle.check(), clicked: 'clickedOnAt', reflected: 'hostAddedAt' },
    { change: () => toggle.uncheck(), clicked: 'clickedOffAt', reflected: 'hostRemovedAt' },
  ]) {
    await watchClick(popup, clicked);
    await change();
    const clickedAt = await timeOf(popup, clicked);
    if (clickedAt === null) throw new Error('팝업에서 누른 때를 적지 못했다.');
    // 1초를 넘겨도 걸린 시간을 보이려고 넉넉히 기다린 뒤 견준다. 기다린 뒤라 null은 없다(있으면 NaN이라 비교가 실패한다).
    await expect
      .poll(async () =>
        (await Promise.all(frames.map((frame) => timeOf(frame, reflected)))).includes(null),
      )
      .toBe(false);
    const delays = (await Promise.all(frames.map((frame) => timeOf(frame, reflected)))).map(
      (time) => (time ?? Number.NaN) - clickedAt,
    );
    console.log(`COM-3.2 ${reflected}: 누른 뒤 ${delays.join(', ')}ms`);
    for (const delay of delays) expect(delay).toBeLessThanOrEqual(limitMs);
  }
});
