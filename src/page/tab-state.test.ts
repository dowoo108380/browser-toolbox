import { describe, expect, it } from 'vitest';
import type { TabState } from '../contracts/index.ts';
import { type AppError, type Result, appError, err, ok } from '../shared/index.ts';
import { subscribeTabState } from './tab-state.ts';

// 콘텐츠 스크립트가 자기 탭의 상태를 받는다(결정 0043).

// hint는 표시(읽는 중인 채 두려면 Promise), answer는 서비스 워커의 답이다. throwOnApply면 넘겨받는 쪽이 던진다(일어나면 안 됨).
function setup(
  hint: readonly string[] | Error | Promise<readonly string[]>,
  answer: () => Promise<Result<TabState, AppError>>,
  { throwOnApply = false }: { readonly throwOnApply?: boolean } = {},
) {
  let receive: ((state: TabState) => void) | undefined;
  let restore: (() => void) | undefined;
  let currentHint = hint;
  let asks = 0;
  const applied: string[][] = [];
  const problems: string[] = [];
  const stop = subscribeTabState(
    {
      hint: () =>
        currentHint instanceof Error ? Promise.reject(currentHint) : Promise.resolve(currentHint),
      ask: () => {
        asks += 1;
        return answer();
      },
      listen: (next) => {
        receive = next;
        return () => {
          receive = undefined;
        };
      },
      restored: (handle) => {
        restore = handle;
        return () => {
          restore = undefined;
        };
      },
      featureIds: ['keep'],
    },
    {
      apply: (on) => {
        if (throwOnApply) throw new Error('넘겨받다 던짐');
        applied.push([...on]);
      },
      problem: (error) => problems.push(error.kind),
    },
  );
  return {
    stop,
    push: (state: TabState) => receive?.(state),
    // 문서가 뒤로·앞으로 캐시에서 되살아났다.
    restore: () => restore?.(),
    setHint: (next: readonly string[]) => {
      currentHint = next;
    },
    // 알림과 되살아남을 아직 듣는지.
    listening: () => [receive !== undefined, restore !== undefined],
    asks: () => asks,
    applied,
    problems,
  };
}

