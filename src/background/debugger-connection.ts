import type { DebuggerLoss } from '../platform/index.ts';
import type { AppError } from '../shared/index.ts';

// 탭마다의 디버거 연결(quality 062의 "디버거 연결", 아키텍처 8장, 결정 0042). 탭마다 연결은 하나이고, 쓰는 쪽(기능 id)이
// 생기면 붙이고 다 없어지면 뗀다. (상태, 사건) → (새 상태, 할 일)인 순수 함수다(결정 0020). 할 일(붙이기, 떼기, 쓰는 쪽에
// 알리기)은 서비스 워커의 디버거 관리(debugger.ts)가 한다. 붙이기와 떼기는 비동기라 그 결과는 할 일에 준 실행 번호를 실은
// 사건으로 돌아온다. 번호가 지금 실행과 다르면 늦게 온 옛 결과라 버린다.

// 탭 하나의 단계. 맵에 없으면 떨어져 있고 쓰는 쪽도 없다.
// - attaching: 실행 run으로 붙이는 중이다. users는 붙으면 알릴 쪽이다. 비어도 붙기를 기다렸다가 뗀다.
// - attached: 실행 run으로 붙었고 users가 쓴다(비지 않는다).
// - detaching: 실행 run을 떼는 중이다. users는 떼는 동안 쓰겠다고 한 쪽이라, 떼고 나면 새 실행으로 다시 붙인다.
type Connection =
  | { readonly phase: 'attaching'; readonly run: number; readonly users: ReadonlySet<string> }
  | { readonly phase: 'attached'; readonly run: number; readonly users: ReadonlySet<string> }
  | { readonly phase: 'detaching'; readonly run: number; readonly users: ReadonlySet<string> };

export interface Connections {
  readonly tabs: ReadonlyMap<number, Connection>;
  // 다음 실행의 번호. 다시 쓰지 않는다.
  readonly nextRun: number;
}

export const initialConnections: Connections = { tabs: new Map(), nextRun: 1 };

export type ConnectionEvent =
  // user가 그 탭에 붙여 쓰겠다고 했다.
  | { readonly type: 'acquire'; readonly tabId: number; readonly user: string }
  // user가 그 탭을 그만 쓴다.
  | { readonly type: 'release'; readonly tabId: number; readonly user: string }
  // 이 관리가 쓰지 않는 그 탭에 앞 서비스 워커가 붙인 연결이 남았을 수 있다. 떼어 둔다(쓰는 쪽이 있으면 아무것도 하지 않는다).
  | { readonly type: 'discard'; readonly tabId: number }
  // 실행 run의 붙이기가 끝났다.
  | { readonly type: 'attached'; readonly tabId: number; readonly run: number }
  | {
      readonly type: 'attachFailed';
      readonly tabId: number;
      readonly run: number;
      readonly error: AppError;
    }
  // 실행 run의 떼기가 끝났다.
  | { readonly type: 'detached'; readonly tabId: number; readonly run: number }
  // Chrome이 그 탭의 연결을 끊었다(debugger.onDetach. 이 확장이 스스로 뗀 것은 오지 않는다).
  | { readonly type: 'lost'; readonly tabId: number; readonly loss: DebuggerLoss };

export type ConnectionEffect =
  | { readonly type: 'attach'; readonly tabId: number; readonly run: number }
  | { readonly type: 'detach'; readonly tabId: number; readonly run: number }
  // 그 쪽들이 그 탭을 쓸 수 있다(붙었다).
  | { readonly type: 'granted'; readonly tabId: number; readonly users: readonly string[] }
  // 그 쪽들에게 붙이지 못한 까닭을 알린다.
  | {
      readonly type: 'refused';
      readonly tabId: number;
      readonly users: readonly string[];
      readonly error: AppError;
    }
  // 붙기를 기다리던 user가 그만 쓰겠다고 했다. 기다림을 끝낸다.
  | { readonly type: 'withdrawn'; readonly tabId: number; readonly user: string }
  // 붙기를 기다리던 그 쪽들의 붙이기가 밖에서 끊겼다. 기다림을 실패로 끝낸다(끊김은 뒤따르는 lost가 알린다).
  | { readonly type: 'interrupted'; readonly tabId: number; readonly users: readonly string[] }
  // 그 쪽들이 쓰던 연결이 밖에서 끊겼다.
  | {
      readonly type: 'lost';
      readonly tabId: number;
      readonly users: readonly string[];
      readonly loss: DebuggerLoss;
    };

interface Step {
  readonly state: Connections;
  readonly effects: readonly ConnectionEffect[];
}

