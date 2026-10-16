import type { Frame, Page } from '@playwright/test';
import { settingsUpdate } from '../../src/contracts/index.ts';
import {
  expect,
  fixtureOrigin,
  hostCount,
  indicatorTexts,
  openPopup,
  serviceWorkerOf,
  test,
} from './support/extension.ts';

// COM-1.5: 기능을 빠르게 10번 켜고 끈 뒤에도 COM-1.3(끄면 DOM이 켜기 전과 같다)과 COM-1.4(스크립트가 한 프레임에 두 번
// 실려도 화면 요소와 이벤트 처리는 하나씩)가 성립한다. 콘텐츠 스크립트를 모든 프레임에 한 번 더 실은 페이지에서, 확장
// 화면(팝업 문서)이 설정 바꾸기 요청 20개(켜기·끄기 10번)를 응답을 기다리지 않고 잇달아 보낸다. 팝업의 스위치가 보내는
// 것과 같은 요청이다. 스위치를 누르지 않는 것은 Playwright의 클릭이 하나씩 끝나기를 기다려 이만큼 빨리 바꿀 수 없기
// 때문이다. 서비스 워커는 들어온 차례로 저장하고, 프레임마다 읽기 도우미가 바뀜 알림을 받아 실행 틀이 기능을 시작하고
// 정리한다.

const cycles = 10;

// 확장 화면에서 미디어 배속의 켜짐을 values 차례로 바꾸는 요청을 한꺼번에 보내고, 모든 응답을 돌려준다.
function sendUpdates(popup: Page, values: readonly boolean[]): Promise<unknown[]> {
  return popup.evaluate(
    ({ type, values: list }) =>
      Promise.all(
        list.map((enabled): Promise<unknown> =>
          chrome.runtime.sendMessage({
            type,
            payload: { featureId: 'media-speed', patch: { enabled } },
          }),
        ),
      ),
    { type: settingsUpdate.type, values },
  );
}

function domOf(frame: Frame): Promise<string> {
  return frame.evaluate(() => document.documentElement.outerHTML);
}

test('COM-1.5 COM-1.3 COM-1.4 스크립트가 두 번 실린 프레임에서 빠르게 10번 켜고 끈 뒤에도, 켜면 화면 요소가 하나씩이고 끄면 DOM이 켜기 전과 같다', async ({
  context,
  extensionId,
}) => {
  const worker = await serviceWorkerOf(context);
  await expect
    .poll(() => worker.evaluate(() => chrome.storage.local.get('settings')))
    .toMatchObject({ settings: { version: 1 } });
  const page = await context.newPage();
  await page.goto(`${fixtureOrigin}/video.html`);
  await expect(page.frameLocator('#frame').locator('video')).toBeVisible();
  const frames = page.frames();
  expect(frames).toHaveLength(2);

  // 콘텐츠 스크립트를 모든 프레임에 한 번 더 싣는다. manifest가 실은 것과 같은 격리된 세계다.
  const loaded = await worker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url === url);
    if (tab?.id === undefined) throw new Error('시험 페이지의 탭을 찾지 못했다.');
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['content-common.js'],
    });
    return results.length;
  }, page.url());
  expect(loaded).toBe(frames.length);

  const before = await Promise.all(frames.map(domOf));
  const popup = await openPopup(context, extensionId);
  const responses = await sendUpdates(
    popup,
    Array.from({ length: cycles * 2 }, (_, index) => index % 2 === 0),
  );
  expect(responses).toHaveLength(cycles * 2);
  for (const response of responses) expect(response).toMatchObject({ ok: true });

  // 그 뒤 켜면 프레임마다 화면 요소가 하나이고 지금 배속을 보인다(COM-1.4).
  await sendUpdates(popup, [true]);
  for (const frame of frames) await expect.poll(() => hostCount(frame)).toBe(1);
  await expect.poll(() => indicatorTexts(page)).toEqual(['1×', '1×']);
  for (const frame of frames) expect(await hostCount(frame)).toBe(1);

  // 끄면 두 프레임의 DOM이 켜기 전과 같다(COM-1.3).
  await sendUpdates(popup, [false]);
  for (const [index, frame] of frames.entries()) {
    await expect.poll(() => domOf(frame)).toBe(before[index]);
  }
});
