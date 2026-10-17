import type { Page } from '@playwright/test';
import { responseSchema, taskSeen, taskStart, v } from '../../src/contracts/index.ts';
import {
  fixtureFailure,
  fixtureOther,
  fixtureSummary,
  fixtureTask,
} from '../extension/fixture-tasks.ts';
import { connectBrowserCdp } from './support/browser-cdp.ts';
import {
  expect,
  fixtureDistPath,
  fixtureOrigin,
  indicatorTexts,
  openPopup,
  openPopupOn,
  serviceWorkerOf,
  test,
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

// COM-10 작업 결과 알림(결정 0012, 0024)을 실제 Chromium에서 본다. 제품에는 아직 실행 기능이 없어 시험 빌드(결정 0025)의
// 시험 기능("시험 작업", "다른 시험 작업")을 쓴다. 일의 끝과 팝업 여닫기는 support/tasks.ts의 도우미가 한다.
// 파일 저장(COM-10.1의 "파일이 저장되고")은 자막 저장(SUB-1)을 만들 때 본다.

test.use({ extensionBuild: 'fixture' });

// 페이지 위 알림의 글(닫힌 shadow root 안, CDP로 읽는다). 다른 확장 요소(배속 표시창)는 시험 기능만 쓰는 이 시험에 없다.
const noticeTexts = (page: Page) => indicatorTexts(page);

test('COM-10.1 COM-10.3 COM-10.4 팝업을 바로 닫아도 작업이 끝나고, 그 탭의 배지·제목과 페이지 위 알림(3초)이 결과를 보이며, 다시 연 팝업이 한 번 보이면 지운다', async ({
  context,
  extensionId,
}) => {
  const worker = await serviceWorkerOf(context);
  const page = await openPage(context);
  const tabId = await tabIdOf(worker, page);

  const first = await popupFor(context, extensionId, page);
  await expect(first.run(fixtureTask.name)).not.toHaveAttribute('aria-disabled', 'true');
  await first.run(fixtureTask.name).click();
  await expect(first.status).toHaveText('시험 작업: 진행 중이다.');
  await first.popup.close();

  // COM-10.3 진행 중에 다시 열면 진행 중임이 보인다.
  const during = await popupFor(context, extensionId, page);
  await expect(during.status).toHaveText('시험 작업: 진행 중이다.');
  await during.popup.close();

  await page.bringToFront();
  await release(worker, fixtureTask.id, 'succeed');
  await expect
    .poll(() => badgeOf(worker, tabId))
    .toEqual({ text: '✓', title: `${defaultTitle}: 시험 작업 끝남` });
  await expect.poll(() => noticeTexts(page)).toEqual([`시험 작업: 끝났다. ${fixtureSummary}`]);
  // 3초 동안 보이고 그 뒤 사라진다.
  await page.waitForTimeout(2000);
  expect(await noticeTexts(page)).toEqual([`시험 작업: 끝났다. ${fixtureSummary}`]);
  await expect.poll(() => noticeTexts(page), { timeout: 3000 }).toEqual([]);

  const after = await popupFor(context, extensionId, page);
  await expect(after.status).toHaveText(`시험 작업: 끝났다. ${fixtureSummary}`);
  // COM-10.4 보인 결과는 지워지고 배지도 지워진다.
  await expect.poll(() => taskRecords(worker)).toEqual({});
  await expect.poll(() => badgeOf(worker, tabId)).toEqual({ text: '', title: defaultTitle });
  await after.popup.close();
  const again = await popupFor(context, extensionId, page);
  await expect(again.status).toHaveText('');
});

test('COM-10.2 실패하는 작업도 그 탭의 배지·제목, 페이지 위 알림, 다시 연 팝업에 실패와 이유가 보인다', async ({
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

  await page.bringToFront();
  await release(worker, fixtureTask.id, 'fail');
  await expect
    .poll(() => badgeOf(worker, tabId))
    .toEqual({ text: '!', title: `${defaultTitle}: 시험 작업 실패` });
  await expect.poll(() => noticeTexts(page)).toEqual([`시험 작업: 실패했다. ${fixtureFailure}`]);
  const after = await popupFor(context, extensionId, page);
  await expect(after.status).toHaveText(`시험 작업: 실패했다. ${fixtureFailure}`);
});

test('COM-10.5 탭 A에서 시작한 작업의 결과는 탭 B의 팝업과 배지에 보이지 않는다', async ({
  context,
  extensionId,
}) => {
  const worker = await serviceWorkerOf(context);
  const pageA = await openPage(context);
  const pageB = await openPage(context, 'video.html');
  const tabA = await tabIdOf(worker, pageA);
  const tabB = await tabIdOf(worker, pageB);
  const inA = await popupFor(context, extensionId, pageA);
  await inA.run(fixtureTask.name).click();
  await expect(inA.status).toHaveText('시험 작업: 진행 중이다.');
  await inA.popup.close();

  await release(worker, fixtureTask.id, 'succeed');
  await expect.poll(() => badgeOf(worker, tabA)).toMatchObject({ text: '✓' });
  expect(await badgeOf(worker, tabB)).toEqual({ text: '', title: defaultTitle });
  const inB = await popupFor(context, extensionId, pageB);
  await expect(inB.run(fixtureOther.name)).not.toHaveAttribute('aria-disabled', 'true');
  await expect(inB.status).toHaveText('');
  expect(await taskRecords(worker)).toEqual({
    [String(tabA)]: expect.objectContaining({ status: 'succeeded' }),
  });
});

test('COM-10.6 탭을 닫으면 그 탭의 작업 기록(진행 중이든 끝났든)이 확장 저장소에 남지 않는다', async ({
  context,
  extensionId,
}) => {
  const worker = await serviceWorkerOf(context);
  const running = await openPage(context);
  const finished = await openPage(context, 'video.html');
  await tabIdOf(worker, running);
  for (const page of [running, finished]) {
    const opened = await popupFor(context, extensionId, page);
    await opened.run(page === running ? fixtureTask.name : fixtureOther.name).click();
    await expect(opened.status).toHaveText(/진행 중이다/);
    await opened.popup.close();
  }
  await release(worker, fixtureOther.id, 'succeed');
  await expect
    .poll(async () => Object.values((await taskRecords(worker)) ?? {}).map((task: unknown) => task))
    .toEqual([
      expect.objectContaining({ status: 'running' }),
      expect.objectContaining({ status: 'succeeded' }),
    ]);
  await running.close();
  await finished.close();
  await expect.poll(() => taskRecords(worker)).toEqual({});
});

test('COM-10.7 작업이 진행 중인 탭의 팝업은 다른 작업 기능에 이유를 보이고, 서비스 워커에 직접 보내도 거절된다', async ({
  context,
  extensionId,
}) => {
  const worker = await serviceWorkerOf(context);
  const page = await openPage(context);
  const tabId = await tabIdOf(worker, page);
  const opened = await popupFor(context, extensionId, page);
  await opened.run(fixtureTask.name).click();
  await expect(opened.reason(fixtureOther.id)).toHaveText(
    '쓸 수 없음: 이 탭에서 시험 작업 진행 중',
  );
  await expect(opened.run(fixtureOther.name)).toHaveAttribute('aria-disabled', 'true');
  // 막힌 단추를 눌러도 시작하지 않는다. Playwright는 aria-disabled인 단추가 풀릴 때까지 기다리므로 강제로 누른다.
  await opened.run(fixtureOther.name).click({ force: true });

  const direct: unknown = await opened.popup.evaluate(
    ({ type, payload }) => chrome.runtime.sendMessage({ type, payload }),
    { type: taskStart.type, payload: { featureId: fixtureOther.id, tabId } },
  );
  expect(direct).toEqual({
    ok: false,
    error: { kind: 'unavailable', message: '이 탭에서 시험 작업 진행 중이다. 끝난 뒤 다시 한다.' },
  });
  expect(await taskRecords(worker)).toEqual({
    [String(tabId)]: expect.objectContaining({ featureId: fixtureTask.id, status: 'running' }),
  });
});

test('COM-10.8 결과를 본 확인이 다음 작업을 시작한 뒤에 닿아도 다음 작업의 진행과 결과, 배지가 그대로 남는다', async ({
  context,
  extensionId,
}) => {
  const worker = await serviceWorkerOf(context);
  const page = await openPage(context);
  const tabId = await tabIdOf(worker, page);
  // 팝업 없이 확장 화면에서 요청을 보낸다. 팝업은 결과를 보이면 바로 확인하므로 확인이 늦게 닿는 때를 시험이 정할 수 없다.
  const helper = await openPopup(context, extensionId);
  const send = (type: string, payload: unknown): Promise<unknown> =>
    helper.evaluate((message) => chrome.runtime.sendMessage(message), { type, payload });

  const first = v.safeParse(
    responseSchema(taskStart.value),
    await send(taskStart.type, { featureId: fixtureTask.id, tabId }),
  );
  if (!first.success || !first.output.ok) throw new Error('첫 작업을 시작하지 못했다.');
  const { taskId } = first.output.value;
  await release(worker, fixtureTask.id, 'succeed');
  await expect.poll(() => badgeOf(worker, tabId)).toMatchObject({ text: '✓' });
  // 결과를 본 팝업이 확인을 보내기 전에 같은 탭에서 다음 작업이 시작되었다.
  expect(await send(taskStart.type, { featureId: fixtureOther.id, tabId })).toMatchObject({
    ok: true,
  });
  await expect.poll(() => badgeOf(worker, tabId)).toEqual({ text: '', title: defaultTitle });
  const late = await send(taskSeen.type, { tabId, taskId });
  expect(late).toEqual({ ok: true, value: null });
  expect(await taskRecords(worker)).toEqual({
    [String(tabId)]: expect.objectContaining({ featureId: fixtureOther.id, status: 'running' }),
  });
  await release(worker, fixtureOther.id, 'succeed');
  await expect
    .poll(() => badgeOf(worker, tabId))
    .toEqual({ text: '✓', title: `${defaultTitle}: 다른 시험 작업 끝남` });
});

test('결정 0024 그 탭을 보는 팝업이 열려 있는 동안 끝나면 페이지 위에 알리지 않고 팝업이 보인 뒤 배지를 지운다', async ({
  context,
  extensionId,
}) => {
  const worker = await serviceWorkerOf(context);
  const page = await openPage(context);
  const tabId = await tabIdOf(worker, page);
  const opened = await popupFor(context, extensionId, page);
  await opened.run(fixtureTask.name).click();
  await expect(opened.status).toHaveText('시험 작업: 진행 중이다.');
  await page.bringToFront();
  await release(worker, fixtureTask.id, 'succeed');
  await expect(opened.status).toHaveText(`시험 작업: 끝났다. ${fixtureSummary}`);
  await expect.poll(() => taskRecords(worker)).toEqual({});
  await expect.poll(() => badgeOf(worker, tabId)).toEqual({ text: '', title: defaultTitle });
  // 알림은 끝을 쓴 뒤 바로 보내므로, 기록이 지워질 때까지 없었으면 보내지 않은 것이다. 조금 더 본다.
  await page.waitForTimeout(500);
  expect(await noticeTexts(page)).toEqual([]);
});

test('결정 0024 그 탭이 창의 지금 탭이 아니면 페이지 위에 알리지 않고 배지만 단다', async ({
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
  const other = await openPage(context, 'video.html');
  await other.bringToFront();
  await release(worker, fixtureTask.id, 'succeed');
  await expect.poll(() => badgeOf(worker, tabId)).toMatchObject({ text: '✓' });
  await page.waitForTimeout(500);
  expect(await noticeTexts(page)).toEqual([]);
});

test('결정 0024 보지 않은 결과가 있는 탭은 다른 문서로 이동하거나 새로 고쳐도 배지와 제목이 남는다(Chrome이 지운 것을 다시 단다)', async ({
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
  await release(worker, fixtureTask.id, 'succeed');
  const done = { text: '✓', title: `${defaultTitle}: 시험 작업 끝남` };
  await expect.poll(() => badgeOf(worker, tabId)).toEqual(done);
  await page.goto(`${fixtureOrigin}/video.html`);
  await expect.poll(() => badgeOf(worker, tabId)).toEqual(done);
  await page.reload();
  await expect.poll(() => badgeOf(worker, tabId)).toEqual(done);
});

test('COM-2.5 키보드만으로 실행 기능을 찾아 실행한다', async ({ context, extensionId }) => {
  const worker = await serviceWorkerOf(context);
  const page = await openPage(context);
  const tabId = await tabIdOf(worker, page);
  const popup = await openPopupOn(context, extensionId, page);
  const button = popup.getByRole('button', { name: fixtureTask.name, exact: true });
  // 설정을 읽어 화면을 그린 뒤에 키를 누른다.
  await expect(popup.getByRole('combobox', { name: '기능 검색' })).toBeVisible();
  await popup.keyboard.press('Control+KeyK');
  await popup.keyboard.type('시험 작업');
  await popup.keyboard.press('Enter');
  await expect(button).toBeFocused();
  // 서비스 워커가 깨어나 단추를 쓸 수 있게 된 뒤에 누른다(N-12).
  await expect(button).not.toHaveAttribute('aria-disabled', 'true');
  await popup.keyboard.press('Enter');
  await expect(popup.locator('.task')).toHaveText('시험 작업: 진행 중이다.');
  expect(await taskRecords(worker)).toEqual({
    [String(tabId)]: expect.objectContaining({ featureId: fixtureTask.id, status: 'running' }),
  });
});

test.describe('다시 불러오기', () => {
  test.use({ browserDebugging: true });

  test('COM-10 기대 동작 5 확장을 다시 불러오면 작업 기록과 배지가 사라진다', async ({
    context,
    extensionId,
    profileDirectory,
  }) => {
    const worker = await serviceWorkerOf(context);
    const page = await openPage(context);
    const tabId = await tabIdOf(worker, page);
    const opened = await popupFor(context, extensionId, page);
    await opened.run(fixtureTask.name).click();
    await expect(opened.status).toHaveText('시험 작업: 진행 중이다.');
    await opened.popup.close();
    await release(worker, fixtureTask.id, 'succeed');
    await expect.poll(() => badgeOf(worker, tabId)).toMatchObject({ text: '✓' });

    // 사용자가 "다시 로드"를 누르는 것과 같은 일(R-04).
    const cdp = await connectBrowserCdp(profileDirectory);
    try {
      expect(await cdp.send('Extensions.loadUnpacked', { path: fixtureDistPath })).toEqual({
        id: extensionId,
      });
    } finally {
      cdp.close();
    }
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
  });
});
