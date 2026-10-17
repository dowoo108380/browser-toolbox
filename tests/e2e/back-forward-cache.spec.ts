import type { Page } from '@playwright/test';
import {
  expect,
  fixtureOrigin,
  hostCount,
  indicatorTexts,
  openPopup,
  openPopupOn,
  reloadExtension,
  tabStatusOf,
  test,
} from './support/extension.ts';

// 뒤로·앞으로 캐시(bfcache)와 확장 다시 불러오기(COM-7, 결정 0008). bfcache는 떠난 문서를 멈춘 채 두었다가 뒤로 가기에서
// 그 문서를 그대로 되살린다. 옛 콘텐츠 스크립트의 세계와 그것이 더한 요소도 함께다. 그래서 새 판이 그런 문서를 만나면 옛
// 요소가 남거나(COM-7.2) 옛 판과 새 판의 요소가 겹칠 수 있다(COM-7.3). 2026-10-17 실험(Chromium 156)에서 Chrome은
// bfcache에 든 동안 확장을 다시 불러오면 그 문서를 버리고 뒤로 가기에서 새로 실었고, 다시 불러온 뒤에 떠난 문서는 정리를
// 마친 채 되살렸다(새 판의 스크립트는 실리지 않음). 이 시험이 그 두 길을 지킨다.

test.use({ browserDebugging: true, backForwardCache: true });

// 이 문서에만 있는 표식. 뒤로 가기에서 같은 표식이 보이면 bfcache가 그 문서를 되살린 것이고, 없으면 새로 실은 것이다.
const markDocument = (page: Page) =>
  page.evaluate(() => {
    Reflect.set(window, 'documentMark', 'before');
  });
const isSameDocument = (page: Page) =>
  page.evaluate(() => Reflect.get(window, 'documentMark') === 'before');

// bfcache에서 되살아난 문서는 load 사건이 없어 그것을 기다리지 않는다.
const goBack = (page: Page) => page.goBack({ waitUntil: 'commit' });

async function openVideoWithIndicators(page: Page, extensionId: string) {
  await page.goto(`${fixtureOrigin}/video.html`);
  const popup = await openPopup(page.context(), extensionId);
  await popup.getByRole('switch', { name: '미디어 배속' }).check();
  await popup.close();
  await expect.poll(() => indicatorTexts(page)).toEqual(['1×', '1×']);
}

test('COM-7.3 bfcache에 든 동안 확장을 다시 불러오면 뒤로 가기는 옛 문서가 아니라 새 문서를 싣고, 영상마다 새 판의 표시창이 하나다', async ({
  context,
  extensionId,
  profileDirectory,
}) => {
  const page = await context.newPage();
  await openVideoWithIndicators(page, extensionId);

  // 이 시험이 보려는 것인지 먼저 확인한다: 다시 불러오지 않으면 뒤로 가기가 같은 문서를 되살린다.
  await markDocument(page);
  await page.goto(`${fixtureOrigin}/blank.html`);
  await goBack(page);
  await expect.poll(() => isSameDocument(page)).toBe(true);

  await page.evaluate(() => {
    const video = document.querySelector('video');
    if (video) video.playbackRate = 2;
  });
  await expect.poll(() => indicatorTexts(page)).toEqual(['1×', '2×']);
  await page.goto(`${fixtureOrigin}/blank.html`);
  await reloadExtension(profileDirectory, extensionId);
  await goBack(page);

  await expect.poll(() => page.evaluate(() => document.readyState)).toBe('complete');
  expect(await isSameDocument(page)).toBe(false);
  for (const frame of page.frames()) await expect.poll(() => hostCount(frame)).toBe(1);
  await expect.poll(() => indicatorTexts(page)).toEqual(['1×', '1×']);
});

test('COM-7.2 COM-7 기대 동작 2 다시 불러온 뒤에 떠났다가 bfcache로 돌아온 옛 문서에는 옛 표시창이 없고, 영상의 배속은 그대로이며, 팝업은 새로 고침을 안내한다', async ({
  context,
  extensionId,
  profileDirectory,
}) => {
  const page = await context.newPage();
  await openVideoWithIndicators(page, extensionId);
  await page.evaluate(() => {
    const video = document.querySelector('video');
    if (video) video.playbackRate = 2;
  });
  await expect.poll(() => indicatorTexts(page)).toEqual(['1×', '2×']);
  await markDocument(page);

  await reloadExtension(profileDirectory, extensionId);
  await expect.poll(() => indicatorTexts(page)).toEqual([]);
  await page.goto(`${fixtureOrigin}/blank.html`);
  await goBack(page);

  await expect.poll(() => isSameDocument(page)).toBe(true);
  // 되살아난 문서에는 새 판의 실행 틀이 없고(탐침의 답), 물러난 옛 실행 틀이 요소를 다시 더하지 않았다.
  const viewer = await openPopupOn(context, extensionId, page);
  expect(await tabStatusOf(viewer, page)).toEqual({ ok: true, value: { page: 'reload' } });
  await expect(viewer.getByText('쓸 수 없음: 이 탭을 새로 고쳐야 쓸 수 있음')).toBeVisible();
  expect(await indicatorTexts(page)).toEqual([]);
  expect(await page.evaluate(() => document.querySelector('video')?.playbackRate)).toBe(2);
});
