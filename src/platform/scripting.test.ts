import { afterEach, describe, expect, it, vi } from 'vitest';
import { retireInAllFrames } from './scripting.ts';

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
  vi.unstubAllGlobals();
});

const kinds = async () => (await retireInAllFrames(markers)).map((error) => error.kind);

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
    await retireInAllFrames(markers);
    const tokens = executeScript.mock.calls.map(([injection]) => injection.args?.[3]);
    expect(tokens).toHaveLength(2);
    expect(typeof tokens[0]).toBe('string');
    expect(tokens[0]).not.toBe(tokens[1]);
  });
});
