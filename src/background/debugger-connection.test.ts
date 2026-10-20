import { describe, expect, it } from 'vitest';
import { appError } from '../shared/index.ts';
import {
  type ConnectionEffect,
  type ConnectionEvent,
  type Connections,
  initialConnections,
  isAttached,
  transition,
} from './debugger-connection.ts';

// 탭마다의 디버거 연결 상태 기계(quality 062, 결정 0042). 단계(없음, 붙이는 중, 붙음, 떼는 중)와 사건의 짝마다 본다.

const tab = 7;
const refusal = appError('permission', '붙이지 못했다.');

// 사건들을 차례로 넣은 상태와, 마지막 사건의 할 일.
function run(events: readonly ConnectionEvent[], from: Connections = initialConnections) {
  let state = from;
  let effects: readonly ConnectionEffect[] = [];
  for (const event of events) {
    const step = transition(state, event);
    state = step.state;
    effects = step.effects;
  }
  return { state, effects };
}

const acquire = (user: string): ConnectionEvent => ({ type: 'acquire', tabId: tab, user });
const release = (user: string): ConnectionEvent => ({ type: 'release', tabId: tab, user });
const attached = (run: number): ConnectionEvent => ({ type: 'attached', tabId: tab, run });
const detached = (run: number): ConnectionEvent => ({ type: 'detached', tabId: tab, run });

// 떨어진 탭만 있는 상태(다음 실행 번호가 nextRun).
const emptyAfter = (nextRun: number): Connections => ({ tabs: new Map(), nextRun });

