import type { BrowserContext, Page, Worker } from '@playwright/test';
import { type Release, fixtureTask, releaseKey } from '../../extension/fixture-tasks.ts';
import { expect, fixtureOrigin, openPopupOn } from './extension.ts';

// 시험 빌드의 시험 작업(결정 0025)으로 작업 결과 알림(COM-10, 결정 0024)을 보는 확장 전체 시험의 도우미. 일의 끝은 시험이
// 서비스 워커에서 storage.session에 쓴다. 팝업 문서는 탭으로 열고(openPopupOn), 닫으면 팝업이 닫힌 것과 같이 연결이
// 끊긴다(결정 0024의 실험 4).

export const defaultTitle = 'Browser Toolbox';

let serial = 0;

// 그 기능의 일을 outcome으로 끝낸다.
export async function release(worker: Worker, featureId: string, outcome: Release['outcome']) {
  serial += 1;
  const value: Release = { featureId, outcome, serial };
  await worker.evaluate(
    async ({ key, written }) => {
      await chrome.storage.session.set({ [key]: written });
    },
    { key: releaseKey, written: value },
  );
}

// 그 페이지의 탭 id. Playwright가 연 페이지는 모두 한 창에 있다(결정 0023의 실험). 앞으로 가져온 뒤 그 창의 지금 탭으로 찾는다.
export async function tabIdOf(worker: Worker, page: Page): Promise<number> {
  await page.bringToFront();
  return worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id === undefined) throw new Error('지금 탭이 없다.');
    return tab.id;
  });
}

export function badgeOf(worker: Worker, tabId: number) {
  return worker.evaluate(
    async (id) => ({
      text: await chrome.action.getBadgeText({ tabId: id }),
      title: await chrome.action.getTitle({ tabId: id }),
    }),
    tabId,
  );
}

// 작업 기록(storage.session의 tasks). 없으면 null이다.
export function taskRecords(worker: Worker): Promise<unknown> {
  return worker.evaluate(async () => {
    const { tasks }: Record<string, unknown> = await chrome.storage.session.get('tasks');
    return tasks ?? null;
  });
}

// 그 페이지를 지금 탭으로 둔 팝업. 시험 기능은 "탭" 범주에 있다.
export async function popupFor(context: BrowserContext, extensionId: string, page: Page) {
  const popup = await openPopupOn(context, extensionId, page);
  await popup.getByRole('tab', { name: '탭' }).click();
  const run = (name: string) => popup.getByRole('button', { name, exact: true });
  await expect(run(fixtureTask.name)).toBeVisible();
  return {
    popup,
    run,
    status: popup.locator('.task'),
    reason: (featureId: string) => popup.locator(`#feature-unavailable-${featureId}`),
  };
}

export async function openPage(context: BrowserContext, path = 'blank.html'): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${fixtureOrigin}/${path}`);
  return page;
}
