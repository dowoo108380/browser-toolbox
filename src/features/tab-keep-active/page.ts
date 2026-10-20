import { type Point, safePair } from '../../dom/index.ts';
import { defineTabPagePart } from '../../page/index.ts';
import { ok } from '../../shared/index.ts';
import { armDetail, armEventName, nativeEventName, parseNative } from './core/shield.ts';
import { hiddenCommand, pointCommand, tabKeepActive } from './feature.ts';

// 페이지 활성 상태 유지의 페이지 쪽(TAB-2, 결정 0041). 이 탭에서 켜진 동안:
// - 모든 프레임: 그 문서의 페이지 쪽 방패(main.ts)를 켠다. 페이지는 초점이 있고 보인다고 여긴다(기대 동작 4).
// - 최상위 프레임: 방패가 알린 실제 숨김을 서비스 워커 쪽에 넘긴다(보는 탭인데 숨김이면 창이 가려진 것이다). 사용자가 마지막으로
//   마우스를 둔 곳을 기억하고, 서비스 워커 쪽이 물으면 가짜 입력을 보낼 안전한 두 점으로 답한다(기대 동작 7).
export const page = defineTabPagePart(tabKeepActive, (context) => {
  const { document, window, scope } = context;
  document.dispatchEvent(new CustomEvent(armEventName, { detail: armDetail(true) }));
  scope.defer(() => {
    document.dispatchEvent(new CustomEvent(armEventName, { detail: armDetail(false) }));
  });
  if (!context.topFrame) return;

  scope.listen(document, nativeEventName, async (event) => {
    const hidden = event instanceof CustomEvent ? parseNative(event.detail) : null;
    // 알리지 못해도 할 일이 없다(서비스 워커와 끊겼으면 실행 틀이 물러난다).
    if (hidden !== null) await context.send(hiddenCommand, { hidden });
  });

  let last: Point | null = null;
  scope.listen(
    window,
    'mousemove',
    (event) => {
      if (event instanceof MouseEvent && event.isTrusted)
        last = { x: event.clientX, y: event.clientY };
    },
    { capture: true, passive: true },
  );
  context.answer(pointCommand, ({ keep }) => ok({ pair: safePair(document, keep, last) }));
});
