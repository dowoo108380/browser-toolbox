import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fixtureOther, fixtureTask } from '../extension/fixture-tasks.ts';
import {
  distPath,
  expect,
  fixtureDistPath,
  fixtureOrigin,
  hostCount,
  indicatorTexts,
  openPopup,
  test,
} from './support/extension.ts';

// 걸어 다니는 뼈대(아키텍처 12장): 팝업에서 켜면 모든 프레임의 영상 위에 실제 배속이 뜨고, 끄면 사라진다.

test('099 확장이 올라가고 서비스 워커가 기본 설정을 쓰며 팝업이 오류 없이 열린다', async ({
  context,
  extensionId,
}) => {
  const worker = context.serviceWorkers()[0];
  expect(worker).toBeDefined();
  await expect
    .poll(() => worker?.evaluate(() => chrome.storage.local.get('settings')))
    .toMatchObject({ settings: { version: 1, features: {}, sites: {} } });

  const errors: string[] = [];
  const popup = await context.newPage();
  popup.on('pageerror', (error) => errors.push(error.message));
  popup.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.getByRole('switch', { name: '미디어 배속' })).not.toBeChecked();
  // COM-1.1 처음 설치하면 꺼져 있다.
  await expect(popup.getByText('꺼짐')).toBeVisible();
  expect(errors).toEqual([]);
});

test('MED-3 팝업에서 켜면 최상위와 iframe의 영상에 실제 배속이 뜨고, 끄면 남는 것이 없다', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`${fixtureOrigin}/video.html`);
  const frame = page.frameLocator('#frame');
  await expect(frame.locator('video')).toBeVisible();
  const childFrame = page.frames().find((candidate) => candidate.url().includes('video-only'));
  if (childFrame === undefined) throw new Error('iframe을 찾지 못했다.');

  const popup = await openPopup(context, extensionId);
  const toggle = popup.getByRole('switch', { name: '미디어 배속' });
  await toggle.check();
  await expect(toggle).toBeChecked();

  // COM-1.2 새로 고침 없이 열린 탭의 모든 프레임에서 작용한다.
  await expect.poll(() => hostCount(page)).toBe(1);
  await expect.poll(() => hostCount(childFrame)).toBe(1);
  await expect.poll(() => indicatorTexts(page)).toEqual(['1×', '1×']);

  // 표시창의 틀(host)은 영상이 그려진 상자와 같은 자리, 같은 크기이고, 영상 앞에 내용이 더해져 영상만 옮겨져도
  // 따라간다(결정 0018). 콘텐츠 스크립트(격리된 세계)가 연 popover에서도 source로 준 영상이 앵커가 되는지 본다.
  // 두 상자의 자리와 크기 가운데 가장 큰 차이(px). 맞으면 0이다.
  const difference = () =>
    page.evaluate(() => {
      const video = document.querySelector('video')?.getBoundingClientRect();
      const host = document.querySelector('browser-toolbox-ui')?.getBoundingClientRect();
      if (video === undefined || host === undefined) return null;
      const gaps = [
        host.left - video.left,
        host.top - video.top,
        host.width - video.width,
        host.height - video.height,
      ];
      return Math.round(Math.max(...gaps.map((gap) => Math.abs(gap))));
    });
  await expect.poll(difference).toBe(0);
  await page.evaluate(() => {
    const block = document.createElement('div');
    block.style.height = '150px';
    document.body.prepend(block);
  });
  await expect.poll(difference).toBe(0);

  // MED-3.1 배속을 바꾸면 표시창의 값이 실제 배속으로 바뀐다.
  await childFrame.evaluate(() => {
    const video = document.querySelector('video');
    if (video) video.playbackRate = 1.75;
  });
  await expect.poll(() => indicatorTexts(page)).toEqual(['1.75×', '1×']);

  // COM-1.3 끄면 열린 탭에서 확장이 더한 요소가 남지 않는다.
  await toggle.uncheck();
  await expect.poll(() => hostCount(page)).toBe(0);
  await expect.poll(() => hostCount(childFrame)).toBe(0);
});

test('결정 0025 배포 빌드(dist/)에는 시험 빌드의 시험 기능이 들어가지 않는다', () => {
  // 비교 대상이 맞는지: 시험 빌드에는 들어 있다.
  const fixtureWorker = readFileSync(path.join(fixtureDistPath, 'sw.js'), 'utf8');
  expect(fixtureWorker.includes(fixtureTask.id)).toBe(true);
  const found = ['sw.js', 'popup.js', 'content-common.js', 'manifest.json'].flatMap((file) => {
    const text = readFileSync(path.join(distPath, file), 'utf8');
    return [fixtureTask.id, fixtureOther.id]
      .filter((id) => text.includes(id))
      .map((id) => `${file}: ${id}`);
  });
  expect(found).toEqual([]);
});
