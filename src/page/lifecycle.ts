// 기능의 켜기·끄기 수명(quality 062, architecture 7장 "상태 기계").
// (상태, 사건) → (새 상태, 할 일 목록)인 순수 함수다. 실행 틀(runtime.ts)이 사건을 넣고 할 일을 한다.
// 기능이 만든 자원(자원 범위, 결정 0014)은 여기 두지 않는다. 시작할 때마다 새 실행 번호를 주고, 실행 틀이 그 번호로 범위를 가진다.
// 시작하는 방법(T)과 외부 화면 요소(E)는 실행 틀만 아는 것이라 넘기기만 한다(결정 0020, 0026).

// 기능 하나의 상태. 맵에 없으면 멈춤이다(시작한 적이 없거나 모두 멈춤).
// - running: 이 설정(key)으로 시작했고 실행 run의 자원이 살아 있다.
// - notFound: 이 설정으로 시작했다가 기대는 외부 화면 요소를 찾지 못해 그 실행을 닫았다(결정 0026). 실행 run은 그 요소가
//   나타나는지 지켜보는 자원이고, 나타나면 start로 다시 시작한다.
// - failed: 이 설정으로 시작했다가 실패해 자원을 치웠다. 남은 자원이 없으므로 실행 번호가 없다.
//   설정이 바뀔 때까지 다시 시작하지 않는다(quality 010).
type FeaturePhase<T, E> =
  | { readonly phase: 'running'; readonly key: string; readonly run: number; readonly start: T }
  | {
      readonly phase: 'notFound';
      readonly key: string;
      readonly run: number;
      readonly start: T;
      readonly element: E;
    }
  | { readonly phase: 'failed'; readonly key: string };

export interface Lifecycle<T, E> {
  readonly features: ReadonlyMap<string, FeaturePhase<T, E>>;
  // 다음 실행의 번호. 번호를 다시 쓰지 않으므로, 늦게 온 옛 실행의 사건을 지금 실행과 가를 수 있다.
  readonly nextRun: number;
}

// 바라는 상태: 기능, 그 기능의 지금 설정을 나타내는 key(같으면 다시 시작하지 않는다, 결정 0011 읽는 쪽 계약 5),
// 시작하는 방법(실행 틀이 정하고 이 함수는 넘기기만 한다).
export interface Desired<T> {
  readonly featureId: string;
  readonly key: string;
  readonly start: T;
}

export type LifecycleEvent<T, E> =
  // 새 설정을 받았다.
  | { readonly type: 'apply'; readonly desired: readonly Desired<T>[] }
  // 실행 run의 자원 범위가 실패를 알렸다(시작 도중, 콜백, 정리의 예외. 결정 0014).
  | { readonly type: 'fail'; readonly featureId: string; readonly run: number }
  // 실행 run의 찾기가 그 요소를 한도 안에 찾지 못했다(결정 0026).
  | {
      readonly type: 'notFound';
      readonly featureId: string;
      readonly run: number;
      readonly element: E;
    }
  // 찾지 못한 요소를 지켜보던 실행 run이 그 요소를 찾았다.
  | { readonly type: 'found'; readonly featureId: string; readonly run: number }
  // 모두 멈춘다(더 새 형식의 설정, 물러남).
  | { readonly type: 'stopAll' };

// 기록할 문제. 찾지 못함은 그 요소와 함께 남긴다(COM-5 기대 동작 2).
type LifecycleProblem<E> =
  { readonly kind: 'unexpected' } | { readonly kind: 'not-found'; readonly element: E };

export type LifecycleEffect<T, E> =
  | { readonly type: 'start'; readonly featureId: string; readonly run: number; readonly start: T }
  // 그 요소가 나타나는지 실행 run의 자원으로 지켜본다. 나타나면 'found' 사건이다.
  | {
      readonly type: 'watch';
      readonly featureId: string;
      readonly run: number;
      readonly element: E;
    }
  | { readonly type: 'close'; readonly run: number }
  | { readonly type: 'report'; readonly featureId: string; readonly problem: LifecycleProblem<E> };

export const initialLifecycle: Lifecycle<never, never> = { features: new Map(), nextRun: 1 };

