import path from 'node:path';
import { build } from 'esbuild';
import { expect, fixtureOrigin, serviceWorkerOf, test } from './support/extension.ts';

// 결정 0024 탭 경계(src/platform/tab-messaging.ts, action.ts, tabs.ts)가 실제 Chromium에서 결정 0024의 실험대로 나누는지
// 확장의 서비스 워커 안에서 직접 본다. COM-10 기대 동작 4: 페이지에 넣을 수 없는 탭(Chrome 내부 페이지)과 닫힌 탭은
// 받는 쪽이 없는 것(unreachable)이라 배지만 쓰고 문제로 기록하지 않는다. 가짜 경계의 단위 시험은 거절 문구를 시험이 정하므로,
// Chrome의 실제 문구가 바뀌면 여기서 드러난다.

const runner = path.resolve(import.meta.dirname, '..', 'contract', 'run-tabs.ts');

test('COM-10 결정 0024 탭에 보내기는 콘텐츠 스크립트가 있는 페이지만 delivered이고, Chrome 내부 페이지와 닫힌 탭은 unreachable이며, 닫힌 탭의 배지는 던지지 않는다', async ({
  context,
}) => {
  const worker = await serviceWorkerOf(context);
  const bundled = await build({
    entryPoints: [runner],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    logLevel: 'warning',
  });
  const code = bundled.outputFiles[0]?.text;
  if (code === undefined) throw new Error('계약 실행기를 묶지 못했다.');

  const tabIdOfFront = () =>
    worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab?.id === undefined) throw new Error('지금 탭이 없다.');
      return tab.id;
    });
  const internal = await context.newPage();
  await internal.goto('chrome://version');
  await internal.bringToFront();
  const internalId = await tabIdOfFront();
  const closing = await context.newPage();
  await closing.goto(`${fixtureOrigin}/blank.html`);
  await closing.bringToFront();
  const closedId = await tabIdOfFront();
  await closing.close();
  const page = await context.newPage();
  await page.goto(`${fixtureOrigin}/blank.html`);
  await page.bringToFront();
  const pageId = await tabIdOfFront();

  await worker.evaluate(code);
  const result = await worker.evaluate(
    (tabs) => {
      if (tabContractRunner === undefined) throw new Error('계약 실행기가 실리지 않았다.');
      return tabContractRunner.run(tabs);
    },
    { page: pageId, internal: internalId, closed: closedId },
  );
  expect(result).toEqual({
    deliveries: { page: 'delivered', internal: 'unreachable', closed: 'unreachable' },
    exists: { page: true, internal: true, closed: false },
    active: { page: true, internal: false, closed: false },
    closedBadgeError: null,
  });
});
