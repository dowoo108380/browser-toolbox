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

// 그려진 너비가 정한 값과 같다고 보는 차이(px). 그려진 너비는 소수일 수 있다.
const widthTolerance = 1;

// 너비 규칙이 요소들에 작용하는지 보고, 작용하지 않는 첫 요소의 자리를 돌려준다. 모두 작용하면 null이다(결정 0034).
// measure(px)는 규칙을 그 너비로 걸었을 때 요소마다의 그려진 너비다(요소는 지금 화면의 것이다, 결정 0035).
// - 정한 너비(width)로 잰 너비가 그 값(1px 안)이면 작용하고, 넘으면 작용하지 않는다.
// - 모자라면 담는 상자가 좁거나(창이 좁음) 규칙이 듣지 않는 것이다. 모자란 요소들 가운데 가장 좁은 것의 절반으로 한 번 더 재어,
//   줄어들면 규칙이 그 너비를 정하는 것이라 작용한다고 본다. 다시 재기는 배치를 한 번 더 계산하게 하므로 모자란 요소가 있을
//   때만 한다(넓은 창에서는 한 번만 잰다).
export function unappliedIndex(
  width: number,
  measure: (px: number) => readonly number[],
): number | null {
  const measured = measure(width);
  const short = (value: number) => value < width - widthTolerance;
  const narrow = measured.filter(short);
  const probed = narrow.length === 0 ? measured : measure(Math.floor(Math.min(...narrow) / 2));
  const index = measured.findIndex((value, at) => {
    if (!short(value)) return value > width + widthTolerance;
    // 다시 잰 너비가 1px 넘게 줄지 않았으면 규칙이 그 요소의 너비를 정하지 않는다.
    const after = probed[at] ?? value;
    return after >= value - widthTolerance;
  });
  return index === -1 ? null : index;
}
