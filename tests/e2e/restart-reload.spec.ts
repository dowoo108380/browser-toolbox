import type { BrowserContext } from '@playwright/test';
import { fixtureSummary, fixtureTask } from '../extension/fixture-tasks.ts';
import {
  expect,
  fixtureOrigin,
  indicatorTexts,
  openPopup,
  reloadExtension,
  serviceWorkerOf,
  test,
  watchServiceWorker,
} from './support/extension.ts';
import {
  badgeOf,
  defaultTitle,
  openPage,
  popupFor,
  release,
  tabIdOf,
  taskRecords,
} from './support/tasks.ts';

// COM-7의 표: 서비스 워커가 다시 시작하거나 확장을 다시 불러올 때 무엇이 남고 무엇이 사라지는지(R-20). 서비스 워커의
// 다시 시작은 CDP ServiceWorker.stopAllWorkers로 강제로 멈춰 만든다(Chrome이 쉬는 서비스 워커를 멈춘 것과 같다). 다시
// 불러오기는 사용자의 "다시 로드"와 같은 CDP Extensions.loadUnpacked로 한다(R-04). 탭 상태는 지금 작업 기록(COM-10)뿐이라
// 시험 빌드의 시험 작업으로 만든다(결정 0025). 탭 배속(MED-4)과 활성 상태 유지(TAB-2)는 그 기능을 만들 때 여기에 더한다.
// 옛 스크립트의 정리(COM-7.1·7.2)는 reload.spec.ts가 본다.

test.use({ extensionBuild: 'fixture' });

// 작업이 끝나지 못하게 한 다시 시작의 이유(src/background/strings.ts의 interrupted, 결정 0024).
const interrupted = '확장이 작업 도중 다시 시작되어 끝까지 하지 못했다. 다시 실행한다.';

// 영상이 있는 페이지에서 미디어 배속을 켜고(설정을 바꿈), 그 탭에 시험 작업의 보지 않은 결과를 남긴다.
async function prepare(context: BrowserContext, extensionId: string) {
  const worker = await serviceWorkerOf(context);
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  await page.goto(`${fixtureOrigin}/video.html`);
  const tabId = await tabIdOf(worker, page);

  const settingsPopup = await openPopup(context, extensionId);
  await settingsPopup.getByRole('tab', { name: '미디어' }).click();
  await settingsPopup.getByRole('switch', { name: '미디어 배속' }).check();
  await settingsPopup.close();
  await expect.poll(() => indicatorTexts(page)).toEqual(['1×', '1×']);

  const opened = await popupFor(context, extensionId, page);
  await opened.run(fixtureTask.name).click();
  await expect(opened.status).toHaveText('시험 작업: 진행 중이다.');
  await opened.popup.close();
  await release(worker, fixtureTask.id, 'succeed');
  await expect
    .poll(() => badgeOf(worker, tabId))
    .toEqual({ text: '✓', title: `${defaultTitle}: 시험 작업 끝남` });
  const settings = await worker.evaluate(() => chrome.storage.local.get('settings'));
  expect(settings).toMatchObject({ settings: { features: { 'media-speed': { enabled: true } } } });
  return { page, tabId, pageErrors, settings };
}

