import { definePagePart, startContentWidth } from '../../page/index.ts';
import { contentWidthCss, expectedElements, watchNavigation } from '../../sites/chatgpt/index.ts';
import { chatgptWidth } from './feature.ts';

// 대화 열과 작성란의 최대 너비를 정한 값으로 바꾼다(GPT-2, 결정 0031, 0032, 0034, 0035). 너비 규칙을 넣고 화면마다 찾고
// 확인하는 흐름은 너비 기능이 함께 쓰는 page의 startContentWidth이고(결정 0039), chatgpt.com의 지식(너비 규칙, 화면마다 있어야
// 할 요소, 이동 신호)은 사이트 모듈이 낸다.
export const page = definePagePart(chatgptWidth, (settings, start) => {
  startContentWidth(start, {
    name: chatgptWidth.id,
    width: settings.width,
    site: { css: contentWidthCss, expectedElements, watchNavigation },
  });
});
