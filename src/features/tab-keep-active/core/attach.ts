// 켜진 탭에 디버거를 붙일지(TAB-2 기대 동작 2·3, 결정 0041). 웹 페이지이고 보지 않는 탭이면 붙인다. 보지 않는 탭은 창에 나와
// 있지 않거나(활성 탭도, 활성 탭과 분할 보기로 나란히 놓인 탭도 아님), 창이 최소화되었거나, 창이 가려진 탭이다(가려졌는지는
// 페이지가 숨김이 된 것으로 안다). 보는 탭에는 붙이지 않는다. 초점 흉내가 켜지면 Chrome이 화면 캡처 중처럼 다뤄 전체 화면이
// 탭 안에서만 되고 RTX Video가 꺼지기 때문이다.
export interface TabView {
  readonly web: boolean;
  readonly shown: boolean;
  readonly minimized: boolean;
  readonly covered: boolean;
}

export function wantsDebugger(tab: TabView): boolean {
  return tab.web && (!tab.shown || tab.minimized || tab.covered);
}
