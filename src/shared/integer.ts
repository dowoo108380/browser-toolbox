// 사용자가 쓴 글을 min–max의 정수로 읽는다. 앞뒤 공백을 뺀 10진 숫자만 받고(부호, 소수점, 지수, 전각 숫자는 받지 않는다),
// 범위 밖이면 null이다. 기능이 팝업의 숫자 칸에 쓴 글을 설정 값으로 바꿀 때 쓴다(GPT-2, CLD-1의 너비, 결정 0039).
export function parseInteger(text: string, min: number, max: number): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= min && value <= max ? value : null;
}