// 나중에 답하는 서비스 워커. 물은 차례대로 answers에 답할 함수가 쌓인다.
function heldAnswers() {
  const answers: ((result: Result<TabState, AppError>) => void)[] = [];
  const answer = () =>
    new Promise<Result<TabState, AppError>>((resolve) => {
      answers.push(resolve);
    });
  return { answers, answer };
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('탭의 상태 받기', () => {
  it('표시에 이 묶음의 기능이 있으면 서비스 워커에 묻고, 이 묶음의 기능만 넘긴다', async () => {
    const tab = setup(['keep'], () => Promise.resolve(ok({ on: ['keep', 'other'] })));
    await flush();
    expect(tab.asks()).toBe(1);
    expect(tab.applied).toEqual([['keep']]);
  });

  it('표시가 비었으면 묻지 않고(페이지를 열 때마다 서비스 워커를 깨우지 않는다) 모두 꺼짐으로 둔다. 알림은 받는다', async () => {
    const tab = setup([], () => Promise.resolve(ok({ on: ['keep'] })));
    await flush();
    expect(tab.asks()).toBe(0);
    expect(tab.applied).toEqual([[]]);
    tab.push({ on: ['keep'] });
    expect(tab.applied).toEqual([[], ['keep']]);
  });

  it('표시를 읽지 못하면 켜졌을 수 있는 것으로 보고 묻는다', async () => {
    const tab = setup(new Error('읽지 못함'), () => Promise.resolve(ok({ on: [] })));
    await flush();
    expect(tab.asks()).toBe(1);
    expect(tab.applied).toEqual([[]]);
  });

  it('알림이 물은 답보다 먼저 오면 답은 버린다', async () => {
    const { answers, answer } = heldAnswers();
    const tab = setup(['keep'], answer);
    await flush();
    tab.push({ on: [] });
    answers.shift()?.(ok({ on: ['keep'] }));
    await flush();
    expect(tab.applied).toEqual([[]]);
  });

  it('표시를 읽는 사이 알림이 오면, 표시가 비었어도 꺼짐으로 그 알림을 덮지 않는다', async () => {
    let read: (hint: readonly string[]) => void = () => undefined;
    const tab = setup(
      new Promise((resolve) => {
        read = resolve;
      }),
      () => Promise.resolve(ok({ on: [] })),
    );
    tab.push({ on: ['keep'] });
    read([]);
    await flush();
    expect(tab.applied).toEqual([['keep']]);
  });

  it('묻지 못하면 알리고, 그만둔 뒤에는 알림도 답도 넘기지 않는다', async () => {
    const failed = setup(['keep'], () => Promise.resolve(err(appError('timeout', '답이 없다.'))));
    await flush();
    expect(failed.problems).toEqual(['timeout']);
    const { answers, answer } = heldAnswers();
    const stopped = setup(['keep'], answer);
    await flush();
    stopped.stop();
    answers.shift()?.(ok({ on: ['keep'] }));
    stopped.push({ on: ['keep'] });
    await flush();
    expect(stopped.applied).toEqual([]);
  });

  it('그만두면 알림과 되살아남을 더 듣지 않는다', () => {
    const tab = setup([], () => Promise.resolve(ok({ on: [] })));
    expect(tab.listening()).toEqual([true, true]);
    tab.stop();
    expect(tab.listening()).toEqual([false, false]);
  });

  it('넘기다 던지면(일어나면 안 됨) 예상하지 못한 오류로 알리고, 그만둔 뒤 묻기가 실패하면 알리지 않는다', async () => {
    const throwing = setup(['keep'], () => Promise.resolve(ok({ on: ['keep'] })), {
      throwOnApply: true,
    });
    await flush();
    expect(throwing.problems).toEqual(['unexpected']);
    let fail: (error: Error) => void = () => undefined;
    const stopped = setup(
      ['keep'],
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    await flush();
    stopped.stop();
    fail(new Error('끊김'));
    await flush();
    expect(stopped.problems).toEqual([]);
  });
});

// 뒤로·앞으로 캐시(bfcache)에 든 문서에는 Chrome이 메시지를 보내지 않아, 그동안의 알림(tabState.changed)을 놓친다.
describe('뒤로·앞으로 캐시에서 되살아남', () => {
  it('되살아나면 다시 물어 지금 상태를 넘긴다(떠난 동안 다른 화면에서 켬)', async () => {
    const answers = [ok({ on: [] }), ok({ on: ['keep'] })];
    const tab = setup(['keep'], () => Promise.resolve(answers.shift() ?? ok({ on: [] })));
    await flush();
    expect(tab.applied).toEqual([[]]);
    tab.restore();
    await flush();
    expect(tab.asks()).toBe(2);
    expect(tab.applied).toEqual([[], ['keep']]);
  });

  it('되살아났는데 표시가 비었으면 묻지 않고 모두 꺼짐을 넘긴다(떠난 동안 모든 탭에서 끔)', async () => {
    const tab = setup(['keep'], () => Promise.resolve(ok({ on: ['keep'] })));
    await flush();
    expect(tab.applied).toEqual([['keep']]);
    tab.setHint([]);
    tab.restore();
    await flush();
    expect(tab.asks()).toBe(1);
    expect(tab.applied).toEqual([['keep'], []]);
  });

  it('되살아나 묻는 사이 알림이 오면 답은 버린다', async () => {
    const { answers, answer } = heldAnswers();
    const tab = setup(['keep'], answer);
    await flush();
    answers.shift()?.(ok({ on: [] }));
    await flush();
    tab.restore();
    await flush();
    tab.push({ on: [] });
    answers.shift()?.(ok({ on: ['keep'] }));
    await flush();
    expect(tab.applied).toEqual([[], []]);
  });

  it('처음 물은 답이 오기 전에 알림이 오고 되살아나 다시 물으면, 늦게 온 처음 답은 버리고 다시 물은 답을 넘긴다', async () => {
    const { answers, answer } = heldAnswers();
    const tab = setup(['keep'], answer);
    await flush();
    tab.push({ on: [] });
    tab.restore();
    await flush();
    expect(answers).toHaveLength(2);
    answers[0]?.(ok({ on: ['keep'] }));
    await flush();
    expect(tab.applied).toEqual([[]]);
    answers[1]?.(ok({ on: [] }));
    await flush();
    expect(tab.applied).toEqual([[], []]);
  });

  it('그만둔 뒤에는 되살아나도 묻지 않는다', async () => {
    const tab = setup(['keep'], () => Promise.resolve(ok({ on: ['keep'] })));
    await flush();
    tab.stop();
    tab.restore();
    await flush();
    expect(tab.asks()).toBe(1);
  });
});
