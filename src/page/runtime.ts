import { pageRuntimeKey, retireEventName } from '../contracts/index.ts';
import { type Scope, claimOwnedHosts, createScope } from '../dom/index.ts';
import type { AppError, ErrorKind, Result } from '../shared/index.ts';
import type { SettingsReaderHandlers, Snapshot } from '../storage/index.ts';
import {
  type LifecycleEffect,
  type LifecycleEvent,
  initialLifecycle,
  transition,
} from './lifecycle.ts';
import { createNoticeBoard } from './notice.ts';
import type { PageContext, PagePart } from './part.ts';

// 콘텐츠 스크립트 실행 틀(아키텍처 2·3장). 설정을 구독해 기능을 시작하고 정리한다.

interface PageRuntimeDeps {
  readonly parts: readonly PagePart[];
  readonly context: PageContext;
  readonly subscribe: (handlers: SettingsReaderHandlers) => () => void;
  readonly report: (featureId: string | null, kind: ErrorKind) => Promise<Result<null, AppError>>;
  readonly isConnected: () => boolean;
  // 서비스 워커가 보낸 작업 결과 알림의 글을 받는다(결정 0024). 돌려준 함수로 듣기를 그만둔다.
  readonly listenNotices: (show: (text: string) => void) => () => void;
}

// 같은 스크립트가 한 프레임에 여러 번 실려도 실행 틀은 하나만 만든다(COM-1.4).
// 격리된 쪽의 전역은 같은 확장의 콘텐츠 스크립트끼리만 함께 본다.
const runtimeMarker = Symbol.for(pageRuntimeKey);

// 물러남 이벤트를 받았는데 아직 연결되어 있을 때 다시 확인하는 때(ms). 끝없이 확인하지 않는다(quality 069).
const retireRecheckDelaysMs = [200, 1000, 5000];

