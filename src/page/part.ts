import type {
  ContentTarget,
  PageToggleFeature,
  ToggleFeature,
  ToggleSettings,
} from '../contracts/index.ts';
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
  // 기대는 외부 화면 요소를 지금 화면에서 찾는다(COM-6, 결정 0026, 0035). 있거나 생기면 onFound를 부른다. 앞 화면이 숨긴 채
  // 남긴 것은 찾은 것이 아니다. 늘 있는 요소는 시작할 때, 조작해야 생기는 요소는 그 조작을 받았을 때 부른다. 부른 때부터 탭이
  // 보인 시간이 15초가 되도록 찾지 못하면 실행 틀이 이 기능을 멈추고(scope에 맡긴 것을 모두 되돌림) 문제를 기록하며, 그 요소가
  // 나타나거나 페이지 안에서 이동하면 다시 시작한다(그 화면에 있어야 할 것을 기능이 다시 정한다, 결정 0033). 돌려준 함수는 이
  // 찾기만 그만둔다.
  readonly find: (
    element: NamedElement,
    onFound: (found: Element) => void | Promise<void>,
  ) => () => void;
  // 기능이 찾은 요소들에 건 변경이 실제로 작용하는지 본다(COM-6, 결정 0034, 0035). 부른 때부터 탭이 보인 시간이 15초가 될 때
  // 한 번, 지금 화면의 그 요소들(elements와 같은 차례)로 check를 부른다. check는 변경이 작용하지 않는 첫 요소의 차례를,
  // 모두 작용하면 null을 돌려준다. 그때 지금 화면에 없는 요소가 있으면 check를 부르지 않고 찾지 못함, check가 차례를 내면 적용되지
  // 않음이다. 어느 쪽이든 실행 틀이 이 기능을 멈추고(scope에 맡긴 것을 모두 되돌림) 그 요소와 함께 기록하며, 팝업에 그 까닭과
  // 요소 이름이 보인다. 설정이 바뀌거나 페이지 안에서 이동하면 다시 시작한다. check는 그려진 크기처럼 문서의 배치를 계산하게
  // 하는 것을 읽어도 된다. 돌려준 함수는 이 확인만 그만둔다.
  readonly verify: (
    elements: readonly NamedElement[],
    check: (current: readonly Element[]) => number | null,
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

// 기능 정의로 만든 페이지 쪽 일. 콘텐츠 스크립트 묶음은 기능 목록을 싣지 않고, 그 묶음에 든 이 정의들의 설정만 읽기
// 도우미에 넘긴다. 그래서 페이지에 작용하지 않는 기능이 늘어도 모든 페이지에 실리는 비용(정의를 싣고 스키마를 만들고
// 항목을 검증하는 일)은 늘지 않는다. 다른 기능의 항목은 모르는 기능의 것처럼 보지 않는다(결정 0027, 0011 읽는 쪽 계약 4).
export interface FeaturePagePart extends PagePart {
  readonly feature: ToggleFeature;
}

export function definePagePart<S extends ToggleSettings>(
  definition: PageToggleFeature<S>,
  start: (settings: S, context: PageStart) => void,
): FeaturePagePart {
  return {
    featureId: definition.id,
    frames: definition.content.frames,
    feature: definition,
    start: (snapshot, context) => {
      const settings = settingsOf(snapshot, definition);
      if (settings.enabled) start(settings, context);
    },
  };
}
