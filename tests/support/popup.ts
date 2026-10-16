import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import {
  type FeatureDefinition,
  featuresWithSettings,
  popupRemember,
  repairNoticeDismiss,
  settingsUpdate,
  storageEnsureReady,
  tabStatus,
  taskStart,
} from '../../src/contracts/index.ts';
import type { KeyValueStore, Requester } from '../../src/platform/index.ts';
import {
  readRememberedCategory,
  settingsFormat,
  startSettingsReader,
  watchRepairNotice,
} from '../../src/storage/index.ts';
import { PopupApp } from '../../src/ui/index.ts';

// 실제 모듈끼리 연결한 시험(tests/integration)이 팝업을 실제 진입점(src/entries/popup.tsx)과 같게 조립해 그린다.
// 가짜는 Chrome 경계(저장소, 메시지 통로)뿐이다. 이 폴더는 src 밖이라 tsconfig.json의 JSX 설정(Preact)이 걸리지
// 않으므로 JSX 대신 h()를 쓴다. 테스트에서만 가져온다.

export interface TestPopupOptions {
  readonly store: KeyValueStore;
  readonly request: Requester;
  readonly features: readonly FeatureDefinition[];
  // 복구 알림 읽기만 다른 저장소 창을 쓰게 할 수 있다. 없으면 store다.
  readonly noticeStore?: Pick<KeyValueStore, 'get' | 'onChanged'>;
}

export async function renderTestPopup(
  container: HTMLElement,
  { store, request, features, noticeStore = store }: TestPopupOptions,
): Promise<void> {
  await act(() => {
    render(
      h(PopupApp, {
        features,
        subscribe: (handlers) =>
          startSettingsReader(
            { store, request, format: settingsFormat, specs: featuresWithSettings(features) },
            handlers,
          ),
        watchRepairs: (handlers) => watchRepairNotice(noticeStore, handlers),
        wake: () => request(storageEnsureReady, {}),
        update: (featureId, patch) => request(settingsUpdate, { featureId, patch }),
        dismissRepair: (stamp) => request(repairNoticeDismiss, { stamp }),
        rememberedCategory: () => readRememberedCategory(store),
        rememberCategory: (category) => request(popupRemember, { category }),
        // 지금 탭은 시험이 정하지 않는다. 탐침 결과는 서비스 워커의 probePage가 정한다.
        currentTab: () => Promise.resolve(1),
        tabStatus: (tabId) => request(tabStatus, { tabId }),
        startTask: (featureId, tabId) => request(taskStart, { featureId, tabId }),
      }),
      container,
    );
  });
}

// 그 기능의 스위치. 팝업은 고른 범주의 기능만 보이므로(결정 0023) 스위치가 보일 때까지 범주를 차례로 고른다.
export function switchOf(container: HTMLElement, featureId: string): HTMLInputElement | null {
  const selector = `[data-feature="${featureId}"]`;
  for (const tab of container.querySelectorAll<HTMLElement>('[role=tab]')) {
    if (container.querySelector(selector) !== null) break;
    // 콜백이 동기라 act가 돌아오기 전에 그리기를 마친다. 돌려주는 Promise는 기다릴 것이 없다.
    void act(() => {
      tab.click();
    });
  }
  return container.querySelector<HTMLInputElement>(selector);
}