export function startPageRuntime(deps: PageRuntimeDeps): void {
  if (Reflect.get(globalThis, runtimeMarker) === true) return;
  Reflect.set(globalThis, runtimeMarker, true);

  let retired = false;
  let unsubscribe: () => void = () => undefined;

  // 기능의 켜기·끄기 수명은 상태 기계(lifecycle.ts)가 정하고, 실행 틀은 그 할 일만 한다(quality 062).
  // 상태 기계는 실행 번호만 알고, 그 실행의 자원 범위는 여기 둔다. 'start'가 만들고 'close'가 닫고 지운다.
  let lifecycle = initialLifecycle;
  const scopes = new Map<number, Scope>();

  const report = (featureId: string | null, kind: ErrorKind) => {
    void deps.report(featureId, kind).then((result) => {
      // 확장 API가 끊겼다고 하면 옛 스크립트다. 물러난다(결정 0008의 셋째 방법).
      if (!result.ok && result.error.kind === 'disconnected') retire();
    });
  };

  // 결정 0008의 보조 방법: 물러남 이벤트를 놓친 옛 스크립트도 스스로 알아차린다. 주기적으로 확인하지 않고(quality 003)
  // 탭이 다시 보일 때, 페이지 안에서 이동할 때, 기능이 페이지 사건에 반응하려 할 때 확인한다. 확장의 단축키와
  // 페이지 위 화면 조작은 기능의 콜백으로 오므로 마지막 경우에 든다(자원 범위가 콜백 전에 묻는다, 결정 0014).
  // 끊겼으면 물러나고 거짓을 돌려준다.
  const checkConnection = (): boolean => {
    if (retired) return false;
    if (deps.isConnected()) return true;
    retire();
    return false;
  };

  // 시작하는 방법: 이 실행의 자원 범위를 받아 기능을 시작한다.
  type Start = (scope: Scope) => void;

  // 사건은 하나씩 끝까지 처리한다(run-to-completion). 할 일을 하는 도중에 생긴 사건(시작 도중의 실패, 연결이 끊겨
  // 물러남)은 줄에 두었다가 지금 사건의 할 일을 모두 마친 뒤 처리한다. 그러지 않으면 바로 처리한 사건 뒤에 남은
  // 할 일이 그 사건이 만든 상태와 어긋난다(예: 모두 멈춘 뒤에 남은 'start'가 기능을 시작해 정리되지 않고 남음).
  const queue: LifecycleEvent<Start>[] = [];
  let dispatching = false;
  const dispatch = (event: LifecycleEvent<Start>) => {
    queue.push(event);
    if (dispatching) return;
    dispatching = true;
    try {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        const result = transition(lifecycle, next);
        lifecycle = result.state;
        for (const effect of result.effects) perform(effect);
      }
    } finally {
      dispatching = false;
    }
  };

  // 기능 하나의 실패(시작, 콜백, 정리에서 난 예외)는 그 기능만 멈추고 정리한 뒤 기록한다(quality 010, 결정 0014).
  // 다른 기능과 실행 틀은 그대로 돈다.
  const perform = (effect: LifecycleEffect<Start>) => {
    switch (effect.type) {
      case 'start': {
        const fail = () => {
          dispatch({ type: 'fail', featureId: effect.featureId, run: effect.run });
        };
        // 시작 도중 콜백이 실패해도 'close'가 이 범위를 찾을 수 있게 먼저 둔다.
        const scope = createScope({ onError: fail, isLive: checkConnection });
        scopes.set(effect.run, scope);
        try {
          effect.start(scope);
        } catch {
          // 시작 도중의 예외: 그때까지 범위에 맡긴 자원을 치우고 기록한다.
          fail();
        }
        return;
      }
      case 'close': {
        const scope = scopes.get(effect.run);
        scopes.delete(effect.run);
        scope?.close();
        return;
      }
      case 'report':
        report(effect.featureId, 'unexpected');
        return;
    }
  };

  const stopAll = () => {
    dispatch({ type: 'stopAll' });
  };

  // 바뀐 기능만 다시 적용한다(결정 0011 읽는 쪽 계약 5). 기능마다 그 기능의 설정(JSON)이 key다.
  const apply = (snapshot: Snapshot) => {
    dispatch({
      type: 'apply',
      desired: deps.parts.map((part) => ({
        featureId: part.featureId,
        key: JSON.stringify(snapshot.features.get(part.featureId) ?? null),
        start: (scope: Scope) => {
          part.start(snapshot, { ...deps.context, scope });
        },
      })),
    });
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

  const onVisibilityChange = () => {
    if (deps.context.document.visibilityState === 'visible') checkConnection();
  };
  const onNavigation = () => {
    checkConnection();
  };
  // 페이지 안 이동(history.pushState, 주소의 # 바꾸기, 뒤로·앞으로)은 Navigation API가 한 이벤트로 알린다(Chrome 102부터).
  const { navigation } = deps.context.window;
  deps.context.document.addEventListener('visibilitychange', onVisibilityChange);
  navigation.addEventListener('currententrychange', onNavigation);

  // 작업 결과 알림(결정 0024). 서비스 워커는 최상위 프레임에만 보낸다.
  const notices = createNoticeBoard(deps.context);
  const stopNotices = deps.listenNotices((text) => {
    if (checkConnection()) notices.show(text);
  });

  unsubscribe = deps.subscribe({
    apply,
    // 손상은 서비스 워커가 고쳐 쓰면서 한 번 기록한다. 프레임마다 기록하지 않는다.
    corrupt: () => undefined,
    // 더 새 형식의 설정이면 기능을 멈춘다(결정 0011).
    newer: stopAll,
    problem: (error) => {
      if (!checkConnection()) return;
      if (error.kind === 'disconnected') retire();
      else report(null, error.kind);
    },
  });

  function retire() {
    if (retired) return;
    retired = true;
    deps.context.document.removeEventListener(retireEventName, onRetireEvent);
    deps.context.document.removeEventListener('visibilitychange', onVisibilityChange);
    navigation.removeEventListener('currententrychange', onNavigation);
    for (const timer of recheckTimers) deps.context.window.clearTimeout(timer);
    recheckTimers.clear();
    unsubscribe();
    stopNotices();
    notices.close();
    stopAll();
    Reflect.deleteProperty(globalThis, runtimeMarker);
  }
}
