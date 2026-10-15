import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeLocalStore, createFakeLocalStore } from '../../src/platform/fake.ts';
import { settingsKey } from '../../src/storage/index.ts';

// 설치·갱신 때 열린 탭의 옛 스크립트 정리(결정 0008)를 서비스 워커 쪽 실제 모듈끼리 연결해 본다. 진입점
// (src/entries/sw.ts)을 그대로 실으므로 서비스 워커 시작, 정리(retireInAllFrames), 문제 기록과 그 연결이 모두 실제 코드다.
// 가짜는 Chrome 경계뿐이다: chrome.storage.local(시험용 가짜 저장소에 잇는다), 이벤트 등록, chrome.tabs.query,
// chrome.scripting.executeScript. 시계는 가짜라 제한 시간을 시험이 정한 때에 넘긴다.

interface Injection {
  readonly target: { readonly tabId: number; readonly documentIds?: readonly string[] };
}

// ms 뒤에 value로 끝나는 응답.
const after = <T>(ms: number, value: T) =>
  new Promise<T>((resolve) => {
    setTimeout(() => {
      resolve(value);
    }, ms);
  });

type MessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean;

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';

function fakeChrome(
  store: FakeLocalStore,
  tabs: readonly { readonly id: number }[],
  executeScript: (injection: Injection) => Promise<unknown>,
  // 문제 기록(problems)을 저장하는 데 걸리는 시간. 저장의 끝에는 계약이 없다.
  problemsSaveMs = 0,
) {
  let installed: (() => void) | undefined;
  let onMessage: MessageListener | undefined;
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: (key: string) => {
          const value = store.peek(key);
          return Promise.resolve(value === undefined ? {} : { [key]: value });
        },
        set: async (items: Readonly<Record<string, unknown>>) => {
          if ('problems' in items && problemsSaveMs > 0) await after(problemsSaveMs, null);
          await store.set(items);
        },
      },
      onChanged: { addListener: () => undefined, removeListener: () => undefined },
    },
    runtime: {
      id: extensionId,
      getURL: (path: string) => `chrome-extension://${extensionId}/${path}`,
      onMessage: {
        addListener: (listener: MessageListener) => {
          onMessage = listener;
        },
      },
      onInstalled: {
        addListener: (listener: () => void) => {
          installed = listener;
        },
      },
    },
    tabs: { query: () => Promise.resolve(tabs) },
    scripting: { executeScript },
  });
  return {
    install: () => {
      if (installed === undefined) throw new Error('서비스 워커가 설치 이벤트를 듣지 않는다.');
      installed();
    },
    // 콘텐츠 스크립트가 보낸 것처럼 서비스 워커에 요청을 보내고 응답을 돌려준다.
    send: (message: unknown) =>
      new Promise<unknown>((resolve) => {
        if (onMessage === undefined) throw new Error('서비스 워커가 요청을 듣지 않는다.');
        const sender = { id: extensionId, origin: 'http://a.test', tab: { id: 1 }, frameId: 0 };
        onMessage(message, sender, resolve);
      }),
  };
}

