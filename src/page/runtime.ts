import { retireEventName } from '../contracts/index.ts';
import { claimOwnedHosts } from '../dom/index.ts';
import type { AppError, ErrorKind, Result } from '../shared/index.ts';
import type { SettingsReaderHandlers, Snapshot } from '../storage/index.ts';
import type { Dispose, PageContext, PagePart } from './part.ts';

// 콘텐츠 스크립트 실행 틀(아키텍처 2·3장). 설정을 구독해 기능을 시작하고 정리한다.

interface PageRuntimeDeps {
  readonly parts: readonly PagePart[];
  readonly context: PageContext;
  readonly subscribe: (handlers: SettingsReaderHandlers) => () => void;
  readonly report: (featureId: string | null, kind: ErrorKind) => Promise<Result<null, AppError>>;
  readonly isConnected: () => boolean;
}

// 같은 스크립트가 한 프레임에 여러 번 실려도 실행 틀은 하나만 만든다(COM-1.4).
// 격리된 쪽의 전역은 같은 확장의 콘텐츠 스크립트끼리만 함께 본다.
const runtimeMarker = Symbol.for('browser-toolbox.page-runtime');

// 물러남 이벤트를 받았는데 아직 연결되어 있을 때 다시 확인하는 때(ms). 끝없이 확인하지 않는다(quality 069).
const retireRecheckDelaysMs = [200, 1000, 5000];

export function startPageRuntime(deps: PageRuntimeDeps): void {
  if (Reflect.get(globalThis, runtimeMarker) === true) return;
  Reflect.set(globalThis, runtimeMarker, true);

  let retired = false;
  let unsubscribe: () => void = () => undefined;

  // 기능마다 마지막으로 적용한 설정(JSON)과 정리 함수.
  const running = new Map<string, { readonly key: string; readonly dispose: Dispose | null }>();

  const report = (featureId: string | null, kind: ErrorKind) => {
    void deps.report(featureId, kind).then((result) => {
      // 확장 API가 끊겼다고 하면 옛 스크립트다. 물러난다(결정 0008의 셋째 방법).
      if (!result.ok && result.error.kind === 'disconnected') retire();
    });
  };

  // 기능 하나의 실패는 그 기능만 멈춘다(quality 010).
  const guarded = (featureId: string, action: () => void) => {
    try {
      action();
    } catch {
      report(featureId, 'unexpected');
    }
  };

  const stop = (featureId: string) => {
    const dispose = running.get(featureId)?.dispose;
    running.delete(featureId);
    if (dispose) guarded(featureId, dispose);
  };

  const stopAll = () => {
    for (const featureId of [...running.keys()]) stop(featureId);
  };

  // 바뀐 기능만 다시 적용한다(결정 0011 읽는 쪽 계약 5).
  const apply = (snapshot: Snapshot) => {
    for (const part of deps.parts) {
      const key = JSON.stringify(snapshot.features.get(part.featureId) ?? null);
      if (running.get(part.featureId)?.key === key) continue;
      stop(part.featureId);
      let dispose: Dispose | null = null;
      guarded(part.featureId, () => {
        dispose = part.start(snapshot, deps.context);
      });
      running.set(part.featureId, { key, dispose });
    }
  };

  // 웹 페이지도 이 이벤트를 보낼 수 있다. 연결이 실제로 끊겼을 때만 따른다(결정 0008).
  // 연결되어 있으면 새 판이 보낸 것일 수 있으므로 자기 요소에 이벤트의 토큰을 적는다. 새 판은 토큰이 없는
  // 요소(코드가 더 돌지 않는 옛 세계의 것)를 지운다. 흉내 낸 이벤트로는 토큰만 바뀐다.
  // 새 판의 이벤트가 이 세계의 연결이 끊기기 전에 닿기도 하므로(05단계에서 확인), 정한 때에 몇 번 더 확인한다.
  const recheckTimers = new Set<number>();
  const onRetireEvent = (event: Event) => {
    if (!deps.isConnected()) {
      retire();
      return;
    }
    if (event instanceof CustomEvent && typeof event.detail === 'string') {
      claimOwnedHosts(event.detail);
    }
    if (recheckTimers.size > 0) return;
    for (const delay of retireRecheckDelaysMs) {
      const timer = deps.context.window.setTimeout(() => {
        recheckTimers.delete(timer);
        if (!deps.isConnected()) retire();
      }, delay);
      recheckTimers.add(timer);
    }
  };
  deps.context.document.addEventListener(retireEventName, onRetireEvent);

  unsubscribe = deps.subscribe({
    apply,
    // 손상은 서비스 워커가 고쳐 쓰면서 한 번 기록한다. 프레임마다 기록하지 않는다.
    corrupt: () => undefined,
    // 더 새 형식의 설정이면 기능을 멈춘다(결정 0011).
    newer: stopAll,
    problem: (error) => {
      if (error.kind === 'disconnected') retire();
      else report(null, error.kind);
    },
  });

  function retire() {
    if (retired) return;
    retired = true;
    deps.context.document.removeEventListener(retireEventName, onRetireEvent);
    for (const timer of recheckTimers) deps.context.window.clearTimeout(timer);
    recheckTimers.clear();
    unsubscribe();
    stopAll();
    Reflect.deleteProperty(globalThis, runtimeMarker);
  }
}
