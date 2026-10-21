import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineTaskPart } from '../../src/background/index.ts';
import { defineFeature, tabStatus, v } from '../../src/contracts/index.ts';
import { createFakeStore } from '../../src/platform/fake.ts';
import { type Requester, currentTabId } from '../../src/platform/index.ts';
import { ok } from '../../src/shared/index.ts';
import { startTestBackground } from '../support/background.ts';
import { renderTestPopup } from '../support/popup.ts';

// 팝업이 지금 탭을 Chrome에 묻는 길(결정 0023)을 실제 모듈끼리 연결해 본다. 지금 탭 묻기(platform의 currentTabId), 팝업,
// 서비스 워커는 실제 코드이고, 가짜는 저장소, 메시지 통로, chrome.tabs.query뿐이다. 부품 시험은 팝업에 가짜 지금 탭을 넣어
// Chrome이 거절하는 길을 지나지 않았다.

const containers: HTMLElement[] = [];
// 시험 동안 창에 닿은 처리되지 않은 거절(quality 008, 067).
const unhandled: unknown[] = [];
const collect = (event: PromiseRejectionEvent) => {
  unhandled.push(event.reason);
};

beforeEach(() => {
  window.addEventListener('unhandledrejection', collect);
});

afterEach(() => {
  for (const container of containers.splice(0)) {
    render(null, container);
    container.remove();
  }
  window.removeEventListener('unhandledrejection', collect);
  unhandled.splice(0);
  vi.unstubAllGlobals();
});

// 깨어났는지 스위치로 본다(N-12). 실행 기능은 지금 탭에서 작업을 시작하므로 지금 탭을 알아야 쓸 수 있다(결정 0024).
const sizeFeature = defineFeature({
  id: 'size',
  requirements: [],
  name: '자막 크기',
  description: '자막 크기 시험',
  category: 'subtitles',
  kind: 'toggle',
  content: null,
  permissions: [],
  settings: { schema: v.object({ enabled: v.boolean() }), defaults: { enabled: false } },
});
const saveFeature = defineFeature({
  id: 'save',
  requirements: [],
  name: '자막 저장',
  description: '자막 저장 시험',
  category: 'subtitles',
  kind: 'action',
  content: null,
  permissions: [],
  task: { timeoutMs: 60_000 },
  actions: [{ id: 'run', name: '자막 저장' }],
});
const features = [sizeFeature, saveFeature];
// 이 시험은 단추를 누르지 않는다. 서비스 워커가 실행 기능마다 일을 하나 요구해서 둔다.
const savePart = defineTaskPart(saveFeature, () => ({
  run: () => Promise.resolve(ok({ summary: null })),
  interrupted: () => Promise.resolve(),
}));

// Chrome이 지금 탭을 묻는 데 주는 답을 정하고 팝업을 연다. 팝업이 서비스 워커에 보낸 요청(종류와 내용)을 남긴다.
async function openPopup(query: () => Promise<unknown>) {
  const asked = vi.fn(query);
  vi.stubGlobal('chrome', { tabs: { query: asked } });
  const store = createFakeStore();
  const background = startTestBackground({
    store,
    features,
    taskParts: [savePart],
    startTime: 1_790_000_000_000,
  });
  const requests: [type: string, payload: unknown][] = [];
  const request: Requester = (definition, payload) => {
    requests.push([definition.type, payload]);
    return background(definition, payload);
  };
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  await renderTestPopup(container, { store, request, features, currentTab: currentTabId });
  const button = () => {
    const found = container.querySelector<HTMLButtonElement>('button[data-feature="save"]');
    if (found === null) throw new Error('실행 단추가 없다.');
    return found;
  };
  await vi.waitFor(() => {
    expect(container.querySelector<HTMLInputElement>('[role=switch]')?.disabled).toBe(false);
  });
  return {
    asked,
    requests,
    button,
    status: () => container.querySelector('[role=status]')?.textContent ?? null,
  };
}

// 거절이 처리되지 않았으면 그 알림은 다음 차례의 일로 온다. 한 차례를 넘겨 받는다.
const nextTask = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

describe('결정 0023 팝업이 Chrome에 지금 탭을 묻는다', () => {
  it('Chrome이 준 지금 탭으로 그 탭의 상태를 묻고 실행 단추를 연다', async () => {
    const popup = await openPopup(() => Promise.resolve([{ id: 4, active: true }]));
    expect(popup.asked).toHaveBeenCalledWith({ active: true, currentWindow: true });
    await vi.waitFor(() => {
      expect(popup.button().hasAttribute('aria-disabled')).toBe(false);
    });
    expect(popup.requests).toContainEqual([tabStatus.type, { tabId: 4 }]);
  });

  it('quality 067 Chrome이 거절하면 그 까닭을 알리고 탭의 상태를 묻지 않으며 실행 단추를 막아 둔다. 처리되지 않은 거절이 없다', async () => {
    const popup = await openPopup(() => Promise.reject(new Error('알려지지 않은 거절')));
    await vi.waitFor(() => {
      expect(popup.status()).toBe('지금 탭을 Chrome에서 받지 못했다. 팝업을 닫았다가 다시 연다.');
    });
    await nextTask();
    expect(unhandled).toEqual([]);
    expect(popup.requests.map(([type]) => type)).not.toContain(tabStatus.type);
    expect(popup.button().getAttribute('aria-disabled')).toBe('true');
  });
});
