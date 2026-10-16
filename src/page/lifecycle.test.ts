import { describe, expect, it } from 'vitest';
import {
  type Desired,
  type Lifecycle,
  type LifecycleEffect,
  type LifecycleEvent,
  initialLifecycle,
  notFoundOf,
  transition,
} from './lifecycle.ts';

// 기능의 켜기·끄기 수명(quality 062). DOM 없이 상태와 할 일만 본다. 시작하는 방법(start)과 외부 화면 요소(element)는
// 시험에서 이름표다.

type State = Lifecycle<string, string>;
type Event = LifecycleEvent<string, string>;
type Effect = LifecycleEffect<string, string>;

function run(state: State, ...events: readonly Event[]): { state: State; effects: Effect[] } {
  let current = state;
  const effects: Effect[] = [];
  for (const event of events) {
    const next = transition(current, event);
    current = next.state;
    effects.push(...next.effects);
  }
  return { state: current, effects };
}

const want = (...features: readonly [string, string][]): Event => ({
  type: 'apply',
  desired: features.map(([featureId, key]): Desired<string> => ({
    featureId,
    key,
    start: `start ${featureId} ${key}`,
  })),
});

const fail = (featureId: string, runId: number): Event => ({
  type: 'fail',
  featureId,
  run: runId,
});

const notFound = (featureId: string, runId: number, element = '대상'): Event => ({
  type: 'notFound',
  featureId,
  run: runId,
  element,
});

const found = (featureId: string, runId: number): Event => ({
  type: 'found',
  featureId,
  run: runId,
});

const unexpected = (featureId: string): Effect => ({
  type: 'report',
  featureId,
  problem: { kind: 'unexpected' },
});

