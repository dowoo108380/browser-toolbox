// 제한 시간이 있는 기다림(quality 068, 아키텍처 7장 "비동기, 제한 시간, 취소").

type Timed<T> = { readonly done: true; readonly value: T } | { readonly done: false };

// work가 ms 안에 끝나면 그 값을, 넘으면 { done: false }를 돌려준다. 넘으면 work에 준 신호를 멈춘다(abort).
// 이미 시작한 일(예: Chrome API 호출)은 되돌릴 수 없으므로, work는 신호를 보고 다음 일을 시작하지 않는다.
// 시간을 넘긴 뒤에 온 결과와 거절은 버린다. 부르는 쪽은 시간 초과를 알린다(quality 067).
export async function withTimeout<T>(
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<Timed<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Timed<T>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ done: false });
    }, ms);
  });
  try {
    return await Promise.race([
      work(controller.signal).then((value): Timed<T> => ({ done: true, value })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
