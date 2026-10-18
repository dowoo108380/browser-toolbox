import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppError } from '../shared/index.ts';
import {
  pageRuntimeMarker,
  probePageRuntime,
  retireInAllFrames,
  retireTimeoutMs,
} from './scripting.ts';

// 새 판이 열린 탭의 모든 프레임에 정리 함수를 넣는 일(결정 0008)의 Chrome 경계. 진짜 chrome 대신 시험이 만든 객체를 전역에 둔다.
// 오류 문구와 결과의 모양은 Chromium 156에서 실제로 받은 것이다(결정 0008 고친 기록 2026-10-14, 실험).

const markers = { eventName: 'retire', elementAttribute: 'data-a', claimAttribute: 'data-b' };

interface FakeTab {
  readonly id?: number;
  readonly discarded?: boolean;
}

// 시험이 보는 executeScript 인자의 일부.
interface ScriptInjection {
  readonly target: {
    readonly tabId: number;
    readonly allFrames?: boolean;
    readonly documentIds?: readonly string[];
  };
  readonly args?: readonly unknown[];
  readonly injectImmediately?: boolean;
}

interface FrameResult {
  readonly documentId: string;
  readonly result: unknown;
}

function fakeChrome(
  tabs: readonly FakeTab[],
  inject: (target: ScriptInjection['target']) => Promise<readonly FrameResult[]>,
) {
  const executeScript = vi.fn((injection: ScriptInjection) => inject(injection.target));
  vi.stubGlobal('chrome', {
    tabs: { query: () => Promise.resolve(tabs) },
    scripting: { executeScript },
  });
  return executeScript;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// 정리를 시작한다. reported에는 알린 문제의 종류가 알린 차례대로 쌓인다.
function startRetire() {
  const reported: string[] = [];
  let finished = false;
  const done = retireInAllFrames(markers, (problem: AppError) => {
    reported.push(problem.kind);
  }).then(() => {
    finished = true;
  });
  return { reported, done, finished: () => finished };
}

// 정리가 끝난 뒤 알린 문제의 종류들.
const kinds = async () => {
  const { reported, done } = startRetire();
  await done;
  return reported;
};

const never = () => new Promise<never>(() => undefined);

// 최상위(top)와 iframe(child) 문서가 있는 탭. 처음 넣을 때 iframe의 결과를 first로, 그 문서에 다시 넣을 때를 again으로 준다.
function tabWithChild(first: unknown, again: () => Promise<readonly FrameResult[]>) {
  return fakeChrome([{ id: 1 }], (target) =>
    target.documentIds === undefined
      ? Promise.resolve([
          { documentId: 'top', result: true },
          { documentId: 'child', result: first },
        ])
      : again(),
  );
}

describe('열린 탭의 옛 스크립트 정리(retireInAllFrames)', () => {
  it('모든 문서에서 정리 함수가 끝까지 돌면 알릴 문제가 없고 다시 넣지 않는다', async () => {
    const executeScript = tabWithChild(true, () => Promise.resolve([]));
    expect(await kinds()).toEqual([]);
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it('quality 067 끝까지 돌지 못한 문서(결과 null)가 그대로 있고 다시 넣어도 끝까지 돌지 못하면 unexpected로 알린다(함수가 예외를 내도 Chrome은 거절하지 않는다)', async () => {
    const executeScript = tabWithChild(null, () =>
      Promise.resolve([{ documentId: 'child', result: null }]),
    );
    expect(await kinds()).toEqual(['unexpected']);
    // 다시 넣는 것은 끝까지 돌지 못한 그 문서뿐이고, 처음과 같은 토큰을 쓴다.
    expect(executeScript).toHaveBeenCalledTimes(2);
    const [first, again] = executeScript.mock.calls.map(([injection]) => injection);
    expect(again?.target).toEqual({ tabId: 1, documentIds: ['child'] });
    expect(again?.args).toEqual(first?.args);
  });

  it('끝까지 돌지 못한 문서가 그 사이 이동하거나 지워졌으면(다시 넣을 때 No document) 문제가 아니다', async () => {
    tabWithChild(null, () =>
      Promise.reject(new Error('No document with id 5EB6D7B4 in tab with id 1')),
    );
    expect(await kinds()).toEqual([]);
  });

  it('다시 넣었을 때 끝까지 돌면 문제가 아니다', async () => {
    tabWithChild(null, () => Promise.resolve([{ documentId: 'child', result: true }]));
    expect(await kinds()).toEqual([]);
  });

  it('quality 067 다시 넣을 때 그 밖의 거절이 오면 platform으로 알린다', async () => {
    tabWithChild(null, () => Promise.reject(new Error('예상하지 못한 실패')));
    expect(await kinds()).toEqual(['platform']);
  });

  it('Chrome이 넣을 수 없다고 한 탭(오류 페이지, 사라진 프레임, 닫힌 탭, 접근할 수 없는 페이지, 웹 스토어)의 거절은 문제가 아니다', async () => {
    const messages = [
      'Frame with ID 0 is showing error page',
      'Frame with ID 0 was removed.',
      'No tab with id: 215891482',
      'Cannot access contents of the page. Extension manifest must request permission to access the respective host.',
      'The extensions gallery cannot be scripted.',
    ];
    fakeChrome(
      messages.map((_, index) => ({ id: index })),
      (target) => Promise.reject(new Error(messages[target.tabId])),
    );
    expect(await kinds()).toEqual([]);
  });

  it('quality 067 그 밖의 거절은 platform으로 알리고, 다른 탭의 정리는 계속한다', async () => {
    const executeScript = fakeChrome([{ id: 1 }, { id: 2 }], (target) =>
      target.tabId === 1
        ? Promise.reject(new Error('예상하지 못한 실패'))
        : Promise.resolve([{ documentId: 'top', result: true }]),
    );
    expect(await kinds()).toEqual(['platform']);
    expect(executeScript).toHaveBeenCalledTimes(2);
  });

  it('버려진 탭과 id가 없는 탭에는 넣지 않는다(돌던 스크립트가 없다)', async () => {
    const executeScript = fakeChrome([{ id: 1, discarded: true }, {}, { id: 3 }], () =>
      Promise.resolve([{ documentId: 'top', result: true }]),
    );
    expect(await kinds()).toEqual([]);
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript.mock.calls[0]?.[0].target).toEqual({ tabId: 3, allFrames: true });
  });

  it('탭마다 새 토큰을 넘긴다', async () => {
    const executeScript = fakeChrome([{ id: 1 }, { id: 2 }], () =>
      Promise.resolve([{ documentId: 'top', result: true }]),
    );
    await kinds();
    const tokens = executeScript.mock.calls.map(([injection]) => injection.args?.[3]);
    expect(tokens).toHaveLength(2);
    expect(typeof tokens[0]).toBe('string');
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it('결정 0008 문서가 다 실리기를 기다리지 않게 처음 넣을 때와 다시 넣을 때 모두 바로 넣는다(injectImmediately)', async () => {
    const executeScript = tabWithChild(null, () =>
      Promise.resolve([{ documentId: 'child', result: true }]),
    );
    await kinds();
    expect(executeScript.mock.calls.map(([injection]) => injection.injectImmediately)).toEqual([
      true,
      true,
    ]);
  });
});

describe('열린 탭의 옛 스크립트 정리의 기다림(아키텍처 7장 "비동기, 제한 시간, 취소")', () => {
  it('quality 067 탭의 문제는 그 탭이 끝나는 대로 알린다(응답하지 않는 다른 탭을 기다리지 않는다)', async () => {
    fakeChrome([{ id: 1 }, { id: 2 }], (target) =>
      target.tabId === 1 ? never() : Promise.reject(new Error('예상하지 못한 실패')),
    );
    const retire = startRetire();
    await vi.waitFor(() => {
      expect(retire.reported).toEqual(['platform']);
    });
    expect(retire.finished()).toBe(false);
  });

  it(`quality 068 탭마다 ${String(retireTimeoutMs)}ms 안에 끝나지 않으면 그 탭을 timeout으로 알리고, 모든 탭을 알리면 끝난다`, async () => {
    vi.useFakeTimers();
    // 탭 1과 2는 응답하지 않고, 탭 3은 제한 시간 1ms 전에 끝까지 돈다.
    fakeChrome([{ id: 1 }, { id: 2 }, { id: 3 }], (target) =>
      target.tabId === 3
        ? new Promise((resolve) =>
            setTimeout(() => {
              resolve([{ documentId: 'top', result: true }]);
            }, retireTimeoutMs - 1),
          )
        : never(),
    );
    const retire = startRetire();
    await vi.advanceTimersByTimeAsync(retireTimeoutMs - 1);
    expect(retire.reported).toEqual([]);
    expect(retire.finished()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // 기록을 줄이는 것은 부르는 쪽이 한다(종류마다 한 번). 여기서는 탭마다 알린다.
    expect(retire.reported).toEqual(['timeout', 'timeout']);
    expect(retire.finished()).toBe(true);
  });

  it('quality 068 제한 시간을 넘긴 탭은 늦게 끝나도 다시 넣지 않고 그 결과를 알리지 않는다', async () => {
    vi.useFakeTimers();
    const executeScript = tabWithChild(
      null,
      // 다시 넣으면 끝까지 돌지 못했다고 답한다. 넣지 않아야 한다.
      () => Promise.resolve([{ documentId: 'child', result: null }]),
    );
    // 처음 넣기가 제한 시간 뒤에 끝난다.
    const firstInjection = executeScript.getMockImplementation();
    executeScript.mockImplementationOnce(
      (injection) =>
        new Promise<readonly FrameResult[]>((resolve) => {
          setTimeout(() => {
            resolve(firstInjection?.(injection) ?? []);
          }, retireTimeoutMs + 100);
        }),
    );
    const retire = startRetire();
    await vi.advanceTimersByTimeAsync(retireTimeoutMs + 200);
    expect(retire.reported).toEqual(['timeout']);
    expect(executeScript).toHaveBeenCalledTimes(1);
  });
});

describe('결정 0023 지금 탭의 탐침', () => {
  // 탐침이 넣는 인자와, 그 결과를 정하는 가짜 executeScript.
  function fakeProbe(answer: () => Promise<readonly FrameResult[]>) {
    const executeScript = vi.fn(() => answer());
    vi.stubGlobal('chrome', { scripting: { executeScript } });
    return executeScript;
  }

  it('결정 0029 최상위 문서에만 바로 넣고, 실행 틀의 표식 값을 돌려준다(없으면 null)', async () => {
    const executeScript = fakeProbe(() =>
      Promise.resolve([{ documentId: 'a', result: 'chatgpt' }]),
    );
    expect(await probePageRuntime(7, 'key')).toEqual({ status: 'ran', marker: 'chatgpt' });
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 7, frameIds: [0] },
        args: ['key'],
        injectImmediately: true,
      }),
    );
    fakeProbe(() => Promise.resolve([{ documentId: 'a', result: null }]));
    expect(await probePageRuntime(7, 'key')).toEqual({ status: 'ran', marker: null });
    fakeProbe(() => Promise.resolve([{ documentId: 'a', result: undefined }]));
    expect(await probePageRuntime(7, 'key')).toEqual({ status: 'ran', marker: null });
  });

  it('Chrome이 넣을 수 없는 페이지라고 거절하면 unavailable이다(Chromium 156에서 받은 문구)', async () => {
    const messages = [
      'Cannot access a chrome:// URL',
      'Cannot access contents of the page. Extension manifest must request permission to access the respective host.',
      'The extensions gallery cannot be scripted.',
      'Frame with ID 0 is showing error page',
      'No tab with id: 7.',
    ];
    for (const message of messages) {
      fakeProbe(() => Promise.reject(new Error(message)));
      expect(await probePageRuntime(7, 'key'), message).toEqual({ status: 'unavailable' });
    }
  });

  it('그 밖의 거절과 결과가 없는 응답은 failed다(숨기지 않고 부르는 쪽이 기록한다)', async () => {
    fakeProbe(() => Promise.reject(new Error('Something new')));
    expect(await probePageRuntime(7, 'key')).toEqual({ status: 'failed' });
    fakeProbe(() => Promise.resolve([]));
    expect(await probePageRuntime(7, 'key')).toEqual({ status: 'failed' });
  });

  it('탐침 함수는 그 이름의 표식 값을 돌려주고, 없으면 null이다', () => {
    const key = 'browser-toolbox.test-runtime';
    expect(pageRuntimeMarker(key)).toBeNull();
    Reflect.set(globalThis, Symbol.for(key), 'common');
    try {
      expect(pageRuntimeMarker(key)).toBe('common');
      expect(pageRuntimeMarker()).toBeNull();
    } finally {
      Reflect.deleteProperty(globalThis, Symbol.for(key));
    }
  });
});
