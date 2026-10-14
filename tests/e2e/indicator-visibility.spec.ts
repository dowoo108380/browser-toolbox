import { expect, fixtureOrigin, hostCount, openPopup, test } from './support/extension.ts';
import { pixelAt } from './support/pixel.ts';

// 배속 표시창이 영상이 실제로 보일 때만 그려지는지 화면의 픽셀로 본다(MED-3 기대 동작 5, 결정 0018).
// 스크롤 컨테이너에 가려진 영상과 visibility: hidden인 영상은 position-visibility가 숨기는데,
// 이것은 DOM API(checkVisibility, 계산된 visibility)로 알 수 없어 DOM 시험으로는 지킬 수 없다.

// 표시창은 영상 왼쪽 위에서 8px 안쪽에 있다. 그 안에서 왼쪽 여백(글자가 없는 곳)의 한 점을 본다.
const insideIndicator = { x: 8 + 3, y: 8 + 10 };

// 표시창의 배경(검정 75%)이 그려졌으면 어느 바탕 위에서도 모든 채널이 80 이하다.
function isIndicator([red, green, blue]: readonly [number, number, number]): boolean {
  return Math.max(red, green, blue) <= 80;
}

test('MED-3 결정 0018 표시창은 영상이 스크롤 컨테이너에 가려지거나 visibility: hidden이면 그려지지 않고, 다시 보이면 그려진다', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${fixtureOrigin}/indicator-visibility.html`);
  const popup = await openPopup(context, extensionId);
  await popup.getByRole('switch', { name: '미디어 배속' }).check();
  await popup.close();
  await page.bringToFront();
  await expect.poll(() => hostCount(page)).toBe(3);

  // 영상 id의 표시창 자리의 색.
  const colorAt = async (id: string) => {
    const box = await page.locator(`#${id}`).boundingBox();
    if (box === null) throw new Error(`#${id}의 자리를 모른다.`);
    return pixelAt(page, box.x + insideIndicator.x, box.y + insideIndicator.y);
  };
  const drawnOn = async (id: string) => isIndicator(await colorAt(id));

  // 보이는 영상에는 그려진다.
  await expect.poll(() => drawnOn('plain')).toBe(true);
  await expect.poll(() => drawnOn('clipped')).toBe(true);
  await expect.poll(() => drawnOn('hidden-later')).toBe(true);

  // 스크롤 컨테이너 안에서 영상이 위로 완전히 가려지면, 표시창 자리(컨테이너 위의 회색 판)에 회색만 보인다.
  const scrollTo = (top: number) =>
    page.evaluate((value) => {
      const scroller = document.getElementById('scroller');
      if (scroller !== null) scroller.scrollTop = value;
    }, top);
  await scrollTo(260);
  await expect.poll(() => colorAt('clipped')).toEqual([200, 200, 200]);
  await scrollTo(0);
  await expect.poll(() => drawnOn('clipped')).toBe(true);

  // visibility: hidden인 영상의 표시창 자리에는 페이지 바탕(흰색)만 보인다.
  const setVisibility = (value: string) =>
    page.evaluate((visibility) => {
      document.getElementById('hidden-later')?.style.setProperty('visibility', visibility);
    }, value);
  await setVisibility('hidden');
  await expect.poll(() => colorAt('hidden-later')).toEqual([255, 255, 255]);
  await setVisibility('visible');
  await expect.poll(() => drawnOn('hidden-later')).toBe(true);

  // 다른 영상의 표시창은 그대로 그려져 있다.
  expect(await drawnOn('plain')).toBe(true);
});
