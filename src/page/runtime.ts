import {
  type ElementRef,
  type FeatureCommand,
  type PageBundle,
  type PageStatus,
  type UnmetReason,
  pageRuntimeKey,
  retireEventName,
  v,
} from '../contracts/index.ts';
import {
  type NamedElement,
  type Scope,
  awaitApplied,
  awaitElement,
  claimOwnedElements,
  createScope,
  elementTimeoutMs,
  visibilityEventNames,
} from '../dom/index.ts';
import {
  type AppError,
  type ErrorKind,
  type Result,
  appError,
  err,
  ok,
  runMachine,
} from '../shared/index.ts';
import type { SettingsReaderHandlers, Snapshot } from '../storage/index.ts';
import {
  type Lifecycle,
  type LifecycleEffect,
  type LifecycleEvent,
  initialLifecycle,
  transition,
  unmetOf,
} from './lifecycle.ts';
import { createNoticeBoard } from './notice.ts';
import type { PageContext, PagePart, PageStart } from './part.ts';

// 콘텐츠 스크립트 실행 틀(아키텍처 2·3장). 설정을 구독해 기능을 시작하고 정리한다.

// 서비스 워커에 기록을 부탁하는 문제(problem.report). 어긋남(찾지 못함, 적용되지 않음)은 그 요소를 싣는다(결정 0026, 0034).
export interface PageProblem {
  readonly featureId: string | null;
  readonly kind: ErrorKind;
  readonly element?: ElementRef;
}

// 기능이 외부 화면에 기대한 것이 어긋난 까닭과 그 요소(결정 0026, 0034). 기능 수명은 이것을 넘기기만 한다.
interface Unmet {
  readonly reason: UnmetReason;
  readonly element: NamedElement;
}

interface PageRuntimeDeps {
  readonly parts: readonly PagePart[];
  // 이 실행 틀을 담은 콘텐츠 스크립트 묶음. 표식의 값이 되어 서비스 워커의 탐침이 읽는다(결정 0029).
  readonly bundle: PageBundle;
  readonly context: PageContext;
  // 이 문서가 탭의 최상위 프레임인지. 진입점이 자기 창으로 정해 넘긴다. 실행 틀이 context.window로 정하지 않는 것은
  // DOM 시험이 Vitest의 iframe 안에서 돌기 때문이다.
  readonly topFrame: boolean;
  readonly subscribe: (handlers: SettingsReaderHandlers) => () => void;
  readonly report: (problem: PageProblem) => Promise<Result<null, AppError>>;
  readonly isConnected: () => boolean;
  // 서비스 워커가 보낸 작업 결과 알림의 글을 받는다(결정 0024). 돌려준 함수로 듣기를 그만둔다.
  readonly listenNotices: (show: (text: string) => void) => () => void;
  // 서비스 워커가 지금 상태(외부 화면에 기대한 것이 어긋난 기능)를 물으면 answer로 답한다(결정 0026, 0034). 돌려준 함수로 듣기를
  // 그만둔다.
  readonly listenStatus: (answer: () => PageStatus) => () => void;
  // 이 탭에서 켜진 탭마다 켜고 끄는 기능을 받는다(결정 0043). 탭마다 켜는 기능의 페이지 쪽 일이 이 묶음에 있을 때만 부른다.
  // 돌려준 함수로 그만둔다.
  readonly subscribeTab: (handlers: {
    readonly apply: (on: ReadonlySet<string>) => void;
    readonly problem: (error: AppError) => void;
  }) => () => void;
  // 기능의 명령을 그 기능의 서비스 워커 쪽에 보낸다(feature.command).
  readonly sendCommand: (
    featureId: string,
    name: string,
    payload: unknown,
  ) => Promise<Result<unknown, AppError>>;
  // 서비스 워커가 이 프레임에 보낸 기능의 명령을 받는다. 돌려준 함수로 듣기를 그만둔다.
  readonly listenCommands: (
    handle: (featureId: string, name: string, payload: unknown) => Result<unknown, AppError>,
  ) => () => void;
}

// 같은 스크립트가 한 프레임에 여러 번 실려도 실행 틀은 하나만 만든다(COM-1.4). 표식의 값은 그 실행 틀의 묶음이다.
// 격리된 쪽의 전역은 같은 확장의 콘텐츠 스크립트끼리만 함께 본다.
const runtimeMarker = Symbol.for(pageRuntimeKey);