describe('기능의 켜기·끄기 수명(상태 기계)', () => {
  it('처음 적용하면 기능마다 새 실행 번호로 차례대로 시작한다', () => {
    const { state, effects } = run(initialLifecycle, want(['a', 'on'], ['b', 'off']));
    expect(effects).toEqual([
      { type: 'start', featureId: 'a', run: 1, start: 'start a on' },
      { type: 'start', featureId: 'b', run: 2, start: 'start b off' },
    ]);
    expect([...state.features]).toEqual([
      ['a', { phase: 'running', key: 'on', run: 1, start: 'start a on' }],
      ['b', { phase: 'running', key: 'off', run: 2, start: 'start b off' }],
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
    expect(state.features.get('b')).toEqual({
      phase: 'running',
      key: 'off',
      run: 3,
      start: 'start b off',
    });
  });

  it('quality 010 지금 실행이 실패하면 기록하고 닫으며, 같은 설정으로는 다시 시작하지 않는다', () => {
    const started = run(initialLifecycle, want(['a', 'on']));
    const failed = transition(started.state, fail('a', 1));
    expect(failed.effects).toEqual([unexpected('a'), { type: 'close', run: 1 }]);
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
      expect(effects).toEqual([unexpected(featureId)]);
      expect(state).toEqual(restarted.state);
    }
    const failed = run(initialLifecycle, want(['a', 'on']), fail('a', 1));
    const again = transition(failed.state, fail('a', 1));
    expect(again.effects).toEqual([unexpected('a')]);
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
    transition(started.state, notFound('a', 1));
    transition(started.state, { type: 'stopAll' });
    expect([...started.state.features]).toEqual(before);
    const watching = run(initialLifecycle, want(['a', 'on']), notFound('a', 1));
    const watched = structuredClone([...watching.state.features]);
    transition(watching.state, found('a', 2));
    expect([...watching.state.features]).toEqual(watched);
    expect(initialLifecycle.features.size).toBe(0);
  });
});

describe('외부 화면 요소를 찾지 못함(결정 0026)', () => {
  it('COM-6 기대 동작 2 지금 실행이 찾지 못하면 그 실행을 닫고(변경을 되돌림) 요소와 함께 기록하며 새 번호로 지켜본다', () => {
    const started = run(initialLifecycle, want(['a', 'on'], ['b', 'on']));
    const { state, effects } = transition(started.state, notFound('a', 1, '대화 열'));
    expect(effects).toEqual([
      { type: 'close', run: 1 },
      { type: 'report', featureId: 'a', problem: { kind: 'not-found', element: '대화 열' } },
      { type: 'watch', featureId: 'a', run: 3, element: '대화 열' },
    ]);
    expect(state.features.get('a')).toEqual({
      phase: 'notFound',
      key: 'on',
      run: 3,
      start: 'start a on',
      element: '대화 열',
    });
    // 다른 기능은 그대로 돈다(COM-6.2).
    expect(state.features.get('b')).toEqual(started.state.features.get('b'));
    expect(notFoundOf(state)).toEqual([{ featureId: 'a', element: '대화 열' }]);
  });

  it('COM-6.3 지켜보던 요소가 나타나면 지켜보기를 닫고 같은 방법으로 새 번호로 다시 시작한다', () => {
    const watching = run(initialLifecycle, want(['a', 'on']), notFound('a', 1));
    const { state, effects } = transition(watching.state, found('a', 2));
    expect(effects).toEqual([
      { type: 'close', run: 2 },
      { type: 'start', featureId: 'a', run: 3, start: 'start a on' },
    ]);
    expect(state.features.get('a')).toEqual({
      phase: 'running',
      key: 'on',
      run: 3,
      start: 'start a on',
    });
    expect(notFoundOf(state)).toEqual([]);
    // 다시 시작한 실행이 또 찾지 못하면 또 기록하고 지켜본다.
    expect(transition(state, notFound('a', 3)).effects).toEqual([
      { type: 'close', run: 3 },
      { type: 'report', featureId: 'a', problem: { kind: 'not-found', element: '대상' } },
      { type: 'watch', featureId: 'a', run: 4, element: '대상' },
    ]);
  });

  it('지금 실행이 아닌 것의 찾지 못함과 찾음(닫힌 실행의 늦은 알림, 다른 단계)은 버린다', () => {
    const restarted = run(initialLifecycle, want(['a', 'on']), want(['a', 'off']));
    for (const event of [notFound('a', 1), notFound('b', 1), found('a', 2), found('a', 1)]) {
      const { state, effects } = transition(restarted.state, event);
      expect(effects).toEqual([]);
      expect(state).toEqual(restarted.state);
    }
    const watching = run(initialLifecycle, want(['a', 'on']), notFound('a', 1));
    for (const event of [notFound('a', 1), notFound('a', 2), found('a', 1), found('b', 2)]) {
      const { state, effects } = transition(watching.state, event);
      expect(effects).toEqual([]);
      expect(state).toEqual(watching.state);
    }
    const failed = run(initialLifecycle, want(['a', 'on']), fail('a', 1));
    expect(transition(failed.state, notFound('a', 1)).effects).toEqual([]);
  });

  it('지켜보는 동안 설정이 그대로면 계속 지켜보고, 바뀌면 지켜보기를 닫고 새로 시작한다', () => {
    const watching = run(initialLifecycle, want(['a', 'on']), notFound('a', 1));
    expect(transition(watching.state, want(['a', 'on'])).effects).toEqual([]);
    const { state, effects } = transition(watching.state, want(['a', 'off']));
    expect(effects).toEqual([
      { type: 'close', run: 2 },
      { type: 'start', featureId: 'a', run: 3, start: 'start a off' },
    ]);
    expect(notFoundOf(state)).toEqual([]);
  });

  it('지켜보기가 실패하면(찾는 함수의 예외) 그 기능의 실패로 기록하고 닫는다', () => {
    const watching = run(initialLifecycle, want(['a', 'on']), notFound('a', 1));
    const { state, effects } = transition(watching.state, fail('a', 2));
    expect(effects).toEqual([unexpected('a'), { type: 'close', run: 2 }]);
    expect(state.features.get('a')).toEqual({ phase: 'failed', key: 'on' });
  });

  it('모두 멈추면 지켜보기도 닫는다', () => {
    const mixed = run(initialLifecycle, want(['a', 'on'], ['b', 'on']), notFound('a', 1));
    expect(transition(mixed.state, { type: 'stopAll' }).effects).toEqual([
      { type: 'close', run: 3 },
      { type: 'close', run: 2 },
    ]);
  });
});
