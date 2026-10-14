// 기능의 켜기·끄기 수명(quality 062, architecture 7장 "상태 기계").
// (상태, 사건) → (새 상태, 할 일 목록)인 순수 함수다. 실행 틀(runtime.ts)이 사건을 넣고 할 일을 한다.
// 기능이 만든 자원(자원 범위, 결정 0014)은 여기 두지 않는다. 시작할 때마다 새 실행 번호를 주고, 실행 틀이 그 번호로 범위를 가진다.

// 기능 하나의 상태. 맵에 없으면 멈춤이다(시작한 적이 없거나 모두 멈춤).
// - running: 이 설정(key)으로 시작했고 실행 run의 자원이 살아 있다.
// - failed: 이 설정으로 시작했다가 실패해 자원을 치웠다. 남은 자원이 없으므로 실행 번호가 없다.
//   설정이 바뀔 때까지 다시 시작하지 않는다(quality 010).
type FeaturePhase =
  | { readonly phase: 'running'; readonly key: string; readonly run: number }
  | { readonly phase: 'failed'; readonly key: string };

export interface Lifecycle {
  readonly features: ReadonlyMap<string, FeaturePhase>;
  // 다음 실행의 번호. 번호를 다시 쓰지 않으므로, 늦게 온 옛 실행의 실패를 지금 실행과 가를 수 있다.
  readonly nextRun: number;
}

// 바라는 상태: 기능, 그 기능의 지금 설정을 나타내는 key(같으면 다시 시작하지 않는다, 결정 0011 읽는 쪽 계약 5),
// 시작하는 방법(실행 틀이 정하고 이 함수는 넘기기만 한다).
export interface Desired<T> {
  readonly featureId: string;
  readonly key: string;
  readonly start: T;
}

export type LifecycleEvent<T> =
  // 새 설정을 받았다.
  | { readonly type: 'apply'; readonly desired: readonly Desired<T>[] }
  // 실행 run의 자원 범위가 실패를 알렸다(시작 도중, 콜백, 정리의 예외. 결정 0014).
  | { readonly type: 'fail'; readonly featureId: string; readonly run: number }
  // 모두 멈춘다(더 새 형식의 설정, 물러남).
  | { readonly type: 'stopAll' };

export type LifecycleEffect<T> =
  | { readonly type: 'start'; readonly featureId: string; readonly run: number; readonly start: T }
  | { readonly type: 'close'; readonly run: number }
  | { readonly type: 'report'; readonly featureId: string };

export const initialLifecycle: Lifecycle = { features: new Map(), nextRun: 1 };

export function transition<T>(
  state: Lifecycle,
  event: LifecycleEvent<T>,
): { readonly state: Lifecycle; readonly effects: readonly LifecycleEffect<T>[] } {
  switch (event.type) {
    case 'apply': {
      const features = new Map(state.features);
      const effects: LifecycleEffect<T>[] = [];
      let nextRun = state.nextRun;
      for (const { featureId, key, start } of event.desired) {
        const current = features.get(featureId);
        if (current?.key === key) continue;
        if (current?.phase === 'running') effects.push({ type: 'close', run: current.run });
        features.set(featureId, { phase: 'running', key, run: nextRun });
        effects.push({ type: 'start', featureId, run: nextRun, start });
        nextRun += 1;
      }
      return { state: { features, nextRun }, effects };
    }
    case 'fail': {
      // 실패는 모두 기록한다. 지금 실행의 실패일 때만 그 실행을 닫고 실패 상태로 둔다.
      // 그 밖의 실패(닫히는 옛 실행의 정리 실패, 거듭 온 실패)는 상태를 바꾸지 않는다.
      const report: LifecycleEffect<T> = { type: 'report', featureId: event.featureId };
      const current = state.features.get(event.featureId);
      if (current?.phase !== 'running' || current.run !== event.run) {
        return { state, effects: [report] };
      }
      const features = new Map(state.features);
      features.set(event.featureId, { phase: 'failed', key: current.key });
      return {
        state: { features, nextRun: state.nextRun },
        effects: [report, { type: 'close', run: current.run }],
      };
    }
    case 'stopAll': {
      const effects: LifecycleEffect<T>[] = [];
      for (const phase of state.features.values()) {
        if (phase.phase === 'running') effects.push({ type: 'close', run: phase.run });
      }
      return { state: { features: new Map(), nextRun: state.nextRun }, effects };
    }
  }
}
