// 상태 기계를 사건 하나씩 끝까지 돌리는 도우미(quality 062, 결정 0020). 상태 기계 모듈은 순수 함수 transition만 갖고, 할
// 일은 이것을 만든 쪽(실행 틀)이 perform으로 한다. 할 일을 하는 도중에 생긴 사건(시작 도중의 실패, 비동기 일의 결과가 바로 온
// 것)은 줄에 두었다가 지금 사건의 할 일을 모두 마친 뒤 처리한다(run-to-completion). 바로 처리하면 그 사건 뒤에 남은 할 일이 그
// 사건이 만든 상태와 어긋난다.

export interface Step<S, F> {
  readonly state: S;
  readonly effects: readonly F[];
}

export interface Machine<S, E> {
  readonly dispatch: (event: E) => void;
  // 지금 상태. 할 일 밖에서 상태를 읽는 쪽(예: 팝업이 묻는 지금 상태)이 쓴다.
  readonly state: () => S;
}

export function runMachine<S, E extends object, F>(
  initial: S,
  transition: (state: S, event: E) => Step<S, F>,
  perform: (effect: F) => void,
): Machine<S, E> {
  let state = initial;
  const queue: E[] = [];
  let dispatching = false;
  return {
    dispatch: (event) => {
      queue.push(event);
      if (dispatching) return;
      dispatching = true;
      try {
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
          const step = transition(state, next);
          state = step.state;
          for (const effect of step.effects) perform(effect);
        }
      } finally {
        dispatching = false;
      }
    },
    state: () => state,
  };
}
