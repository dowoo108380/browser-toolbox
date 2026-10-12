// 비동기 일을 들어온 순서대로 하나씩 한다. 앞 일이 실패해도 다음 일은 한다.
// 서비스 워커의 설정 쓰기가 읽고-고치고-쓰기를 겹치지 않게 하는 데 쓴다(결정 0005).
export function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
