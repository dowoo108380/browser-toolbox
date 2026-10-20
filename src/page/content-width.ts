import { type NamedElement, type Scope, createPageStyle } from '../dom/index.ts';
import { unappliedIndex } from '../shared/index.ts';
import type { PageStart } from './part.ts';

// 외부 사이트의 요소(대화 열, 작성란)의 최대 너비를 정한 값으로 바꾸는 기능이 함께 쓰는 페이지 쪽 흐름(GPT-2, CLD-1, 결정
// 0031, 0034, 0035, 0039). 사이트 모듈이 낸 너비 규칙을 페이지 스타일 요소 하나로 넣는다. 사이트가 요소를 다시 그려도(다른
// 대화, 새 대화) 새 요소에 그대로 걸리므로 찾은 요소를 따라가지 않는다. 찾기는 그 화면에 있어야 할 요소가 없어졌는지(사이트가
// 구조를 바꿨는지), 확인은 찾은 요소에 너비가 실제로 걸렸는지(사이트가 너비를 정하는 방법을 바꿨는지) 알아채는 데 쓴다(COM-6).
// 끄거나 어긋나면 실행 틀이 범위를 닫아 스타일 요소를 지운다. 사이트의 지식은 모두 site로 받고, 여기에는 사이트마다의 분기가
// 없다.

// 사이트 모듈(sites/<사이트>/)이 내는 너비의 지식. 기능이 모아 넘긴다.
interface ContentWidthSite {
  // 요소들의 최대 너비를 width(px)로 바꾸는 스타일 규칙. 담는 상자가 그보다 좁으면 상자에 맞춘다(가로 스크롤 없음).
  readonly css: (width: number) => string;
  // 그 화면에 늘 있어야 하는 요소. 너비가 걸려야 하는 요소이기도 해서, 확인은 이 요소들의 그려진 너비로 한다. 있어야 할지
  // 모르는 화면에서는 비어 있다(찾지도 확인하지도 않는다).
  readonly expectedElements: (location: Pick<Location, 'pathname'>) => readonly NamedElement[];
  // 페이지 안 이동(주소가 바뀜)을 scope 안에서 알린다.
  readonly watchNavigation: (scope: Scope, window: Window, onNavigate: () => void) => void;
}

interface ContentWidth {
  // 스타일 요소의 표식 이름(기능 id, 결정 0008).
  readonly name: string;
  readonly width: number;
  readonly site: ContentWidthSite;
}

export function startContentWidth(
  { window, document, scope, find, verify }: PageStart,
  { name, width, site }: ContentWidth,
): void {
  const style = createPageStyle(document, { name, css: site.css(width) });
  scope.defer(style.remove);

  // 지금 화면에 있어야 할 요소를 찾고, 모두 찾으면 그 요소들에 정한 너비가 걸렸는지 확인한다. 페이지 안에서 이동하면 앞 화면의
  // 찾기와 확인을 그만두고 새 화면의 것을 한다(15초를 그때부터 센다, COM-6 기대 동작 4). 확인은 15초 뒤 지금 화면의 요소로
  // 하므로, 이동 신호 때 찾은 요소가 곧 숨겨질 앞 화면의 것이어도 새 화면의 것을 잰다(결정 0035).
  const watching: (() => void)[] = [];
  const expectHere = () => {
    for (const stop of watching.splice(0)) stop();
    const expected = site.expectedElements(window.location);
    let missing = expected.length;
    const onFound = () => {
      missing -= 1;
      if (missing > 0) return;
      watching.push(
        verify(expected, (current) => {
          // 지금 화면의 그 요소들의 그려진 너비. 규칙을 다른 너비로 잠시 바꿔 잴 수 있다(한 작업 안이라 그려지지 않는다).
          const widths = () => current.map((element) => element.getBoundingClientRect().width);
          return unappliedIndex(width, (px) =>
            px === width ? widths() : style.measureWith(site.css(px), widths),
          );
        }),
      );
    };
    for (const element of expected) watching.push(find(element, onFound));
  };
  expectHere();
  site.watchNavigation(scope, window, expectHere);
}