const unexpected = { kind: 'unexpected' } as const;

export function transition<T, E>(
  state: Lifecycle<T, E>,
  event: LifecycleEvent<T, E>,
): { readonly state: Lifecycle<T, E>; readonly effects: readonly LifecycleEffect<T, E>[] } {
  switch (event.type) {
    case 'apply': {
      const features = new Map(state.features);
      const effects: LifecycleEffect<T, E>[] = [];
      let nextRun = state.nextRun;
      for (const { featureId, key, start } of event.desired) {
        const current = features.get(featureId);
        if (current?.key === key) continue;
        if (current !== undefined && current.phase !== 'failed') {
          effects.push({ type: 'close', run: current.run });
        }
        features.set(featureId, { phase: 'running', key, run: nextRun, start });
        effects.push({ type: 'start', featureId, run: nextRun, start });
        nextRun += 1;
      }
      return { state: { features, nextRun }, effects };
    }
    case 'fail': {
      // 실패는 모두 기록한다. 지금 실행(돌거나 지켜보는 것)의 실패일 때만 그 실행을 닫고 실패 상태로 둔다.
      // 그 밖의 실패(닫히는 옛 실행의 정리 실패, 거듭 온 실패)는 상태를 바꾸지 않는다.
      const report: LifecycleEffect<T, E> = {
        type: 'report',
        featureId: event.featureId,
        problem: unexpected,
      };
      const current = state.features.get(event.featureId);
      if (current === undefined || current.phase === 'failed' || current.run !== event.run) {
        return { state, effects: [report] };
      }
      const features = new Map(state.features);
      features.set(event.featureId, { phase: 'failed', key: current.key });
      return {
        state: { features, nextRun: state.nextRun },
        effects: [report, { type: 'close', run: current.run }],
      };
    }
    case 'notFound': {
      // 지금 돌던 실행의 것만 받는다. 그 실행을 닫아 기능의 변경을 모두 되돌리고, 기록하고, 새 번호로 지켜본다.
      // 그 밖(닫힌 실행의 늦은 알림)은 버린다.
      const current = state.features.get(event.featureId);
      if (current?.phase !== 'running' || current.run !== event.run) return { state, effects: [] };
      const features = new Map(state.features);
      const watch = state.nextRun;
      features.set(event.featureId, {
        phase: 'notFound',
        key: current.key,
        run: watch,
        start: current.start,
        element: event.element,
      });
      return {
        state: { features, nextRun: watch + 1 },
        effects: [
          { type: 'close', run: current.run },
          {
            type: 'report',
            featureId: event.featureId,
            problem: { kind: 'not-found', element: event.element },
          },
          { type: 'watch', featureId: event.featureId, run: watch, element: event.element },
        ],
      };
    }
    case 'found': {
      // 지금 지켜보던 실행의 것만 받는다. 지켜보기를 닫고 새 번호로 다시 시작한다.
      const current = state.features.get(event.featureId);
      if (current?.phase !== 'notFound' || current.run !== event.run) return { state, effects: [] };
      const features = new Map(state.features);
      const restart = state.nextRun;
      features.set(event.featureId, {
        phase: 'running',
        key: current.key,
        run: restart,
        start: current.start,
      });
      return {
        state: { features, nextRun: restart + 1 },
        effects: [
          { type: 'close', run: current.run },
          { type: 'start', featureId: event.featureId, run: restart, start: current.start },
        ],
      };
    }
    case 'stopAll': {
      const effects: LifecycleEffect<T, E>[] = [];
      for (const phase of state.features.values()) {
        if (phase.phase !== 'failed') effects.push({ type: 'close', run: phase.run });
      }
      return { state: { features: new Map(), nextRun: state.nextRun }, effects };
    }
  }
}

// 지금 기대는 외부 화면 요소를 찾지 못한 기능과 그 요소(팝업에 보인다, 결정 0026).
export function notFoundOf<T, E>(
  state: Lifecycle<T, E>,
): readonly { readonly featureId: string; readonly element: E }[] {
  return [...state.features].flatMap(([featureId, phase]) =>
    phase.phase === 'notFound' ? [{ featureId, element: phase.element }] : [],
  );
}
