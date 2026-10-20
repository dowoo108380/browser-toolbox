import { definePagePart, startContentWidth } from '../../page/index.ts';
import { contentWidthCss, expectedElements, watchNavigation } from '../../sites/claude/index.ts';
import { claudeWidth } from './feature.ts';

// claude.ai의 대화 열과 작성란의 최대 너비를 정한 값으로 바꾼다(CLD-1, 결정 0040). 너비 규칙을 넣고 화면마다 찾고 확인하는
// 흐름은 너비 기능이 함께 쓰는 page의 startContentWidth이고(결정 0039), claude.ai의 지식(너비 규칙, 화면마다 있어야 할 요소,
// 이동 신호)은 사이트 모듈이 낸다.
export const page = definePagePart(claudeWidth, (settings, start) => {
  startContentWidth(start, {
    name: claudeWidth.id,
    width: settings.width,
    site: { css: contentWidthCss, expectedElements, watchNavigation },
  });
});
