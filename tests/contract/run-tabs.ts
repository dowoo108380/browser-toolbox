import { taskNotice } from '../../src/contracts/index.ts';
import {
  type Delivery,
  isTabActive,
  sendToTab,
  setAutoDiscardable,
  setTabBadge,
  tabExists,
  tabInfo,
  windowInfo,
} from '../../src/platform/index.ts';

// 탭 경계(결정 0024, 0041)가 실제 Chrome에서 실험대로, 그리고 시험의 가짜 Chrome(tests/support/fake-browser.ts)과 같게 나누는지
// 확장의 서비스 워커 안에서 돌린다. 확장 전체 시험이
// 이 파일을 esbuild로 묶어 서비스 워커에서 실행한다(tests/e2e/tab-contract.spec.ts). 배포물에는 들어가지 않는다.
// 거절 문구로 나누는 곳(받는 쪽이 없음, 닫힌 탭)이 Chrome이 바뀌어 어긋나면 여기서 드러난다.

export interface TabIds {
  // 이 확장의 콘텐츠 스크립트가 도는 페이지.
  readonly page: number;
  // 확장이 스크립트를 넣을 수 없는 페이지(chrome://).
  readonly internal: number;
  // 닫은 탭.
  readonly closed: number;
}

export interface TabContractResult {
  readonly deliveries: Readonly<Record<keyof TabIds, Delivery>>;
  readonly exists: Readonly<Record<keyof TabIds, boolean>>;
  readonly active: Readonly<Record<keyof TabIds, boolean>>;
  // 닫힌 탭에 배지를 달고 지울 때 던진 오류. 던지지 않았으면 null이다.
  readonly closedBadgeError: string | null;
  // 탭마다 켜고 끄는 기능이 보는 탭의 사정(결정 0041, 0045): 닫힌 탭이면 null, 열린 탭은 창에 나와 있는지, 싣는 중인지,
  // 쉬는지.
  readonly info: Readonly<
    Record<
      keyof TabIds,
      { readonly shown: boolean; readonly loading: boolean; readonly asleep: boolean } | null
    >
  >;
  // Chrome이 비운 탭이 쉬는 것으로 보이는지(결정 0045). 얼린 탭은 이 시험의 브라우저(Playwright가 띄움)에서 디버거로 얼려도
  // Chrome의 frozen이 바뀌지 않아 보지 않는다(직접 띄운 Chromium에서는 바뀌었다, 2026-10-21 실험).
  readonly asleep: { readonly discarded: boolean | null };
  // 닫힌 창의 사정(null이어야 한다)과 지금 창의 사정.
  readonly closedWindow: unknown;
  readonly pageWindow: unknown;
  // 닫힌 탭의 autoDiscardable을 바꿀 때 던진 오류. 던지지 않았으면 null이다.
  readonly closedDiscardableError: string | null;
}

const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

// 그 주소를 뒤쪽 탭으로 열어 다 실은 뒤 Chrome이 비우게 하고, 그 탭이 쉬는 것으로 보이는지 준다. 탭은 닫는다.
async function asleepAfterDiscard(url: string): Promise<boolean | null> {
  const opened = await chrome.tabs.create({ url, active: false });
  if (opened.id === undefined) throw new Error('탭 id가 없다.');
  for (let waited = 0; (await chrome.tabs.get(opened.id)).status !== 'complete'; waited += 50) {
    if (waited > 5000) throw new Error('탭을 다 싣지 못했다.');
    await pause(50);
  }
  const tabId = (await chrome.tabs.discard(opened.id))?.id ?? opened.id;
  const asleep = (await tabInfo(tabId))?.asleep ?? null;
  await chrome.tabs.remove(tabId);
  return asleep;
}

export async function run(tabs: TabIds): Promise<TabContractResult> {
  const each = async <T>(probe: (tabId: number) => Promise<T>) => ({
    page: await probe(tabs.page),
    internal: await probe(tabs.internal),
    closed: await probe(tabs.closed),
  });
  let closedBadgeError: string | null = null;
  try {
    await setTabBadge(tabs.closed, { text: '!', color: '#c62828', title: '계약 시험' });
    await setTabBadge(tabs.closed, null);
  } catch (error) {
    closedBadgeError = error instanceof Error ? error.message : String(error);
  }
  const pageTab = await tabInfo(tabs.page);
  const closingWindow = await chrome.windows.create({});
  if (closingWindow?.id === undefined) throw new Error('창 id가 없다.');
  await chrome.windows.remove(closingWindow.id);
  let closedDiscardableError: string | null = null;
  try {
    await setAutoDiscardable(tabs.closed, false);
  } catch (error) {
    closedDiscardableError = error instanceof Error ? error.message : String(error);
  }
  return {
    info: await each(async (tabId) => {
      const info = await tabInfo(tabId);
      return info === null
        ? null
        : { shown: info.shown, loading: info.loading, asleep: info.asleep };
    }),
    asleep: {
      discarded: pageTab?.url === undefined ? null : await asleepAfterDiscard(pageTab.url),
    },
    closedWindow: await windowInfo(closingWindow.id),
    pageWindow: pageTab === null ? null : await windowInfo(pageTab.windowId),
    closedDiscardableError,
    deliveries: await each(
      async (tabId) => (await sendToTab(taskNotice, tabId, { text: '계약 시험' })).delivery,
    ),
    exists: await each(tabExists),
    active: await each(isTabActive),
    closedBadgeError,
  };
}

declare global {
  // 이 파일을 묶어 서비스 워커에서 실으면 이 전역에 실행기를 둔다(tests/contract/run-store.ts와 같다).
  var tabContractRunner: { readonly run: typeof run } | undefined;
}

globalThis.tabContractRunner = { run };
