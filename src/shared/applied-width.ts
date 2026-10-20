// 요소의 최대 너비를 정한 값으로 바꾸는 규칙이 실제로 작용하는지의 판단(결정 0034). 너비 기능이 함께 쓰는 확인
// (page의 startContentWidth, 결정 0039)이 부른다.

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