test.describe('서비스 워커가 다시 시작함', () => {
  test('COM-7.4 COM-7 기대 동작 4 서비스 워커를 강제로 멈춘 뒤에도 설정과 작업 기록·배지가 그대로이고, 열린 탭의 기능은 멈춘 동안에도 돌며, 팝업으로 바꾼 설정이 그 탭에 닿는다', async ({
    context,
    extensionId,
  }) => {
    const { page, tabId, pageErrors, settings } = await prepare(context, extensionId);
    const workerStatus = await watchServiceWorker(await context.newPage());
    await workerStatus.stop();

    // 멈춘 동안에도 열린 탭의 기능은 페이지의 사건에 따라 돈다. 서비스 워커를 깨우지 않는다.
    await page.evaluate(() => {
      const video = document.querySelector('video');
      if (video) video.playbackRate = 2;
    });
    await expect.poll(() => indicatorTexts(page)).toEqual(['1×', '2×']);
    expect(workerStatus.last()).toBe('stopped');

    // 확장 화면을 열면 서비스 워커가 다시 시작한다(팝업은 열릴 때 깨운다). 설정과 작업 기록·배지가 멈추기 전 그대로다.
    const waker = await openPopup(context, extensionId);
    await workerStatus.reach('running');
    const restarted = await serviceWorkerOf(context);
    expect(await restarted.evaluate(() => chrome.storage.local.get('settings'))).toEqual(settings);
    expect(await taskRecords(restarted)).toEqual({
      [String(tabId)]: {
        id: expect.any(String),
        featureId: fixtureTask.id,
        status: 'succeeded',
        summary: fixtureSummary,
      },
    });
    expect(await badgeOf(restarted, tabId)).toEqual({
      text: '✓',
      title: `${defaultTitle}: 시험 작업 끝남`,
    });
    await waker.close();

    // 그 탭의 팝업은 보지 않은 결과를 보이고(보인 뒤 지운다), 그 팝업으로 끈 기능은 그 탭에서 멈춘다.
    const opened = await popupFor(context, extensionId, page);
    await expect(opened.status).toHaveText(`시험 작업: 끝났다. ${fixtureSummary}`);
    await expect.poll(() => badgeOf(restarted, tabId)).toEqual({ text: '', title: defaultTitle });
    await opened.popup.getByRole('tab', { name: '미디어' }).click();
    await opened.popup.getByRole('switch', { name: '미디어 배속' }).uncheck();
    await expect.poll(() => indicatorTexts(page)).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test('결정 0024 서비스 워커가 강제로 멈추면 진행 중이던 작업은 다시 시작한 서비스 워커가 이유와 함께 실패로 끝내고 그 탭에 실패 배지를 달며 기록한다', async ({
    context,
    extensionId,
  }) => {
    const worker = await serviceWorkerOf(context);
    const page = await openPage(context);
    const tabId = await tabIdOf(worker, page);
    const opened = await popupFor(context, extensionId, page);
    await opened.run(fixtureTask.name).click();
    await expect(opened.status).toHaveText('시험 작업: 진행 중이다.');
    await opened.popup.close();

    const workerStatus = await watchServiceWorker(await context.newPage());
    await workerStatus.stop();
    const waker = await openPopup(context, extensionId);
    await workerStatus.reach('running');
    const restarted = await serviceWorkerOf(context);
    await expect
      .poll(() => taskRecords(restarted))
      .toEqual({
        [String(tabId)]: {
          id: expect.any(String),
          featureId: fixtureTask.id,
          status: 'failed',
          error: { kind: 'unexpected', message: interrupted },
        },
      });
    expect(await badgeOf(restarted, tabId)).toEqual({
      text: '!',
      title: `${defaultTitle}: 시험 작업 실패`,
    });
    // 고친 기록을 쓴 뒤에 문제 기록의 줄에 서므로 기다린다.
    await expect
      .poll(() =>
        waker.evaluate(async (): Promise<unknown> => {
          const items: Record<string, unknown> = await chrome.storage.local.get('problems');
          return items['problems'];
        }),
      )
      .toEqual([expect.objectContaining({ featureId: fixtureTask.id, kind: 'unexpected' })]);
    await waker.close();

    // 그 탭의 팝업은 실패와 이유를 보이고, 그 탭에서 다시 시작할 수 있다.
    const after = await popupFor(context, extensionId, page);
    await expect(after.status).toHaveText(`시험 작업: 실패했다. ${interrupted}`);
    await expect(after.run(fixtureTask.name)).not.toHaveAttribute('aria-disabled', 'true');
    await after.run(fixtureTask.name).click();
    await expect(after.status).toHaveText('시험 작업: 진행 중이다.');
  });

  test('이슈 #7 결정 0038 앞 서비스 워커가 끝난 기록을 쓰고 배지를 달기 전에 멈췄으면, 다시 시작한 서비스 워커가 그 탭에 배지를 단다', async ({
    context,
    extensionId,
  }) => {
    const worker = await serviceWorkerOf(context);
    const page = await openPage(context);
    const tabId = await tabIdOf(worker, page);
    // 작업 실행이 끝난 기록을 쓴 직후와 같은 상태를 만든다: 기록은 있고 배지는 아직 없다.
    await worker.evaluate(
      async ({ key, records }) => {
        await chrome.storage.session.set({ [key]: records });
      },
      {
        key: 'tasks',
        records: {
          [String(tabId)]: {
            id: 'earlier',
            featureId: fixtureTask.id,
            status: 'succeeded',
            summary: fixtureSummary,
          },
        },
      },
    );
    expect(await badgeOf(worker, tabId)).toEqual({ text: '', title: defaultTitle });

    const workerStatus = await watchServiceWorker(await context.newPage());
    await workerStatus.stop();
    const waker = await openPopup(context, extensionId);
    await workerStatus.reach('running');
    const restarted = await serviceWorkerOf(context);
    await expect
      .poll(() => badgeOf(restarted, tabId))
      .toEqual({ text: '✓', title: `${defaultTitle}: 시험 작업 끝남` });
    await waker.close();

    // 그 탭의 팝업이 결과를 보이면 배지와 기록이 함께 지워진다(COM-10.4. 배지를 먼저 지운다).
    const opened = await popupFor(context, extensionId, page);
    await expect(opened.status).toHaveText(`시험 작업: 끝났다. ${fixtureSummary}`);
    await expect.poll(() => taskRecords(restarted)).toEqual({});
    expect(await badgeOf(restarted, tabId)).toEqual({ text: '', title: defaultTitle });
  });
});

test.describe('확장을 다시 불러옴', () => {
  test.use({ browserDebugging: true });

  test('COM-7.6 COM-10 기대 동작 5 확장을 다시 불러오면 설정은 바꾼 값 그대로이고 작업 기록과 배지는 사라지며, 새로 고친 탭은 그 설정대로 동작한다', async ({
    context,
    extensionId,
    profileDirectory,
  }) => {
    const { page, tabId, settings } = await prepare(context, extensionId);

    await reloadExtension(profileDirectory, extensionId, 'fixture');
    // 새 판의 확장 화면에서 읽는다(앞 서비스 워커는 끝났다).
    const fresh = await openPopup(context, extensionId);
    await expect
      .poll(() =>
        fresh.evaluate(async (id) => {
          const { tasks }: Record<string, unknown> = await chrome.storage.session.get('tasks');
          return { tasks: tasks ?? null, badge: await chrome.action.getBadgeText({ tabId: id }) };
        }, tabId),
      )
      .toEqual({ tasks: null, badge: '' });
    expect(await fresh.evaluate(() => chrome.storage.local.get('settings'))).toEqual(settings);
    await fresh.close();

    // 그 탭을 새로 고치면 새 판의 스크립트가 바꾼 설정대로(미디어 배속 켬) 동작한다.
    await page.reload();
    await expect.poll(() => indicatorTexts(page)).toEqual(['1×', '1×']);
  });
});
