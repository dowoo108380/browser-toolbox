// 기능의 켜기·끄기 수명(quality 062, architecture 7장 "상태 기계").
// (상태, 사건) → (새 상태, 할 일 목록)인 순수 함수다. 실행 틀(runtime.ts)이 사건을 넣고 할 일을 한다.
// 기능이 만든 자원(자원 범위, 결정 0014)은 여기 두지 않는다. 시작할 때마다 새 실행 번호를 주고, 실행 틀이 그 번호로 범위를 가진다.
// 시작하는 방법(T)과 외부 화면에 기대한 것이 어긋난 까닭과 요소(U)는 실행 틀만 아는 것이라 넘기기만 한다(결정 0020, 0026, 0034).

// 기능 하나의 상태. 맵에 없으면 멈춤이다(시작한 적이 없거나 모두 멈춤).
// - running: 이 설정(key)으로 시작했고 실행 run의 자원이 살아 있다.
// - unmet: 이 설정으로 시작했다가 외부 화면에 기대한 것이 어긋나(요소를 찾지 못함, 찾은 요소에 건 변경이 작용하지 않음) 그
//   실행을 닫았다(결정 0026, 0034). 실행 run은 그것이 풀리는지 지켜보는 자원이고, 풀리거나 페이지 안에서 이동하면 start로 다시
//   시작한다(결정 0033).
// - failed: 이 설정으로 시작했다가 실패해 자원을 치웠다. 남은 자원이 없으므로 실행 번호가 없다.
//   설정이 바뀔 때까지 다시 시작하지 않는다(quality 010).
type FeaturePhase<T, U> =
  | { readonly phase: 'running'; readonly key: string; readonly run: number; readonly start: T }
  | {
      readonly phase: 'unmet';
      readonly key: string;
      readonly run: number;
      readonly start: T;
      readonly unmet: U;
    }
  | { readonly phase: 'failed'; readonly key: string };

export interface Lifecycle<T, U> {
  readonly features: ReadonlyMap<string, FeaturePhase<T, U>>;
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

export type LifecycleEvent<T, U> =
  // 새 설정을 받았다.
  | { readonly type: 'apply'; readonly desired: readonly Desired<T>[] }
  // 실행 run의 자원 범위가 실패를 알렸다(시작 도중, 콜백, 정리의 예외. 결정 0014).
  | { readonly type: 'fail'; readonly featureId: string; readonly run: number }
  // 실행 run이 외부 화면에 기대한 것이 한도 안에 이루어지지 않았다(결정 0026, 0034).
  | {
      readonly type: 'unmet';
      readonly featureId: string;
      readonly run: number;
      readonly unmet: U;
    }
  // 어긋남을 지켜보던 실행 run이 그것이 풀린 것을 봤다(찾지 못한 요소가 나타남).
  | { readonly type: 'met'; readonly featureId: string; readonly run: number }
  // 페이지 안에서 이동했다(문서를 다시 싣지 않고 주소가 바뀜). 화면이 바뀌면 있어야 할 요소도 바뀐다(결정 0033).
  | { readonly type: 'navigated' }
  // 모두 멈춘다(더 새 형식의 설정, 물러남).
  | { readonly type: 'stopAll' };

// 기록할 문제. 어긋남은 그 까닭과 요소와 함께 남긴다(COM-5 기대 동작 2).
type LifecycleProblem<U> =
  { readonly kind: 'unexpected' } | { readonly kind: 'unmet'; readonly unmet: U };

export type LifecycleEffect<T, U> =
  | { readonly type: 'start'; readonly featureId: string; readonly run: number; readonly start: T }
  // 어긋남이 풀리는지 실행 run의 자원으로 지켜본다. 풀리면 'met' 사건이다. 지켜볼 것이 없는 어긋남도 있다(실행 틀이 정한다).
  | {
      readonly type: 'watch';
      readonly featureId: string;
      readonly run: number;
      readonly unmet: U;
    }
  | { readonly type: 'close'; readonly run: number }
  | { readonly type: 'report'; readonly featureId: string; readonly problem: LifecycleProblem<U> };

export const initialLifecycle: Lifecycle<never, never> = { features: new Map(), nextRun: 1 };

const unexpected = { kind: 'unexpected' } as const;

export function transition<T, U>(
  state: Lifecycle<T, U>,
  event: LifecycleEvent<T, U>,
): { readonly state: Lifecycle<T, U>; readonly effects: readonly LifecycleEffect<T, U>[] } {
  switch (event.type) {
    case 'apply': {
      const features = new Map(state.features);
      const effects: LifecycleEffect<T, U>[] = [];
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
      const report: LifecycleEffect<T, U> = {
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
    case 'unmet': {
      // 지금 돌던 실행의 것만 받는다. 그 실행을 닫아 기능의 변경을 모두 되돌리고, 기록하고, 새 번호로 지켜본다.
      // 그 밖(닫힌 실행의 늦은 알림)은 버린다.
      const current = state.features.get(event.featureId);
      if (current?.phase !== 'running' || current.run !== event.run) return { state, effects: [] };
      const features = new Map(state.features);
      const watch = state.nextRun;
      features.set(event.featureId, {
        phase: 'unmet',
        key: current.key,
        run: watch,
        start: current.start,
        unmet: event.unmet,
      });
      return {
        state: { features, nextRun: watch + 1 },
        effects: [
          { type: 'close', run: current.run },
          {
            type: 'report',
            featureId: event.featureId,
            problem: { kind: 'unmet', unmet: event.unmet },
          },
          { type: 'watch', featureId: event.featureId, run: watch, unmet: event.unmet },
        ],
      };
    }
    case 'met': {
      // 지금 지켜보던 실행의 것만 받는다. 지켜보기를 닫고 새 번호로 다시 시작한다.
      const current = state.features.get(event.featureId);
      if (current?.phase !== 'unmet' || current.run !== event.run) return { state, effects: [] };
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
    case 'navigated': {
      // 어긋난 기능은 앞 화면의 것을 더 기다리지 않는다. 지켜보기를 닫고 새 번호로 다시 시작해, 새 화면에 있어야 할 것을 그
      // 기능이 다시 정하고 그때부터 15초를 센다(COM-6 기대 동작 4). 돌거나 실패한 기능은 그대로다. 도는 기능은 이동을 스스로
      // 듣는다(결정 0031).
      const features = new Map(state.features);
      const effects: LifecycleEffect<T, U>[] = [];
      let nextRun = state.nextRun;
      for (const [featureId, phase] of state.features) {
        if (phase.phase !== 'unmet') continue;
        features.set(featureId, {
          phase: 'running',
          key: phase.key,
          run: nextRun,
          start: phase.start,
        });
        effects.push(
          { type: 'close', run: phase.run },
          { type: 'start', featureId, run: nextRun, start: phase.start },
        );
        nextRun += 1;
      }
      return { state: { features, nextRun }, effects };
    }
    case 'stopAll': {
      const effects: LifecycleEffect<T, U>[] = [];
      for (const phase of state.features.values()) {
        if (phase.phase !== 'failed') effects.push({ type: 'close', run: phase.run });
      }
      return { state: { features: new Map(), nextRun: state.nextRun }, effects };
    }
  }
}

// 지금 외부 화면에 기대한 것이 어긋난 기능과 그 어긋남(팝업에 보인다, 결정 0026, 0034).
export function unmetOf<T, U>(
  state: Lifecycle<T, U>,
): readonly { readonly featureId: string; readonly unmet: U }[] {
  return [...state.features].flatMap(([featureId, phase]) =>
    phase.phase === 'unmet' ? [{ featureId, unmet: phase.unmet }] : [],
  );
}
