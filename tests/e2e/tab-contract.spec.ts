import path from 'node:path';
import type { BrowserContext } from '@playwright/test';
import { build } from 'esbuild';
import type { TabIds } from '../contract/run-tabs.ts';
import { expect, fixtureOrigin, serviceWorkerOf, test } from './support/extension.ts';

// 탭 경계(src/platform/tab-messaging.ts, action.ts, tabs.ts, 결정 0024)와 디버거 경계(src/platform/debugger.ts, 결정 0042)가
// 실제 Chromium에서 실험대로 나누는지 확장의 서비스 워커 안에서 직접 본다. 단위 시험과 모듈 연결 시험의 가짜(가짜 경계,
// tests/support/fake-browser.ts)는 거절 문구와 Chrome의 동작을 시험이 정하므로, Chrome의 실제 문구나 동작이 바뀌면 여기서
// 드러난다.

const contract = path.resolve(import.meta.dirname, '..', 'contract');

// 계약 실행기를 묶어 서비스 워커에 싣는다.
async function load(context: BrowserContext, runner: string) {
  const worker = await serviceWorkerOf(context);
  const bundled = await build({
    entryPoints: [path.join(contract, runner)],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    logLevel: 'warning',
  });
  const code = bundled.outputFiles[0]?.text;
  if (code === undefined) throw new Error('계약 실행기를 묶지 못했다.');
  await worker.evaluate(code);
  return worker;
}

// 콘텐츠 스크립트가 도는 페이지(지금 탭), Chrome 내부 페이지, 닫은 탭.
async function openTabs(context: BrowserContext): Promise<TabIds> {
  const worker = await serviceWorkerOf(context);
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
  return { page: await tabIdOfFront(), internal: internalId, closed: closedId };
}

test('COM-10 결정 0024 결정 0041 결정 0045 탭에 보내기는 콘텐츠 스크립트가 있는 페이지만 delivered이고, Chrome 내부 페이지와 닫힌 탭은 unreachable이며, 닫힌 탭과 닫힌 창의 사정은 null이고 닫힌 탭을 다뤄도 던지지 않으며, Chrome이 비운 탭은 쉬는 것으로 보인다', async ({
  context,
}) => {
  const tabs = await openTabs(context);
  const worker = await load(context, 'run-tabs.ts');
  const result = await worker.evaluate((ids) => {
    if (tabContractRunner === undefined) throw new Error('계약 실행기가 실리지 않았다.');
    return tabContractRunner.run(ids);
  }, tabs);
  expect(result).toEqual({
    deliveries: { page: 'delivered', internal: 'unreachable', closed: 'unreachable' },
    exists: { page: true, internal: true, closed: false },
    active: { page: true, internal: false, closed: false },
    closedBadgeError: null,
    info: {
      page: { shown: true, loading: false, asleep: false },
      internal: { shown: false, loading: false, asleep: false },
      closed: null,
    },
    asleep: { discarded: true },
    closedWindow: null,
    pageWindow: { minimized: false, focused: true },
    closedDiscardableError: null,
  });
});

test('결정 0042 이미 붙은 탭에 다시 붙이기와 붙지 않은 탭에서 떼기는 성공이고, 뗀 탭에 명령은 platform이며, Chrome 내부 페이지와 닫힌 탭에는 붙이지 못한다(permission)', async ({
  context,
}) => {
  const tabs = await openTabs(context);
  const worker = await load(context, 'run-debugger.ts');
  const result = await worker.evaluate((ids) => {
    if (debuggerContractRunner === undefined) throw new Error('계약 실행기가 실리지 않았다.');
    return debuggerContractRunner.run(ids);
  }, tabs);
  expect(result).toEqual({
    attach: 'ok',
    attachAgain: 'ok',
    command: 'ok',
    detach: 'ok',
    detachAgain: 'ok',
    commandAfterDetach: 'platform',
    attachInternal: 'permission',
    attachClosed: 'permission',
  });
});