// 문제 기록에 남은 종류들.
function recordedKinds(store: FakeLocalStore): unknown[] {
  const records = store.peek('problems');
  if (!Array.isArray(records)) return [];
  const list: unknown[] = records;
  return list.map((record) =>
    typeof record === 'object' && record !== null && 'kind' in record ? record.kind : null,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  // 진입점은 실릴 때 서비스 워커를 시작하므로 시험마다 새로 싣는다.
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('설치·갱신 때 옛 스크립트 정리의 기다림(결정 0008, architecture 7장 "제한 시간")', () => {
  it('quality 067 quality 068 한 탭이 응답하지 않아도 다른 탭의 실패는 바로 기록하고, 응답하지 않는 탭은 5초가 지나면 timeout으로 기록한다', async () => {
    const store = createFakeLocalStore();
    const { install } = fakeChrome(store, [{ id: 1 }, { id: 2 }], (injection) =>
      injection.target.tabId === 1
        ? // 응답하지 않는 탭(예: 로딩이 끝나지 않거나 주 스레드가 붙잡힌 페이지).
          new Promise(() => undefined)
        : Promise.reject(new Error('예상하지 못한 실패')),
    );
    await import('../../src/entries/sw.ts');
    // 서비스 워커가 시작하며 설정을 준비한다.
    await vi.advanceTimersByTimeAsync(10);
    expect(store.peek(settingsKey)).toBeDefined();

    install();
    // 다른 탭의 실패는 응답하지 않는 탭을 기다리지 않고 기록된다. 그 사이 서비스 워커가 멈춰도 이 기록은 남는다.
    await vi.advanceTimersByTimeAsync(100);
    expect(recordedKinds(store)).toEqual(['platform']);
    await vi.advanceTimersByTimeAsync(4_899);
    expect(recordedKinds(store)).toEqual(['platform']);
    // 그 탭을 기다리기 시작한 지 5초.
    await vi.advanceTimersByTimeAsync(1);
    expect(recordedKinds(store)).toEqual(['platform', 'timeout']);
  });

  it('quality 067 1.5초보다 늦게 끝난 탭의 실패도 제한 시간 안이면 기록한다(끝까지 돌지 못한 문서에 다시 넣은 뒤)', async () => {
    const store = createFakeLocalStore();
    // 처음 넣기는 2초 뒤에 iframe이 끝까지 돌지 못했다고 답하고, 그 문서에 다시 넣으면 0.2초 뒤에 또 그렇게 답한다.
    const { install } = fakeChrome(store, [{ id: 1 }], (injection) =>
      injection.target.documentIds === undefined
        ? after(2000, [
            { documentId: 'top', result: true },
            { documentId: 'child', result: null },
          ])
        : after(200, [{ documentId: 'child', result: null }]),
    );
    await import('../../src/entries/sw.ts');
    await vi.advanceTimersByTimeAsync(10);
    install();
    // 확장 전체 시험이 예전에 기록을 읽던 때(1.5초)에는 아직 없다.
    await vi.advanceTimersByTimeAsync(1500);
    expect(recordedKinds(store)).toEqual([]);
    await vi.advanceTimersByTimeAsync(700);
    expect(recordedKinds(store)).toEqual(['unexpected']);
    // 제한 시간이 지나도 더 남지 않는다(이 탭은 이미 끝났다).
    await vi.advanceTimersByTimeAsync(5000);
    expect(recordedKinds(store)).toEqual(['unexpected']);
  });

  it('quality 067 문제 기록의 저장이 늦어도, 정리가 기록을 시킨 뒤 보낸 문제 알림에 응답이 오면 그 기록은 저장되어 있다(확장 전체 시험이 기록을 읽는 방법)', async () => {
    const store = createFakeLocalStore();
    // 응답하지 않는 탭이라 5초에 timeout을 기록하게 시키고, 문제 기록은 저장마다 2초가 걸린다.
    const chrome = fakeChrome(store, [{ id: 1 }], () => new Promise(() => undefined), 2000);
    await import('../../src/entries/sw.ts');
    await vi.advanceTimersByTimeAsync(10);
    chrome.install();
    // 확장 전체 시험이 예전에 기록을 읽던 때(정리의 제한 시간 5초와 여유 1초)에는 아직 저장되지 않았다.
    await vi.advanceTimersByTimeAsync(6000);
    expect(recordedKinds(store)).toEqual([]);
    // 끝 표식을 문제 알림으로 보낸다. 서비스 워커는 같은 줄에서 앞의 기록(7초에 저장)과 표식(9초에 저장)을 차례로
    // 저장한 뒤 응답한다.
    let answer: unknown;
    void chrome
      .send({ type: 'problem.report', payload: { featureId: 'marker', kind: 'cancelled' } })
      .then((response) => {
        answer = response;
      });
    await vi.advanceTimersByTimeAsync(2999);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toEqual({ ok: true, value: null });
    expect(recordedKinds(store)).toEqual(['timeout', 'cancelled']);
  });
});
