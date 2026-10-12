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
  readonly mutationObserver: (callback: MutationCallback) => MutationObserver;
  readonly resizeObserver: (callback: ResizeObserverCallback) => ResizeObserver;
  // 다음 화면 그리기 전에 한 번 부른다.
  readonly animationFrame: (callback: () => void | Promise<void>) => () => void;
}

// onError는 콜백의 예외와 정리 함수의 예외를 받는다. 받은 쪽이 기능을 멈추고 기록한다.
export function createScope(window: Window, onError: (error: unknown) => void): Scope {
  return makeScope(window, onError, null);
}

function makeScope(
  window: Window,
  onError: (error: unknown) => void,
  detachFromParent: (() => void) | null,
): Scope {
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
      if (closed) return;
      try {
        const result = callback(...args);
        if (result instanceof Promise) result.catch(onError);
      } catch (error) {
        onError(error);
      }
    };

  const child = (): Scope => {
    let detach = (): void => undefined;
    const inner = makeScope(window, onError, () => {
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
      const observer = new MutationObserver(guard(callback));
      defer(() => {
        observer.disconnect();
      });
      return observer;
    },
    resizeObserver: (callback) => {
      const observer = new ResizeObserver(guard(callback));
      defer(() => {
        observer.disconnect();
      });
      return observer;
    },
    animationFrame: (callback) => {
      const guarded = guard(callback);
      let cancel = (): void => undefined;
      const id = window.requestAnimationFrame(() => {
        // 불렸으니 닫을 때 취소할 것이 없다. 범위에서 먼저 빼고 부른다.
        cancel();
        guarded();
      });
      cancel = defer(() => {
        window.cancelAnimationFrame(id);
      });
      return cancel;
    },
  };
}
