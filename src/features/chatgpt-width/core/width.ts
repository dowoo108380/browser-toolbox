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

// 그 선택자의 요소마다 담는 상자를 채우되 width를 넘지 않는 가운데 놓인 열로 만드는 스타일 규칙(결정 0031). 상자의 바깥
// 너비가 곧 그 값이고(border-box), 담는 상자보다 넓어지지 않으므로 창이 좁으면 창에 맞추고 가로 스크롤을 만들지 않는다
// (GPT-2 기대 동작 3). 너비를 채우라고 함께 적는 것은 부모가 세로 flex이면 가운데 여백(auto)이 늘이기를 막아 열이 내용
// 너비로 줄기 때문이다(시험에서 봄). 사이트의 규칙을 이기도록 !important를 단다.
export function columnCss(selectors: readonly string[], width: number): string {
  return selectors
    .map(
      (selector) =>
        `${selector} { box-sizing: border-box !important; width: 100% !important; max-width: ${String(width)}px !important; margin-inline: auto !important; }`,
    )
    .join('\n');
}
