import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/mini';
import {
  type PageStatus,
  defineFeature,
  featuresWithSettings,
  problemReport,
  retireEventName,
} from '../../src/contracts/index.ts';
import { type NamedElement, pageElementAttribute } from '../../src/dom/index.ts';
import { definePagePart, startPageRuntime } from '../../src/page/index.ts';
import { createFakeStore } from '../../src/platform/fake.ts';
import { settingsFormat, startSettingsReader } from '../../src/storage/index.ts';
import { startTestBackground } from '../support/background.ts';
import { renderTestPopup, switchOf } from '../support/popup.ts';

// 외부 화면 요소를 찾지 못함(COM-6, 결정 0026)을 실제 모듈끼리 연결해 본다. 콘텐츠 스크립트의 실행 틀(찾기, 기능 수명,
// 상태 답), 서비스 워커(라우터, 문제 기록, tab.status가 실행 틀에 묻기), 팝업(스위치, 이유)은 실제 코드이고, 가짜는
// 저장소, 메시지 통로, 탭 통로(서비스 워커가 실행 틀에 묻는 길)뿐이다. 실행 틀은 이 문서에서 돈다. 기능을 켜기 전부터
// 시계는 가짜다(15초를 기다리지 않는다).

const containers: HTMLElement[] = [];
const added: Element[] = [];
const runtimes: { connected: boolean }[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const container of containers.splice(0)) {
    render(null, container);
    container.remove();
  }
  for (const element of added.splice(0)) element.remove();
  // 실행 틀을 물러나게 해 다음 시험에 남기지 않는다.
  for (const runtime of runtimes.splice(0)) runtime.connected = false;
  document.dispatchEvent(new Event(retireEventName));
  for (const element of document.querySelectorAll(`[${pageElementAttribute}]`)) element.remove();
});

const region: NamedElement = {
  id: 'test.region',
  name: '시험 영역',
  find: (root) => root.querySelector('[aria-label="시험 영역"]'),
};

const regionFeature = defineFeature({
  id: 'region',
  requirements: [],
  name: '영역 기능',
  description: '시험 영역에 기대는 기능',
  category: 'page',
  kind: 'toggle',
  content: { sites: 'all', frames: 'top' },
  permissions: [],
  settings: { schema: z.object({ enabled: z.boolean() }), defaults: { enabled: false } },
});

// 켜지면 문서 루트에 표시를 달고(반쯤 적용한 변경), 시험 영역을 찾으면 그 영역에도 표시를 단다.
const regionPart = definePagePart(regionFeature, (_settings, { document, scope, find }) => {
  const root = document.documentElement;
  root.setAttribute('data-test-region', 'waiting');
  scope.defer(() => {
    root.removeAttribute('data-test-region');
  });
  find(region, (element) => {
    element.setAttribute('data-test-applied', '');
    scope.defer(() => {
      element.removeAttribute('data-test-applied');
    });
  });
});

const features = [regionFeature];

// 마이크로태스크를 몇 차례 흘려 보낸다.
async function settle() {
  for (let step = 0; step < 20; step += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

// 마이크로태스크만으로 도는 가짜 경계라, 조건이 이루어질 때까지 마이크로태스크를 흘려 보낸다.
async function until(condition: () => boolean) {
  for (let step = 0; step < 200; step += 1) {
    if (condition()) return;
    await act(async () => {
      await Promise.resolve();
    });
  }
  throw new Error('조건이 이루어지지 않았다.');
}

function startExtension() {
  const store = createFakeStore();
  const runtime = { connected: true };
  runtimes.push(runtime);
  // 실행 틀이 서비스 워커의 물음에 답하는 함수(탭 통로). 실행 틀이 물러나면 없다. 물은 횟수를 센다.
  let answer: (() => PageStatus) | undefined;
  let asks = 0;
  const request = startTestBackground({
    store,
    features,
    startTime: 1_790_000_000_000,
    askPage: () => {
      asks += 1;
      return Promise.resolve(
        answer === undefined
          ? { delivery: 'unreachable' as const }
          : { delivery: 'delivered' as const, value: answer() },
      );
    },
  });
  startPageRuntime({
    parts: [regionPart],
    context: { window, document },
    // 시험 문서는 Vitest의 iframe이지만, 서비스 워커가 묻는 탭의 최상위 프레임 노릇을 한다.
    topFrame: true,
    subscribe: (handlers) =>
      startSettingsReader(
        { store, request, format: settingsFormat, specs: featuresWithSettings(features) },
        handlers,
      ),
    report: (problem) => request(problemReport, problem),
    isConnected: () => runtime.connected,
    listenNotices: () => () => undefined,
    listenStatus: (next) => {
      answer = next;
      return () => {
        answer = undefined;
      };
    },
  });

  const openPopup = async () => {
    const askedBefore = asks;
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    await renderTestPopup(container, { store, request, features });
    const toggle = () => switchOf(container, 'region');
    const reason = () => toggle()?.closest('li')?.querySelector('.reason')?.textContent ?? null;
    // 서비스 워커가 깨어나 스위치를 쓸 수 있고, 지금 탭의 상태를 물으며 실행 틀에도 물을 때까지. 그 답이 팝업에 닿아
    // 그려지도록 몇 차례 더 흘려 보낸다.
    await until(() => toggle()?.disabled === false && asks > askedBefore);
    await settle();
    return {
      toggle,
      reason,
      close: () => {
        render(null, container);
      },
    };
  };

  return { store, openPopup };
}

describe('COM-6 외부 화면 요소를 찾지 못함(실제 실행 틀, 서비스 워커, 팝업)', () => {
  it('COM-6.1 COM-6.3 찾지 못하면 그 기능을 되돌리고 기록하며 다시 연 팝업이 "찾지 못함"을 보이고, 나타나면 작용해 그 표시가 사라진다', async () => {
    const extension = startExtension();
    const first = await extension.openPopup();
    const before = document.documentElement.getAttributeNames();

    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
    });
    await act(() => {
      first.toggle()?.click();
    });
    await until(() => document.documentElement.getAttribute('data-test-region') === 'waiting');
    first.close();

    // 15초 전에는 찾는 중이라 팝업에 이유가 없다.
    vi.advanceTimersByTime(14_000);
    const searching = await extension.openPopup();
    expect(searching.toggle()?.checked).toBe(true);
    expect(searching.reason()).toBeNull();
    searching.close();

    vi.advanceTimersByTime(1000);
    await until(() => extension.store.peek('problems') !== undefined);
    expect(document.documentElement.getAttributeNames()).toEqual(before);
    expect(extension.store.peek('problems')).toMatchObject([
      {
        featureId: 'region',
        kind: 'not-found',
        element: { id: 'test.region', name: '시험 영역' },
      },
    ]);
    const missing = await extension.openPopup();
    expect(missing.reason()).toBe('찾지 못함: 시험 영역');
    expect(missing.toggle()?.disabled).toBe(false);
    missing.close();

    const element = document.createElement('section');
    element.setAttribute('aria-label', '시험 영역');
    document.body.append(element);
    added.push(element);
    await until(() => element.hasAttribute('data-test-applied'));
    const reopened = await extension.openPopup();
    expect(reopened.toggle()?.checked).toBe(true);
    expect(reopened.reason()).toBeNull();
    expect(extension.store.peek('problems')).toHaveLength(1);
  });
});
