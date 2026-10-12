// 배속을 소수점 둘째 자리까지 보인다(MED-1 기대 동작 1). 뒤의 0은 쓰지 않는다.
export function formatRate(rate: number): string {
  return `${String(Number(rate.toFixed(2)))}×`;
}
