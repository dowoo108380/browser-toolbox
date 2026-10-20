import { visibilityNoticeEventName } from '../../dom/index.ts';
import { armEventName, parseArm } from './core/shield.ts';

// 페이지 활성 상태 유지의 페이지 쪽 방패(TAB-2 기대 동작 4, 결정 0041). 페이지의 세계(MAIN)에서 모든 http·https 프레임에
// document_start로 실려 페이지의 첫 스크립트보다 먼저 돈다(R-03). 처음에는 아무것도 바꾸지 않는다(통과 상태). 격리된 쪽이 이
// 탭에서 켜졌다고 알리면(armEventName) 켜진 동안:
// - 페이지가 초점을 물으면(document.hasFocus) 있다고 답하고, 보임 상태(document.visibilityState, hidden)를 보임으로 답한다.
// - 창의 초점이 바뀌었다는 신호(창에 온 신뢰된 blur와 focus)와 보임이 바뀌었다는 신호(신뢰된 visibilitychange)를 페이지에 전하지
//   않는다.
//   창의 캡처 단계에서 가장 먼저 걸어 둔 듣기가 막으므로 페이지가 나중에 건 듣기(창과 문서, 속성 처리기 포함)에 닿지 않는다.
//   DOM 이벤트는 세계를 가리지 않아 확장의 격리된 쪽 듣기에도 닿지 않으므로, 막은 보임 바뀜은 보임 알림으로 다시 보낸다(결정
//   0044). 창의 blur·focus를 듣는 확장 코드는 없다(린터가 지킨다).
// 입력란 같은 요소의 초점 이벤트는 그대로 둔다. iframe에서는 창이 초점을 잃은 것과 문서 안에서 초점을 옮긴 것을 가를 수 없어,
// 막으면 폼의 검증 같은 페이지 동작이 깨질 수 있다(2026-10-21 실험).
// 켜고 끌 때 페이지가 마지막으로 본 상태와 지금 답이 다르면 그 이벤트를 한 번 보내(신뢰되지 않은 것) 페이지가 다시 읽게 한다.
// prototype은 그 창의 Document.prototype이다(시험이 다른 창의 것을 넣는다).
// 이 세계에는 확장 API가 없어 연결을 확인할 수 없다. 물러남 이벤트(새 판이 보냄)를 받으면 확인 없이 끈다(결정 0008). 웹 페이지가
// 흉내 내도 그 페이지에서 방패가 꺼질 뿐이다. 이 문서가 사는 동안의 일이라 실행 틀의 자원 범위 없이 듣는다.
export function installShield(window: Window, prototype: object, retireEventName: string): void {
  const { document } = window;
  const focusDescriptor = Object.getOwnPropertyDescriptor(prototype, 'hasFocus');
  const visibilityDescriptor = Object.getOwnPropertyDescriptor(prototype, 'visibilityState');
  const hiddenDescriptor = Object.getOwnPropertyDescriptor(prototype, 'hidden');
  const nativeHasFocus: unknown = focusDescriptor?.value;
  // 접근자를 떼어 내 문서에 다시 부른다(Reflect.apply). 떼어 낸 메서드를 그대로 부르지 않는다.
  const nativeVisibility: unknown =
    visibilityDescriptor === undefined ? undefined : Reflect.get(visibilityDescriptor, 'get');
  if (
    focusDescriptor === undefined ||
    visibilityDescriptor === undefined ||
    hiddenDescriptor === undefined ||
    typeof nativeHasFocus !== 'function' ||
    typeof nativeVisibility !== 'function'
  ) {
    return;
  }
  const nativeVisible = () => Reflect.apply(nativeVisibility, document, []) === 'visible';
  const nativeFocused = () => Reflect.apply(nativeHasFocus, document, []) === true;

  let armed = false;
  // 페이지가 마지막으로 본 보임과 초점. 켜지 않은 동안은 실제 이벤트에서 받는다.
  let shown = { visible: nativeVisible(), focused: nativeFocused() };

  // 켜진 동안 바꿔 끼우는 것(원래와 같은 이름의 함수와 접근자)과 원래의 것.
  const replacements = {
    hasFocus: {
      ...focusDescriptor,
      value: function hasFocus() {
        return true;
      },
    },
    visibilityState: {
      ...visibilityDescriptor,
      get: function visibilityState() {
        return 'visible';
      },
    },
    hidden: {
      ...hiddenDescriptor,
      get: function hidden() {
        return false;
      },
    },
  };
  const originals = {
    hasFocus: focusDescriptor,
    visibilityState: visibilityDescriptor,
    hidden: hiddenDescriptor,
  };

  // 페이지가 지금 읽는 값과 마지막으로 본 값이 다르면 그 이벤트를 보낸다.
  const catchUp = () => {
    const visible = armed || nativeVisible();
    const focused = armed || nativeFocused();
    if (visible !== shown.visible) {
      shown = { ...shown, visible };
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    }
    if (focused !== shown.focused) {
      shown = { ...shown, focused };
      window.dispatchEvent(new FocusEvent(focused ? 'focus' : 'blur'));
    }
  };

  const arm = (on: boolean) => {
    if (on === armed) return;
    armed = on;
    for (const name of ['hasFocus', 'visibilityState', 'hidden'] as const) {
      if (on) {
        Object.defineProperty(prototype, name, replacements[name]);
        continue;
      }
      // 켜진 동안 페이지가 다시 바꿔 끼웠으면 그대로 둔다.
      const current = Object.getOwnPropertyDescriptor(prototype, name);
      const replacement: PropertyDescriptor = replacements[name];
      if (current?.value === replacement.value && current?.get === replacement.get) {
        Object.defineProperty(prototype, name, originals[name]);
      }
    }
    catchUp();
  };

  window.addEventListener(
    'blur',
    (event) => {
      if (!event.isTrusted || event.target !== window) return;
      if (armed) event.stopImmediatePropagation();
      else shown = { ...shown, focused: false };
    },
    true,
  );
  // 켜진 동안 페이지는 초점을 잃은 적이 없으므로 창이 다시 초점을 얻었다는 신호(창에 온 신뢰된 focus)도 전하지 않는다.
  window.addEventListener(
    'focus',
    (event) => {
      if (!event.isTrusted || event.target !== window) return;
      if (armed) event.stopImmediatePropagation();
      else shown = { ...shown, focused: true };
    },
    true,
  );
  window.addEventListener(
    'visibilitychange',
    (event) => {
      if (!event.isTrusted) return;
      if (!armed) {
        shown = { ...shown, visible: nativeVisible() };
        return;
      }
      event.stopImmediatePropagation();
      // 페이지에는 숨기고 확장에는 알린다. 격리된 쪽은 실제 보임을 자기 세계에서 읽는다(최상위 문서의 실제 숨김은 이 기능이 가려진
      // 창을 아는 길이기도 하다, page.ts).
      document.dispatchEvent(new Event(visibilityNoticeEventName, { bubbles: true }));
    },
    true,
  );
  document.addEventListener(armEventName, (event) => {
    const on = event instanceof CustomEvent ? parseArm(event.detail) : null;
    if (on !== null) arm(on);
  });
  document.addEventListener(retireEventName, () => {
    arm(false);
  });
}
