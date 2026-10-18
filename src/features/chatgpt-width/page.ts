import { createPageStyle } from '../../dom/index.ts';
import { definePagePart } from '../../page/index.ts';
import { contentWidthCss, expectedElements, watchNavigation } from '../../sites/chatgpt/index.ts';
import { unappliedIndex } from './core/width.ts';
import { chatgptWidth } from './feature.ts';

// 대화 열과 작성란의 최대 너비를 정한 값으로 바꾼다(GPT-2, 결정 0031, 0032, 0034, 0035). 사이트 모듈이 낸 너비 규칙을 페이지
// 스타일 요소 하나로 넣는다. 사이트가 요소를 다시 그려도(다른 대화, 새 대화) 새 요소에 그대로 걸리므로 찾은 요소를 따라가지
// 않는다. 찾기는 그 화면에 있어야 할 요소가 없어졌는지(사이트가 구조를 바꿨는지), 확인은 찾은 요소에 너비가 실제로 걸렸는지
// (사이트가 너비를 정하는 방법을 바꿨는지) 알아채는 데 쓴다(COM-6). 끄거나 어긋나면 실행 틀이 범위를 닫아 스타일 요소를 지운다.
export const page = definePagePart(
  chatgptWidth,
  (settings, { window, document, scope, find, verify }) => {
    const style = createPageStyle(document, {
      name: 'chatgpt-width',
      css: contentWidthCss(settings.width),
    });
    scope.defer(style.remove);

    // 지금 화면에 있어야 할 요소를 찾고, 모두 찾으면 그 요소들에 정한 너비가 걸렸는지 확인한다. 페이지 안에서 이동하면 앞 화면의
    // 찾기와 확인을 그만두고 새 화면의 것을 한다(15초를 그때부터 센다, COM-6 기대 동작 4). 확인은 15초 뒤 지금 화면의 요소로
    // 하므로, 이동 신호 때 찾은 요소가 곧 숨겨질 앞 화면의 것이어도 새 화면의 것을 잰다(결정 0035).
    const watching: (() => void)[] = [];
    const expectHere = () => {
      for (const stop of watching.splice(0)) stop();
      const expected = expectedElements(window.location);
      let missing = expected.length;
      const onFound = () => {
        missing -= 1;
        if (missing > 0) return;
        watching.push(
          verify(expected, (current) => {
            // 지금 화면의 그 요소들의 그려진 너비. 규칙을 다른 너비로 잠시 바꿔 잴 수 있다(한 작업 안이라 그려지지 않는다).
            const widths = () => current.map((element) => element.getBoundingClientRect().width);
            return unappliedIndex(settings.width, (px) =>
              px === settings.width ? widths() : style.measureWith(contentWidthCss(px), widths),
            );
          }),
        );
      };
      for (const element of expected) watching.push(find(element, onFound));
    };
    expectHere();
    watchNavigation(scope, window, expectHere);
  },
);
