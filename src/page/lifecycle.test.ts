import { describe, expect, it } from 'vitest';
import {
  type Desired,
  type Lifecycle,
  type LifecycleEffect,
  type LifecycleEvent,
  initialLifecycle,
  transition,
} from './lifecycle.ts';

// 기능의 켜기·끄기 수명(quality 062). DOM 없이 상태와 할 일만 본다. 시작하는 방법(start)은 시험에서 이름표다.

function run(
  state: Lifecycle,
  ...events: readonly LifecycleEvent<string>[]
): { state: Lifecycle; effects: LifecycleEffect<string>[] } {
  let current = state;
  const effects: LifecycleEffect<string>[] = [];
  for (const event of events) {
    const next = transition(current, event);
    current = next.state;
    effects.push(...next.effects);
  }
  return { state: current, effects };
}

const want = (...features: readonly [string, string][]): LifecycleEvent<string> => ({
  type: 'apply',
  desired: features.map(([featureId, key]): Desired<string> => ({
    featureId,
    key,
    start: `start ${featureId} ${key}`,
  })),
});

const fail = (featureId: string, runId: number): LifecycleEvent<string> => ({
  type: 'fail',
  featureId,
  run: runId,
});

describe('기능의 켜기·끄기 수명(상태 기계)', () => {
  it('처음 적용하면 기능마다 새 실행 번호로 차례대로 시작한다', () => {
    const { state, effects } = run(initialLifecycle, want(['a', 'on'], ['b', 'off']));
    expect(effects).toEqual([
      { type: 'start', featureId: 'a', run: 1, start: 'start a on' },
      { type: 'start', featureId: 'b', run: 2, start: 'start b off' },
    ]);
    expect([...state.features]).toEqual([
      ['a', { phase: 'running', key: 'on', run: 1 }],
      ['b', { phase: 'running', key: 'off', run: 2 }],
    ]);
  });

  it('결정 0011 읽는 쪽 계약 5 설정이 그대로인 기능은 다시 시작하지 않는다', () => {
    const started = run(initialLifecycle, want(['a', 'on'], ['b', 'on']));
    expect(transition(started.state, want(['a', 'on'], ['b', 'on'])).effects).toEqual([]);
  });

  it('설정이 바뀐 기능만 그 실행을 닫고 새 실행 번호로 다시 시작한다', () => {
    const started = run(initialLifecycle, want(['a', 'on'], ['b', 'on']));
    const { state, effects } = transition(started.state, want(['a', 'on'], ['b', 'off']));
    expect(effects).toEqual([
      { type: 'close', run: 2 },
      { type: 'start', featureId: 'b', run: 3, start: 'start b off' },
    ]);
    expect(state.features.get('b')).toEqual({ phase: 'running', key: 'off', run: 3 });
  });

  it('quality 010 지금 실행이 실패하면 기록하고 닫으며, 같은 설정으로는 다시 시작하지 않는다', () => {
    const started = run(initialLifecycle, want(['a', 'on']));
    const failed = transition(started.state, fail('a', 1));
    expect(failed.effects).toEqual([
      { type: 'report', featureId: 'a' },
      { type: 'close', run: 1 },
    ]);
    expect(failed.state.features.get('a')).toEqual({ phase: 'failed', key: 'on' });
    expect(transition(failed.state, want(['a', 'on'])).effects).toEqual([]);
  });

  it('실패한 기능은 설정이 바뀌면 닫을 것 없이 새로 시작한다', () => {
    const failed = run(initialLifecycle, want(['a', 'on']), fail('a', 1));
    expect(transition(failed.state, want(['a', 'off'])).effects).toEqual([
      { type: 'start', featureId: 'a', run: 2, start: 'start a off' },
    ]);
  });

  it('지금 실행이 아닌 실패(닫히는 옛 실행의 정리 실패, 거듭 온 실패, 멈춘 기능)는 기록만 하고 상태와 지금 실행은 그대로다', () => {
    const restarted = run(initialLifecycle, want(['a', 'on']), want(['a', 'off']));
    for (const [featureId, runId] of [
      ['a', 1],
      ['b', 7],
    ] as const) {
      const { state, effects } = transition(restarted.state, fail(featureId, runId));
      expect(effects).toEqual([{ type: 'report', featureId }]);
      expect(state).toEqual(restarted.state);
    }
    const failed = run(initialLifecycle, want(['a', 'on']), fail('a', 1));
    const again = transition(failed.state, fail('a', 1));
    expect(again.effects).toEqual([{ type: 'report', featureId: 'a' }]);
    expect(again.state).toEqual(failed.state);
  });

  it('모두 멈추면 돌던 실행만 닫고 모든 기능을 잊으며, 다음 시작은 앞에서 쓴 적 없는 실행 번호를 쓴다', () => {
    const mixed = run(initialLifecycle, want(['a', 'on'], ['b', 'on'], ['c', 'on']), fail('b', 2));
    const stopped = transition(mixed.state, { type: 'stopAll' });
    expect(stopped.effects).toEqual([
      { type: 'close', run: 1 },
      { type: 'close', run: 3 },
    ]);
    expect(stopped.state.features.size).toBe(0);
    expect(transition(stopped.state, want(['b', 'on'])).effects).toEqual([
      { type: 'start', featureId: 'b', run: 4, start: 'start b on' },
    ]);
  });

  it('바꾸기 전의 상태를 고치지 않는다(새 상태를 만든다)', () => {
    const started = run(initialLifecycle, want(['a', 'on']));
    const before = structuredClone([...started.state.features]);
    transition(started.state, want(['a', 'off']));
    transition(started.state, fail('a', 1));
    transition(started.state, { type: 'stopAll' });
    expect([...started.state.features]).toEqual(before);
    expect(initialLifecycle.features.size).toBe(0);
  });
});
