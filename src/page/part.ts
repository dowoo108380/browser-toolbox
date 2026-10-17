import type { ContentTarget, PageToggleFeature, ToggleSettings } from '../contracts/index.ts';
import type { NamedElement, Scope } from '../dom/index.ts';
import { type Snapshot, settingsOf } from '../storage/index.ts';

// 기능의 페이지 쪽 일(features/<기능>/page.ts)이 실행 틀에 내놓는 모양(결정 0014).

export interface PageContext {
  readonly window: Window;
  readonly document: Document;
}

// 시작 함수가 받는 것. scope는 이번 시작에만 쓰는 자원 범위다.
export interface PageStart extends PageContext {
  readonly scope: Scope;
  // 기대는 외부 화면 요소를 찾는다(COM-6, 결정 0026). 있거나 생기면 onFound를 부른다. 늘 있는 요소는 시작할 때, 조작해야
  // 생기는 요소는 그 조작을 받았을 때 부른다. 부른 때부터 탭이 보인 시간이 15초가 되도록 찾지 못하면 실행 틀이 이 기능을
  // 멈추고(scope에 맡긴 것을 모두 되돌림) 문제를 기록하며, 그 요소가 나타나면 다시 시작한다. 돌려준 함수는 이 찾기만 그만둔다.
  readonly find: (
    element: NamedElement,
    onFound: (found: Element) => void | Promise<void>,
  ) => () => void;
}

export interface PagePart {
  readonly featureId: string;
  // 이 기능이 작용하는 프레임(기능 정의의 content.frames). 'top'이면 실행 틀은 탭의 최상위 프레임에서만 시작한다.
  readonly frames: ContentTarget['frames'];
  // 이 기능의 설정이 켜짐이면 시작한다. 꺼짐이면 아무것도 하지 않는다.
  // 기능이 페이지에 더한 화면 요소, 이벤트 처리, 타이머, 관찰은 모두 만든 즉시 scope에 맡긴다.
  // 실행 틀이 scope를 닫으면 모두 사라진다(COM-1.3). 시작 도중에 예외를 던져도 그때까지 맡긴 것은 치운다.
  readonly start: (snapshot: Snapshot, context: PageStart) => void;
}

export function definePagePart<S extends ToggleSettings>(
  definition: PageToggleFeature<S>,
  start: (settings: S, context: PageStart) => void,
): PagePart {
  return {
    featureId: definition.id,
    frames: definition.content.frames,
    start: (snapshot, context) => {
      const settings = settingsOf(snapshot, definition);
      if (settings.enabled) start(settings, context);
    },
  };
}
