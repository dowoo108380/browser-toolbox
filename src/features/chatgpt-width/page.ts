import { createPageStyle } from '../../dom/index.ts';
import { definePagePart } from '../../page/index.ts';
import { contentWidthCss, expectedElements, watchNavigation } from '../../sites/chatgpt/index.ts';
import { chatgptWidth } from './feature.ts';

// 대화 열과 작성란의 최대 너비를 정한 값으로 바꾼다(GPT-2, 결정 0031, 0032). 사이트 모듈이 낸 너비 규칙을 페이지 스타일 요소
// 하나로 넣는다. 사이트가 요소를 다시 그려도(다른 대화, 새 대화) 새 요소에 그대로 걸리므로 찾은 요소를 따라가지 않는다.
// 찾기는 그 화면에 있어야 할 요소가 없어졌는지(사이트가 구조를 바꿨는지) 알아채는 데만 쓴다(COM-6). 끄거나 찾지 못하면
// 실행 틀이 범위를 닫아 스타일 요소를 지운다.
export const page = definePagePart(chatgptWidth, (settings, { window, document, scope, find }) => {
  const style = createPageStyle(document, {
    name: 'chatgpt-width',
    css: contentWidthCss(settings.width),
  });
  scope.defer(style.remove);

  // 지금 화면에 있어야 할 요소를 찾는다. 페이지 안에서 이동하면 앞 화면의 찾기를 그만두고 새 화면의 것을 찾는다(15초를
  // 그때부터 센다, COM-6 기대 동작 4). 찾으면 할 일은 없다. 스타일은 이미 걸려 있다.
  let searches: readonly (() => void)[] = [];
  const expectHere = () => {
    for (const stop of searches) stop();
    searches = expectedElements(window.location).map((element) => find(element, () => undefined));
  };
  expectHere();
  watchNavigation(scope, window, expectHere);
});