describe('디버거 연결 상태 기계', () => {
  it('처음 쓰는 쪽이 생기면 새 실행으로 붙이고, 붙으면 기다리던 쪽 모두에게 알린다', () => {
    const attaching = run([acquire('keep')]);
    expect(attaching.effects).toEqual([{ type: 'attach', tabId: tab, run: 1 }]);
    expect(isAttached(attaching.state, tab)).toBe(false);
    const both = run([acquire('capture')], attaching.state);
    expect(both.effects).toEqual([]);
    const done = run([attached(1)], both.state);
    expect(done.effects).toEqual([{ type: 'granted', tabId: tab, users: ['keep', 'capture'] }]);
    expect(isAttached(done.state, tab)).toBe(true);
  });

  it('붙은 연결을 다른 쪽이 쓰면 바로 알리고 다시 붙이지 않는다', () => {
    const { state } = run([acquire('keep'), attached(1)]);
    expect(run([acquire('capture')], state).effects).toEqual([
      { type: 'granted', tabId: tab, users: ['capture'] },
    ]);
  });

  it('쓰는 쪽이 다 없어질 때만 뗀다. 남은 쪽이 있으면 연결은 그대로다', () => {
    const shared = run([acquire('keep'), acquire('capture'), attached(1)]).state;
    const one = run([release('capture')], shared);
    expect(one.effects).toEqual([]);
    expect(isAttached(one.state, tab)).toBe(true);
    const none = run([release('keep')], one.state);
    expect(none.effects).toEqual([{ type: 'detach', tabId: tab, run: 1 }]);
    expect(run([detached(1)], none.state)).toEqual({ state: emptyAfter(2), effects: [] });
  });

  it('쓰지 않는 쪽의 그만 쓰기와 떨어진 탭의 사건은 아무것도 하지 않는다', () => {
    const { state } = run([acquire('keep'), attached(1)]);
    expect(run([release('capture')], state)).toEqual({ state, effects: [] });
    const failed: ConnectionEvent = { type: 'attachFailed', tabId: tab, run: 1, error: refusal };
    for (const event of [release('keep'), attached(1), detached(1), failed] as const) {
      expect(transition(initialConnections, event)).toEqual({
        state: initialConnections,
        effects: [],
      });
    }
    expect(
      transition(initialConnections, { type: 'lost', tabId: tab, loss: 'closed' }).effects,
    ).toEqual([]);
  });

  it('붙이지 못하면 기다리던 쪽에 까닭을 알리고 떨어진 채다', () => {
    const { state } = run([acquire('keep')]);
    const failed = transition(state, { type: 'attachFailed', tabId: tab, run: 1, error: refusal });
    expect(failed.effects).toEqual([
      { type: 'refused', tabId: tab, users: ['keep'], error: refusal },
    ]);
    expect(failed.state.tabs.size).toBe(0);
  });

  it('붙기 전에 그만 쓴 쪽은 기다림을 끝내고, 아무도 남지 않으면 붙은 뒤 곧 뗀다', () => {
    const withdrawn = run([acquire('keep'), release('keep')]);
    expect(withdrawn.effects).toEqual([{ type: 'withdrawn', tabId: tab, user: 'keep' }]);
    const late = run([attached(1)], withdrawn.state);
    expect(late.effects).toEqual([{ type: 'detach', tabId: tab, run: 1 }]);
    // 뗀 뒤에는 떨어져 있고, 다시 쓰면 새 실행으로 붙인다.
    const gone = run([detached(1)], late.state);
    expect(gone.state.tabs.size).toBe(0);
    expect(run([acquire('keep')], gone.state).effects).toEqual([
      { type: 'attach', tabId: tab, run: 2 },
    ]);
    expect(
      transition(withdrawn.state, { type: 'attachFailed', tabId: tab, run: 1, error: refusal })
        .effects,
    ).toEqual([]);
  });

  it('떼는 동안 다시 쓰겠다고 하면 떼기가 끝난 뒤 새 실행으로 붙인다', () => {
    const detaching = run([acquire('keep'), attached(1), release('keep'), acquire('capture')]);
    expect(detaching.effects).toEqual([]);
    const again = run([detached(1)], detaching.state);
    expect(again.effects).toEqual([{ type: 'attach', tabId: tab, run: 2 }]);
    expect(run([release('capture')], detaching.state).effects).toEqual([]);
  });

  it('번호가 다른 늦은 결과는 버린다', () => {
    const { state } = run([acquire('keep'), attached(1), release('keep'), acquire('keep')]);
    expect(transition(state, attached(1)).effects).toEqual([]);
    const reattaching = run([detached(1)], state).state;
    expect(transition(reattaching, attached(1)).effects).toEqual([]);
    expect(
      transition(reattaching, { type: 'attachFailed', tabId: tab, run: 1, error: refusal }).effects,
    ).toEqual([]);
    expect(transition(reattaching, detached(1)).effects).toEqual([]);
    expect(transition(reattaching, attached(2)).effects).toEqual([
      { type: 'granted', tabId: tab, users: ['keep'] },
    ]);
  });

  it('떼는 중에 앞 실행의 떼기 결과가 늦게 와도 버리고, 지금 실행의 결과를 기다린다', () => {
    const { state } = run([
      acquire('keep'),
      attached(1),
      release('keep'),
      acquire('keep'),
      detached(1),
      attached(2),
      release('keep'),
      acquire('capture'),
    ]);
    expect(transition(state, detached(1))).toEqual({ state, effects: [] });
    expect(transition(state, detached(2)).effects).toEqual([
      { type: 'attach', tabId: tab, run: 3 },
    ]);
  });

  it('붙은 연결에 같은 번호의 붙이기 실패나 떼기 결과가 와도(일어나면 안 됨) 붙은 채다', () => {
    const { state } = run([acquire('keep'), attached(1)]);
    for (const event of [
      { type: 'attachFailed', tabId: tab, run: 1, error: refusal },
      detached(1),
    ] as const) {
      expect(transition(state, event)).toEqual({ state, effects: [] });
    }
  });

  it('TAB-2.7 Chrome이 끊으면 쓰던 쪽 모두에게 그 까닭을 알리고 떨어진 채다', () => {
    const { state } = run([acquire('keep'), acquire('capture'), attached(1)]);
    const lost = transition(state, { type: 'lost', tabId: tab, loss: 'cancelled' });
    expect(lost.effects).toEqual([
      { type: 'lost', tabId: tab, users: ['keep', 'capture'], loss: 'cancelled' },
    ]);
    expect(lost.state.tabs.size).toBe(0);
  });

  it('붙이는 중에 온 끊김은 그 붙이기의 것이다. 기다리던 쪽에 알리고, 늦게 온 붙이기의 결과는 버린다', () => {
    const { state } = run([acquire('keep')]);
    const lost = transition(state, { type: 'lost', tabId: tab, loss: 'closed' });
    expect(lost.effects).toEqual([{ type: 'lost', tabId: tab, users: ['keep'], loss: 'closed' }]);
    expect(transition(lost.state, attached(1)).effects).toEqual([]);
    const nobody = run([acquire('keep'), release('keep')]).state;
    expect(transition(nobody, { type: 'lost', tabId: tab, loss: 'closed' }).effects).toEqual([]);
  });

  it('떼는 중에 온 끊김은 무시한다. 떼기의 결과가 오면 기다리던 쪽을 위해 다시 붙인다', () => {
    const { state } = run([acquire('keep'), attached(1), release('keep'), acquire('keep')]);
    expect(transition(state, { type: 'lost', tabId: tab, loss: 'closed' })).toEqual({
      state,
      effects: [],
    });
  });

  it('결정 0038 쓰는 쪽이 없는 탭에 남았을 수 있는 연결은 뗀다. 쓰는 쪽이 있으면 아무것도 하지 않는다', () => {
    const discarded = transition(initialConnections, { type: 'discard', tabId: tab });
    expect(discarded.effects).toEqual([{ type: 'detach', tabId: tab, run: 1 }]);
    expect(run([detached(1)], discarded.state).state.tabs.size).toBe(0);
    const { state } = run([acquire('keep')]);
    expect(transition(state, { type: 'discard', tabId: tab })).toEqual({ state, effects: [] });
  });

  it('탭마다 따로다', () => {
    const { state } = run([acquire('keep')]);
    const other = transition(state, { type: 'acquire', tabId: 8, user: 'keep' });
    expect(other.effects).toEqual([{ type: 'attach', tabId: 8, run: 2 }]);
    expect(other.state.tabs.size).toBe(2);
  });

  it('받은 상태를 고치지 않는다', () => {
    const { state } = run([acquire('keep'), attached(1)]);
    const before = JSON.stringify([...state.tabs].map(([id, c]) => [id, c.phase, [...c.users]]));
    transition(state, release('keep'));
    transition(state, acquire('capture'));
    transition(state, { type: 'lost', tabId: tab, loss: 'closed' });
    expect(JSON.stringify([...state.tabs].map(([id, c]) => [id, c.phase, [...c.users]]))).toBe(
      before,
    );
  });
});