// 실행 틀이 기능 명령에 답하는 실패의 문구.
const strings = {
  badAnswer: '서비스 워커의 답이 명령의 형식에 맞지 않는다.',
  badCommand: '명령의 내용이 맞지 않는다.',
  noAnswerer: '이 프레임에서 그 명령에 답하는 기능이 돌고 있지 않다.',
  retired: '확장이 다시 로드되었다. 이 페이지를 새로 고친다.',
};

const commandKey = (featureId: string, name: string) => `${featureId}/${name}`;

// 물러남 이벤트를 받았는데 아직 연결되어 있을 때 다시 확인하는 때(ms). 끝없이 확인하지 않는다(quality 069).
const retireRecheckDelaysMs = [200, 1000, 5000];

export function startPageRuntime(deps: PageRuntimeDeps): void {
  if (Reflect.get(globalThis, runtimeMarker) !== undefined) return;
  Reflect.set(globalThis, runtimeMarker, deps.bundle);

  let retired = false;
  let unsubscribe: () => void = () => undefined;

  // 이 프레임에서 작용하는 기능. 최상위에서만 작용한다고 정의한 기능(content.frames 'top')은 iframe에서 시작하지 않는다.
  // 콘텐츠 스크립트는 모든 프레임에 실리므로(아키텍처 2장) 정의의 프레임 범위는 여기서 지킨다.
  const parts = deps.topFrame ? deps.parts : deps.parts.filter((part) => part.frames === 'all');

  // 시작하는 방법: 이 실행의 자원 범위와 외부 화면 요소 찾기·적용 확인, 기능 명령을 받아 기능을 시작한다.
  type Start = (run: Omit<PageStart, keyof PageContext | 'topFrame'>) => void;

  // 기능의 켜기·끄기 수명은 상태 기계(lifecycle.ts)가 정하고, 실행 틀은 그 할 일만 한다(quality 062).
  // 상태 기계는 실행 번호만 알고, 그 실행의 자원 범위는 여기 둔다. 'start'와 'watch'가 만들고 'close'가 닫고 지운다.
  const scopes = new Map<number, Scope>();

  const report = (problem: PageProblem) => {
    void deps.report(problem).then((result) => {
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

  // 사건은 하나씩 끝까지 처리한다(run-to-completion, shared의 runMachine). 할 일을 하는 도중에 생긴 사건(시작 도중의
  // 실패, 연결이 끊겨 물러남)은 지금 사건의 할 일을 모두 마친 뒤 처리한다(예: 모두 멈춘 뒤에 남은 'start'가 기능을
  // 시작해 정리되지 않고 남는 일을 막는다, 결정 0020).
  const lifecycle = runMachine<
    Lifecycle<Start, Unmet>,
    LifecycleEvent<Start, Unmet>,
    LifecycleEffect<Start, Unmet>
  >(initialLifecycle, transition, (effect) => {
    perform(effect);
  });
  const { dispatch } = lifecycle;

  // 실행 run의 자원 범위를 만든다. 범위가 알린 실패는 그 실행의 실패다. 시작 도중 콜백이 실패해도 'close'가 이 범위를
  // 찾을 수 있게 먼저 맵에 둔다.
  const openScope = (featureId: string, run: number): Scope => {
    const scope = createScope({
      window: deps.context.window,
      onError: () => {
        dispatch({ type: 'fail', featureId, run });
      },
      isLive: checkConnection,
    });
    scopes.set(run, scope);
    return scope;
  };

  // 기능 하나의 실패(시작, 콜백, 정리에서 난 예외)는 그 기능만 멈추고 정리한 뒤 기록한다(quality 010, 결정 0014).
  // 외부 화면에 기대한 것이 어긋난 기능(요소를 찾지 못함, 찾은 요소에 건 변경이 작용하지 않음)도 그 기능만 멈추고 되돌린 뒤,
  // 찾지 못한 요소가 나타나거나 페이지 안에서 이동하면 다시 시작한다(결정 0026, 0033, 0034).
  // 다른 기능과 실행 틀은 그대로 돈다.
  const perform = (effect: LifecycleEffect<Start, Unmet>) => {
    switch (effect.type) {
      case 'start': {
        const { featureId, run } = effect;
        const scope = openScope(featureId, run);
        const unmet = (reason: UnmetReason, element: NamedElement) => {
          dispatch({ type: 'unmet', featureId, run, unmet: { reason, element } });
        };
        const find: PageStart['find'] = (element, onFound) =>
          awaitElement({
            scope,
            window: deps.context.window,
            element,
            onFound,
            limit: {
              ms: elementTimeoutMs,
              onTimeout: () => {
                unmet('not-found', element);
              },
            },
          });
        // 확인할 때 지금 화면에 없는 요소는 찾지 못한 것이다(결정 0035). 나타나는지 지켜보다 다시 시작한다.
        const verify: PageStart['verify'] = (elements, check) =>
          awaitApplied({
            scope,
            window: deps.context.window,
            elements,
            check,
            limitMs: elementTimeoutMs,
            onMissing: (element) => {
              unmet('not-found', element);
            },
            onUnapplied: (element) => {
              unmet('not-applied', element);
            },
          });
        // 기능 명령(결정 0043). 다른 기능의 명령을 쓰면 결함이다. 시작 함수의 예외처럼 그 기능만 멈춘다.
        const own = (command: FeatureCommand<unknown, unknown>) => {
          if (command.featureId !== featureId) {
            throw new Error(`기능 ${featureId}이 다른 기능(${command.featureId})의 명령을 썼다.`);
          }
        };
        const send: PageStart['send'] = async (command, payload) => {
          own(command);
          const sent = await deps.sendCommand(command.featureId, command.name, payload);
          if (!sent.ok) return sent;
          const value = v.safeParse(command.value, sent.value);
          return value.success ? ok(value.output) : err(appError('unexpected', strings.badAnswer));
        };
        const answer: PageStart['answer'] = (command, handle) => {
          own(command);
          const key = commandKey(command.featureId, command.name);
          const answerer = (payload: unknown): Result<unknown, AppError> => {
            const parsed = v.safeParse(command.payload, payload);
            return parsed.success
              ? handle(parsed.output)
              : err(appError('invalid-input', strings.badCommand));
          };
          answerers.set(key, answerer);
          scope.defer(() => {
            if (answerers.get(key) === answerer) answerers.delete(key);
          });
        };
        try {
          effect.start({ scope, find, verify, send, answer });
        } catch {
          // 시작 도중의 예외: 그때까지 범위에 맡긴 자원을 치우고 기록한다.
          dispatch({ type: 'fail', featureId, run });
        }
        return;
      }
      case 'watch': {
        // 찾지 못한 요소가 나타나는지 한도 없이 지켜본다. 숨겨진 동안은 쉰다. 적용되지 않은 기능은 지켜볼 것이 없다: 변경을
        // 되돌린 뒤라 작용하는지 볼 수 없고, 설정이 바뀌거나 페이지 안에서 이동하면 다시 시작한다(결정 0034).
        const { featureId, run, unmet } = effect;
        const scope = openScope(featureId, run);
        if (unmet.reason === 'not-applied') return;
        try {
          awaitElement({
            scope,
            window: deps.context.window,
            element: unmet.element,
            onFound: () => {
              dispatch({ type: 'met', featureId, run });
            },
            limit: null,
          });
        } catch {
          // 찾는 함수의 예외는 그 기능의 실패다.
          dispatch({ type: 'fail', featureId, run });
        }
        return;
      }
      case 'close': {
        const scope = scopes.get(effect.run);
        scopes.delete(effect.run);
        scope?.close();
        return;
      }
      case 'report': {
        const { featureId, problem } = effect;
        if (problem.kind === 'unexpected') {
          report({ featureId, kind: 'unexpected' });
          return;
        }
        const { reason, element } = problem.unmet;
        report({ featureId, kind: reason, element: { id: element.id, name: element.name } });
        return;
      }
    }
  };

  const stopAll = () => {
    dispatch({ type: 'stopAll' });
  };

  // 바뀐 기능만 다시 적용한다(결정 0011 읽는 쪽 계약 5). 기능마다 그 기능의 설정(JSON)이 key다. 탭마다 켜고 끄는 기능은 이
  // 탭에서 켜졌는지가 key이고, 꺼졌으면 시작하지 않는다(결정 0043). 설정을 받기 전에는 적용하지 않는다.
  let latest: Snapshot | null = null;
  let tabOn: ReadonlySet<string> = new Set();
  const desire = () => {
    const snapshot = latest;
    if (snapshot === null) return;
    dispatch({
      type: 'apply',
      desired: parts.map((part) => {
        const off = part.toggledBy === 'tab' && !tabOn.has(part.featureId);
        return {
          featureId: part.featureId,
          key:
            part.toggledBy === 'tab'
              ? String(!off)
              : JSON.stringify(snapshot.features.get(part.featureId) ?? null),
          start: (run: Omit<PageStart, keyof PageContext | 'topFrame'>) => {
            if (!off) part.start(snapshot, { ...deps.context, ...run, topFrame: deps.topFrame });
          },
        };
      }),
    });
  };
  const apply = (snapshot: Snapshot) => {
    latest = snapshot;
    desire();
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
      claimOwnedElements(event.detail);
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
  // 찾지 못해 멈춘 기능은 이동한 화면에서 다시 시작한다(결정 0033). 화면마다 있어야 할 요소가 다르기 때문이다. 연결이
  // 끊겼으면 물러난다.
  const onNavigation = () => {
    if (checkConnection()) dispatch({ type: 'navigated' });
  };
  // 페이지 안 이동(history.pushState, 주소의 # 바꾸기, 뒤로·앞으로)은 Navigation API가 한 이벤트로 알린다(Chrome 102부터).
  const { navigation } = deps.context.window;
  // 보임은 visibilitychange와 활성 상태 유지의 방패가 그것을 막고 보내는 보임 알림으로 듣는다(결정 0044).
  for (const type of visibilityEventNames) {
    deps.context.document.addEventListener(type, onVisibilityChange);
  }
  navigation.addEventListener('currententrychange', onNavigation);

  // 작업 결과 알림(결정 0024). 서비스 워커는 최상위 프레임에만 보낸다.
  const notices = createNoticeBoard(deps.context);
  const stopNotices = deps.listenNotices((text) => {
    if (checkConnection()) notices.show(text);
  });

  // 기능의 명령에 답하는 곳(기능 id와 이름 → 답하는 함수). 기능의 실행이 등록하고 그 범위가 닫히면 지운다(결정 0043).
  const answerers = new Map<string, (payload: unknown) => Result<unknown, AppError>>();
  const stopCommands = deps.listenCommands((featureId, name, payload) => {
    if (!checkConnection()) return err(appError('disconnected', strings.retired));
    const answerer = answerers.get(commandKey(featureId, name));
    return answerer === undefined
      ? err(appError('unavailable', strings.noAnswerer))
      : answerer(payload);
  });

  // 탭마다 켜고 끄는 기능이 이 묶음에 있으면 이 탭에서 켜진 것을 받는다(결정 0043).
  const stopTab = parts.some((part) => part.toggledBy === 'tab')
    ? deps.subscribeTab({
        apply: (on) => {
          if (!checkConnection()) return;
          tabOn = on;
          desire();
        },
        problem: (error) => {
          if (!checkConnection()) return;
          if (error.kind === 'disconnected') retire();
          else report({ featureId: null, kind: error.kind });
        },
      })
    : () => undefined;

  // 팝업이 열릴 때 서비스 워커가 최상위 프레임에 묻는다(결정 0026, 0034). 상태 기계의 지금 상태에서 계산한다.
  const stopStatus = deps.listenStatus(() => ({
    unmet: unmetOf(lifecycle.state()).map(({ featureId, unmet }) => ({
      featureId,
      reason: unmet.reason,
      element: { id: unmet.element.id, name: unmet.element.name },
    })),
  }));

  unsubscribe = deps.subscribe({
    apply,
    // 손상은 서비스 워커가 고쳐 쓰면서 한 번 기록한다. 프레임마다 기록하지 않는다.
    corrupt: () => undefined,
    // 더 새 형식의 설정이면 기능을 멈춘다(결정 0011).
    newer: stopAll,
    problem: (error) => {
      if (!checkConnection()) return;
      if (error.kind === 'disconnected') retire();
      else report({ featureId: null, kind: error.kind });
    },
  });

  // 물러남의 정리. 한 단계가 던져도 나머지를 끝까지 한다. 끊긴 옛 세계에서는 확장 API가 사라져 듣기를 그만두다 던질 수
  // 있고(2026-10-18, 사용자의 Chrome에서 chrome.storage가 없어짐), 그때 기능의 정리(stopAll)와 표식 지우기가 빠지면 옛 세계가
  // 반쯤 남는다.
  const retireSteps: readonly (() => void)[] = [
    () => {
      deps.context.document.removeEventListener(retireEventName, onRetireEvent);
      for (const type of visibilityEventNames) {
        deps.context.document.removeEventListener(type, onVisibilityChange);
      }
      navigation.removeEventListener('currententrychange', onNavigation);
      for (const timer of recheckTimers) deps.context.window.clearTimeout(timer);
      recheckTimers.clear();
    },
    () => {
      unsubscribe();
    },
    stopNotices,
    stopStatus,
    stopCommands,
    stopTab,
    notices.close,
    stopAll,
    () => {
      Reflect.deleteProperty(globalThis, runtimeMarker);
    },
  ];

  function retire() {
    if (retired) return;
    retired = true;
    for (const step of retireSteps) {
      try {
        step();
      } catch {
        // 알릴 곳이 없다(서비스 워커와 끊겼다). 페이지로 내지 않고 다음 단계로 간다.
      }
    }
  }
}
