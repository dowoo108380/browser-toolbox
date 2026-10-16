import { taskNotice } from '../../src/contracts/index.ts';
import {
  type Delivery,
  isTabActive,
  sendToTab,
  setTabBadge,
  tabExists,
} from '../../src/platform/index.ts';

// 탭 경계(결정 0024)가 실제 Chrome에서 결정 0024의 실험대로 나누는지 확장의 서비스 워커 안에서 돌린다. 확장 전체 시험이
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
  return {
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