const withTab = (state: Connections, tabId: number, connection: Connection | null): Connections => {
  const tabs = new Map(state.tabs);
  if (connection === null) tabs.delete(tabId);
  else tabs.set(tabId, connection);
  return { tabs, nextRun: state.nextRun };
};

const added = (users: ReadonlySet<string>, user: string) => new Set([...users, user]);

const removed = (users: ReadonlySet<string>, user: string) =>
  new Set([...users].filter((candidate) => candidate !== user));

// 새 실행으로 붙이기 시작한다.
function attach(state: Connections, tabId: number, users: ReadonlySet<string>): Step {
  const run = state.nextRun;
  const tabs = new Map(state.tabs).set(tabId, { phase: 'attaching', run, users });
  return { state: { tabs, nextRun: run + 1 }, effects: [{ type: 'attach', tabId, run }] };
}

const unchanged = (state: Connections): Step => ({ state, effects: [] });

export function transition(state: Connections, event: ConnectionEvent): Step {
  const current = state.tabs.get(event.tabId);
  switch (event.type) {
    case 'acquire': {
      const { tabId, user } = event;
      if (current === undefined) return attach(state, tabId, new Set([user]));
      const next = withTab(state, tabId, { ...current, users: added(current.users, user) });
      return {
        state: next,
        effects: current.phase === 'attached' ? [{ type: 'granted', tabId, users: [user] }] : [],
      };
    }
    case 'release': {
      const { tabId, user } = event;
      if (current?.users.has(user) !== true) return unchanged(state);
      const users = removed(current.users, user);
      if (current.phase === 'attached' && users.size === 0) {
        return {
          state: withTab(state, tabId, { phase: 'detaching', run: current.run, users }),
          effects: [{ type: 'detach', tabId, run: current.run }],
        };
      }
      // 붙이는 중이나 떼는 중의 쪽은 붙기를 기다린다. 그 기다림을 끝낸다.
      return {
        state: withTab(state, tabId, { ...current, users }),
        effects: current.phase === 'attached' ? [] : [{ type: 'withdrawn', tabId, user }],
      };
    }
    case 'discard': {
      if (current !== undefined) return unchanged(state);
      const run = state.nextRun;
      const tabs = new Map(state.tabs).set(event.tabId, {
        phase: 'detaching',
        run,
        users: new Set<string>(),
      });
      return {
        state: { tabs, nextRun: run + 1 },
        effects: [{ type: 'detach', tabId: event.tabId, run }],
      };
    }
    case 'attached': {
      const { tabId, run } = event;
      if (current?.phase !== 'attaching' || current.run !== run) return unchanged(state);
      if (current.users.size === 0) {
        return {
          state: withTab(state, tabId, { phase: 'detaching', run, users: current.users }),
          effects: [{ type: 'detach', tabId, run }],
        };
      }
      return {
        state: withTab(state, tabId, { phase: 'attached', run, users: current.users }),
        effects: [{ type: 'granted', tabId, users: [...current.users] }],
      };
    }
    case 'attachFailed': {
      const { tabId, run, error } = event;
      if (current?.phase !== 'attaching' || current.run !== run) return unchanged(state);
      return {
        state: withTab(state, tabId, null),
        effects:
          current.users.size === 0
            ? []
            : [{ type: 'refused', tabId, users: [...current.users], error }],
      };
    }
    case 'detached': {
      const { tabId, run } = event;
      if (current?.phase !== 'detaching' || current.run !== run) return unchanged(state);
      if (current.users.size > 0) return attach(state, tabId, current.users);
      return { state: withTab(state, tabId, null), effects: [] };
    }
    case 'lost': {
      const { tabId, loss } = event;
      // 떼는 중이면 떼기의 결과(이미 떨어짐)가 곧 온다. 그때 기다리던 쪽을 위해 다시 붙인다.
      if (current === undefined || current.phase === 'detaching') return unchanged(state);
      // 붙이는 중에 온 끊김은 이 붙이기의 것이다(Chrome은 이 확장이 스스로 뗀 연결의 끊김을 보내지 않는다). 기다리던 쪽의
      // 기다림을 먼저 끝낸다. 늦게 오는 붙이기의 결과는 그 탭의 연결이 없어 버린다.
      const users = [...current.users];
      if (users.length === 0) return { state: withTab(state, tabId, null), effects: [] };
      const lost: ConnectionEffect = { type: 'lost', tabId, users, loss };
      return {
        state: withTab(state, tabId, null),
        effects:
          current.phase === 'attaching' ? [{ type: 'interrupted', tabId, users }, lost] : [lost],
      };
    }
  }
}

// 지금 붙어 있어 명령을 보낼 수 있는지.
export function isAttached(state: Connections, tabId: number): boolean {
  return state.tabs.get(tabId)?.phase === 'attached';
}
