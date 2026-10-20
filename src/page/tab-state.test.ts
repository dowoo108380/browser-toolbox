import { describe, expect, it } from 'vitest';
import type { TabState } from '../contracts/index.ts';
import { type AppError, type Result, appError, err, ok } from '../shared/index.ts';
import { subscribeTabState } from './tab-state.ts';

// 콘텐츠 스크립트가 자기 탭의 상태를 받는다(결정 0043).

function setup(hint: readonly string[] | Error, answer: () => Promise<Result<TabState, AppError>>) {
  let receive: ((state: TabState) => void) | undefined;
  let asks = 0;
  const applied: string[][] = [];
  const problems: string[] = [];
  const stop = subscribeTabState(
    {
      hint: () => (hint instanceof Error ? Promise.reject(hint) : Promise.resolve(hint)),
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
      featureIds: ['keep'],
    },
    {
      apply: (on) => applied.push([...on]),
      problem: (error) => problems.push(error.kind),
    },
  );
  return { stop, push: (state: TabState) => receive?.(state), asks: () => asks, applied, problems };
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

  it('표시가 비었으면 묻지 않는다(페이지를 열 때마다 서비스 워커를 깨우지 않는다). 알림은 받는다', async () => {
    const tab = setup([], () => Promise.resolve(ok({ on: ['keep'] })));
    await flush();
    expect(tab.asks()).toBe(0);
    expect(tab.applied).toEqual([]);
    tab.push({ on: ['keep'] });
    expect(tab.applied).toEqual([['keep']]);
  });

  it('표시를 읽지 못하면 켜졌을 수 있는 것으로 보고 묻는다', async () => {
    const tab = setup(new Error('읽지 못함'), () => Promise.resolve(ok({ on: [] })));
    await flush();
    expect(tab.asks()).toBe(1);
    expect(tab.applied).toEqual([[]]);
  });

  it('알림이 물은 답보다 먼저 오면 답은 버린다', async () => {
    let answer: (result: Result<TabState, AppError>) => void = () => undefined;
    const tab = setup(
      ['keep'],
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    await flush();
    tab.push({ on: [] });
    answer(ok({ on: ['keep'] }));
    await flush();
    expect(tab.applied).toEqual([[]]);
  });

  it('묻지 못하면 알리고, 그만둔 뒤에는 알림도 답도 넘기지 않는다', async () => {
    const failed = setup(['keep'], () => Promise.resolve(err(appError('timeout', '답이 없다.'))));
    await flush();
    expect(failed.problems).toEqual(['timeout']);
    let answer: (result: Result<TabState, AppError>) => void = () => undefined;
    const stopped = setup(
      ['keep'],
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    await flush();
    stopped.stop();
    answer(ok({ on: ['keep'] }));
    stopped.push({ on: ['keep'] });
    await flush();
    expect(stopped.applied).toEqual([]);
  });
});
