import { type Point, safePair, visibilityEventNames } from '../../dom/index.ts';
import { defineTabPagePart } from '../../page/index.ts';
import { ok } from '../../shared/index.ts';
import { armDetail, armEventName } from './core/shield.ts';
import { hiddenCommand, pointCommand, tabKeepActive } from './feature.ts';

// 페이지 활성 상태 유지의 페이지 쪽(TAB-2, 결정 0041). 이 탭에서 켜진 동안:
// - 모든 프레임: 그 문서의 페이지 쪽 방패(main.ts)를 켠다. 페이지는 초점이 있고 보인다고 여긴다(기대 동작 4).
// - 최상위 프레임: 문서의 실제 숨김과 보임을 서비스 워커 쪽에 넘긴다(보는 탭인데 숨김이면 창이 가려진 것이다). 방패가 페이지에
//   숨긴 바뀜도 보임 알림으로 오고, 이 세계의 visibilityState는 방패가 바꾸지 않은 실제 값이다(결정 0044). 시작할 때 이미 숨어
//   있으면 그것도 한 번 넘긴다. 사용자가 마지막으로 마우스를 둔 곳을 기억하고, 서비스 워커 쪽이 물으면 가짜 입력을 보낼 안전한
//   두 점으로 답한다(기대 동작 7).
export const page = defineTabPagePart(tabKeepActive, (context) => {
  const { document, window, scope } = context;
  document.dispatchEvent(new CustomEvent(armEventName, { detail: armDetail(true) }));
  scope.defer(() => {
    document.dispatchEvent(new CustomEvent(armEventName, { detail: armDetail(false) }));
  });
  if (!context.topFrame) return;

  // 알리지 못해도 할 일이 없다(서비스 워커와 끊겼으면 실행 틀이 물러난다).
  const onVisibility = async () => {
    await context.send(hiddenCommand, { hidden: document.visibilityState !== 'visible' });
  };
  for (const type of visibilityEventNames) scope.listen(document, type, onVisibility);
  // 듣기는 바뀜만 받는다. 켜는 순간 이미 가려진 창의 활성 탭은 바뀜 없이 숨은 채라, 알리지 않으면 서비스 워커 쪽이 보는 탭으로
  // 알고 디버거를 붙이지 않는다. 방패를 켜며 페이지에 보낸 보임 바뀜도 듣기 전이라 받지 못했다. 그래서 듣기를 건 뒤 지금의 숨김을
  // 한 번 알린다. 보이면 알릴 것이 없다(서비스 워커 쪽은 보임을 받아도 할 일이 없다).
  if (document.visibilityState !== 'visible') scope.guard(onVisibility)();

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
