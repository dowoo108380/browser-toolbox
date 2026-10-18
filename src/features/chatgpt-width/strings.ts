import { maxWidth, minWidth } from './core/width.ts';

// 이 기능의 팝업 문구(결정 0007, 0030). 상태 문구(켜짐, 꺼짐, 쓸 수 없음, 찾지 못함)는 ui/strings에 있다.
const range = `${String(minWidth)}–${String(maxWidth)}`;

export const strings = {
  widthLabel: '최대 너비(px)',
  widthHint: `${range} 사이의 정수. 바꾸면 열린 chatgpt.com 탭에 바로 걸린다.`,
  widthInvalid: `${range} 사이의 정수만 쓸 수 있어 저장하지 않았다. Esc를 누르면 저장된 값으로 돌아간다.`,
};
