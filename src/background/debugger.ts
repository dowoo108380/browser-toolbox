import type { DebuggerLoss } from '../platform/index.ts';
import { type AppError, type Result, appError, err, ok, runMachine } from '../shared/index.ts';
import {
  type ConnectionEffect,
  type ConnectionEvent,
  type Connections,
  initialConnections,
  isAttached,
  transition,
} from './debugger-connection.ts';
import type { Problem } from './problems.ts';
import { strings } from './strings.ts';

// 서비스 워커의 디버거 관리(아키텍처 8장, 결정 0042). 탭마다 연결 하나를 두고 쓰는 쪽(기능 id)을 센다. 연결의 단계는 상태
// 기계(debugger-connection.ts)가 정하고, 여기서는 그 할 일(붙이기, 떼기, 쓰는 쪽에 알리기)을 한다. 붙이기와 떼기의 결과는
// 사건으로 돌려 넣는다. 상태는 서비스 워커의 메모리에만 있다. 서비스 워커가 다시 시작하면 쓰는 쪽(기능)이 자기 기록으로 다시
// 붙인다(acquire는 이미 붙은 연결도 붙은 것으로 받는다). 디버거가 붙은 동안 Chrome은 서비스 워커를 멈추지 않는다(R-20).

export interface DebuggerDeps {
  readonly attach: (tabId: number) => Promise<Result<null, AppError>>;
  readonly detach: (tabId: number) => Promise<Result<null, AppError>>;
  readonly send: (
    tabId: number,
    method: string,
    params: Readonly<Record<string, unknown>>,
  ) => Promise<Result<unknown, AppError>>;
  readonly record: (problem: Problem) => void;
}

export interface DebuggerManager {
  // user가 그 탭에 붙여 쓴다. 이미 붙어 있으면 바로, 아니면 붙인 뒤 답한다. 붙이지 못하면 그 까닭이다. 기다리는 동안 user가
  // 그만 쓰면 cancelled다.
  readonly acquire: (tabId: number, user: string) => Promise<Result<null, AppError>>;
  // user가 그 탭을 그만 쓴다. 쓰는 쪽이 없어지면 뗀다(떼기는 기다리지 않는다).
  readonly release: (tabId: number, user: string) => void;
  // 이 관리가 쓰지 않는 그 탭에 앞 서비스 워커가 붙인 연결이 남았을 수 있으면 뗀다(결정 0038의 다시 맞춤).
  readonly discard: (tabId: number) => void;
  // 붙은 탭에 프로토콜 명령을 보낸다. 붙어 있지 않으면 unavailable이다.
  readonly send: (
    tabId: number,
    method: string,
    params?: Readonly<Record<string, unknown>>,
  ) => Promise<Result<unknown, AppError>>;
  // user가 쓰던 연결이 밖에서 끊기면 알린다(user마다 하나).
  readonly onLost: (user: string, listener: (tabId: number, loss: DebuggerLoss) => void) => void;
  // Chrome이 그 탭의 연결을 끊었다(debugger.onDetach를 듣는 곳이 부른다).
  readonly lost: (tabId: number, loss: DebuggerLoss) => void;
}

export function createDebuggerManager(deps: DebuggerDeps): DebuggerManager {
  // 붙기를 기다리는 acquire. "탭:쓰는 쪽" → 그 답을 줄 함수들.
  const waiting = new Map<string, ((result: Result<null, AppError>) => void)[]>();
  const lostListeners = new Map<string, (tabId: number, loss: DebuggerLoss) => void>();
  const keyOf = (tabId: number, user: string) => `${String(tabId)}:${user}`;

  const answer = (tabId: number, user: string, result: Result<null, AppError>) => {
    const key = keyOf(tabId, user);
    const resolvers = waiting.get(key) ?? [];
    waiting.delete(key);
    for (const resolve of resolvers) resolve(result);
  };

  // 비동기 일의 결과를 사건으로 돌려 넣는다. 일이 던지면(일어나면 안 됨) 기록하고 실패로 넣는다.
  const settle = (
    work: () => Promise<Result<null, AppError>>,
    onDone: (result: Result<null, AppError>) => ConnectionEvent,
  ) => {
    void work()
      .catch(() => {
        deps.record({ featureId: null, kind: 'unexpected' });
        return err(appError('unexpected', strings.debuggerUnexpected));
      })
      .then((result) => {
        machine.dispatch(onDone(result));
      })
      // dispatch의 할 일이 던지는 것도 일어나면 안 된다. 기다리는 쪽이 없으므로 기록한다(quality 067).
      .catch(() => {
        deps.record({ featureId: null, kind: 'unexpected' });
      });
  };

  const perform = (effect: ConnectionEffect) => {
    switch (effect.type) {
      case 'attach': {
        const { tabId, run } = effect;
        settle(
          () => deps.attach(tabId),
          (result): ConnectionEvent =>
            result.ok
              ? { type: 'attached', tabId, run }
              : { type: 'attachFailed', tabId, run, error: result.error },
        );
        return;
      }
      case 'detach': {
        const { tabId, run } = effect;
        // 떼지 못해도(일어나면 안 됨) 떨어진 것으로 본다. 붙은 채로 보면 다시 쓰려는 쪽이 끝없이 기다린다. 남은 연결은 그
        // 탭을 닫거나 확장을 다시 불러오면 Chrome이 지운다.
        settle(
          () => deps.detach(tabId),
          (result): ConnectionEvent => {
            if (!result.ok) deps.record({ featureId: null, kind: result.error.kind });
            return { type: 'detached', tabId, run };
          },
        );
        return;
      }
      case 'granted':
        for (const user of effect.users) answer(effect.tabId, user, ok(null));
        return;
      case 'refused':
        for (const user of effect.users) answer(effect.tabId, user, err(effect.error));
        return;
      case 'withdrawn':
        answer(effect.tabId, effect.user, err(appError('cancelled', strings.debuggerWithdrawn)));
        return;
      case 'lost':
        for (const user of effect.users) lostListeners.get(user)?.(effect.tabId, effect.loss);
        return;
    }
  };

  const machine = runMachine<Connections, ConnectionEvent, ConnectionEffect>(
    initialConnections,
    transition,
    perform,
  );

  return {
    acquire: (tabId, user) =>
      new Promise((resolve) => {
        const key = keyOf(tabId, user);
        waiting.set(key, [...(waiting.get(key) ?? []), resolve]);
        machine.dispatch({ type: 'acquire', tabId, user });
      }),
    release: (tabId, user) => {
      machine.dispatch({ type: 'release', tabId, user });
    },
    discard: (tabId) => {
      machine.dispatch({ type: 'discard', tabId });
    },
    send: async (tabId, method, params = {}) => {
      if (!isAttached(machine.state(), tabId)) {
        return err(appError('unavailable', strings.debuggerNotAttached));
      }
      return deps.send(tabId, method, params);
    },
    onLost: (user, listener) => {
      lostListeners.set(user, listener);
    },
    lost: (tabId, loss) => {
      machine.dispatch({ type: 'lost', tabId, loss });
    },
  };
}
