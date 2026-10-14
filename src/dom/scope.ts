// 기능 하나가 페이지에 만든 자원의 수명(quality 083, 결정 0014).
// 자원을 만들면 곧바로 그 정리를 범위에 맡기고, 페이지가 부르는 콜백은 범위로 감싼다.
// 그래서 시작 도중에 실패해도 그때까지 만든 자원을 치울 수 있고, 콜백에서 난 예외는 그 기능만 멈추고 정리하는 데로 이어진다.

export interface Scope {
  // 자원을 만든 바로 뒤에 그 정리 함수를 맡긴다. 범위가 닫히면 맡긴 반대 순서로 부른다.
  // 돌려준 함수를 부르면 그 자원만 먼저 정리한다. 이미 닫힌 범위에 맡기면 곧바로 정리한다.
  readonly defer: (cleanup: () => void) => () => void;
  // 페이지(이벤트, 관찰, 타이머)가 부르는 콜백을 감싼다. 예외가 나거나 돌려준 Promise가 거절되면
  // 범위를 만든 쪽(실행 틀)에 알린다. 범위가 닫힌 뒤에는 콜백을 부르지 않는다.
  readonly guard: <A extends unknown[]>(
    callback: (...args: A) => void | Promise<void>,
  ) => (...args: A) => void;
  // 영상 하나처럼 기능보다 짧게 사는 것의 범위. 바깥 범위가 닫히면 함께 닫힌다.
  // 안쪽 콜백의 예외도 바깥과 같이 알린다(기능 전체를 멈춘다).
  readonly child: () => Scope;
  readonly close: () => void;

  // 자주 쓰는 자원의 도우미. 모두 defer와 guard로 만든다. 돌려준 함수는 그 자원만 먼저 정리한다.
  readonly listen: (
    target: EventTarget,
    type: string,
    listener: (event: Event) => void | Promise<void>,
    options?: { readonly capture?: boolean; readonly passive?: boolean },
  ) => () => void;
  // 관찰은 관찰자 객체를 내주지 않고 관찰을 시작하는 함수만 내준다. 닫힌 범위에서는 관찰을 시작하지 않는다.
  // 콜백도 관찰자를 받지 않는다. 그래서 범위가 닫힌 뒤에 관찰이 다시 생길 길이 없다.
  readonly mutationObserver: (
    callback: (records: MutationRecord[]) => void | Promise<void>,
  ) => ScopedMutationObserver;
  readonly resizeObserver: (
    callback: (entries: ResizeObserverEntry[]) => void | Promise<void>,
  ) => ScopedResizeObserver;
}

interface ScopedMutationObserver {
  readonly observe: (target: Node, options?: MutationObserverInit) => void;
}

interface ScopedResizeObserver {
  readonly observe: (target: Element, options?: ResizeObserverOptions) => void;
  readonly unobserve: (target: Element) => void;
}

interface ScopeHooks {
  // 콜백의 예외와 정리 함수의 예외를 받는다. 받은 쪽(실행 틀)이 기능을 멈추고 기록한다.
  readonly onError: (error: unknown) => void;
  // 감싼 콜백을 부르기 전에 묻는다. 거짓이면 부르지 않는다. 실행 틀은 이때 확장과의 연결을 확인하고,
  // 끊겼으면 물러난다(결정 0008의 보조 방법: 확장의 단축키와 화면 조작도 이 콜백으로 온다).
  readonly isLive: () => boolean;
}

export function createScope(hooks: ScopeHooks): Scope {
  return makeScope(hooks, null);
}

function makeScope({ onError, isLive }: ScopeHooks, detachFromParent: (() => void) | null): Scope {
  let closed = false;
  // Set은 넣은 순서를 지킨다. 닫을 때 거꾸로 돈다.
  const cleanups = new Set<() => void>();

  // 정리 하나가 실패해도 나머지 정리는 한다.
  const run = (cleanup: () => void) => {
    try {
      cleanup();
    } catch (error) {
      onError(error);
    }
  };

  const defer = (cleanup: () => void): (() => void) => {
    if (closed) {
      run(cleanup);
      return () => undefined;
    }
    let done = false;
    const release = () => {
      if (done) return;
      done = true;
      cleanups.delete(release);
      run(cleanup);
    };
    cleanups.add(release);
    return release;
  };

  const close = () => {
    if (closed) return;
    closed = true;
    detachFromParent?.();
    for (const release of [...cleanups].reverse()) release();
  };

  const guard =
    <A extends unknown[]>(callback: (...args: A) => void | Promise<void>) =>
    (...args: A) => {
      if (closed || !isLive()) return;
      try {
        const result = callback(...args);
        if (result instanceof Promise) result.catch(onError);
      } catch (error) {
        onError(error);
      }
    };

  const child = (): Scope => {
    let detach = (): void => undefined;
    const inner = makeScope({ onError, isLive }, () => {
      detach();
    });
    detach = defer(inner.close);
    return inner;
  };

  return {
    defer,
    guard,
    child,
    close,
    listen: (target, type, listener, options = {}) => {
      const guarded = guard(listener);
      target.addEventListener(type, guarded, options);
      return defer(() => {
        target.removeEventListener(type, guarded, { capture: options.capture ?? false });
      });
    },
    mutationObserver: (callback) => {
      const guarded = guard(callback);
      const observer = new MutationObserver((records) => {
        guarded(records);
      });
      defer(() => {
        observer.disconnect();
      });
      return {
        observe: (target, options) => {
          if (!closed) observer.observe(target, options);
        },
      };
    },
    resizeObserver: (callback) => {
      const guarded = guard(callback);
      const observer = new ResizeObserver((entries) => {
        guarded(entries);
      });
      defer(() => {
        observer.disconnect();
      });
      return {
        observe: (target, options) => {
          if (!closed) observer.observe(target, options);
        },
        unobserve: (target) => {
          observer.unobserve(target);
        },
      };
    },
  };
}
