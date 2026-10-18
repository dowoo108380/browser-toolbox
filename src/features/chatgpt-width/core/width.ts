// 대화 열·작성란의 최대 너비(GPT-2). 단위는 px이고, 범위와 기본값은 사용자가 정했다(2026-10-18). 설정 스키마(feature.ts)와
// 팝업의 숫자 칸(ui.tsx)이 이 범위를 함께 쓴다(결정 0030). 범위를 나중에 넓히면 설정 형식 버전을 올린다(아키텍처 6장).
export const minWidth = 640;
export const maxWidth = 3840;
export const defaultWidth = 1200;
// 팝업의 숫자 칸에서 ↑↓ 한 번에 바뀌는 양. 이 단위가 아닌 값도 범위 안의 정수면 받는다.
export const widthStep = 10;

// 사용자가 숫자 칸에 쓴 글을 너비로 읽는다. 앞뒤 공백을 뺀 범위 안의 정수(10진 숫자만)를 받고, 아니면 null이다.
export function parseWidth(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const width = Number(trimmed);
  return width >= minWidth && width <= maxWidth ? width : null;
}
