// 성능 예산 가운데 빌드와 패키징이 지키는 크기 예산(quality 079, 111). 값의 근거는 05단계 측정(N-10)이다.
// 시간 예산(기능이 모두 꺼진 페이지의 주 스레드 시간, 팝업이 뜨는 시간)은 pnpm measure로 잰다.

// 웹 페이지에 실리는 스크립트 묶음 하나의 크기(압축하지 않은 바이트). 05단계 뼈대: 68,526바이트.
export const pageScriptBudgetBytes = 200_000;

// 배포 ZIP의 크기(바이트). 05단계 뼈대: 53,979바이트.
export const packageBudgetBytes = 1_000_000;

// 기능이 모두 꺼진 페이지(프레임 하나)에서 확장이 더 쓰는 주 스레드 시간(ms, 확장이 없을 때와의 차이).
// 이 PC와 Playwright의 Chromium(headless)에서 15번의 중앙값이다. 05단계 뼈대: 스크립트 2.3, 작업 5.5(설정 크기와 거의 무관).
export const pageScriptTimeBudgetMs = 5;
export const pageTaskTimeBudgetMs = 10;

// 팝업을 연 뒤 조작할 수 있게 되기까지(ms, quality 002). 05단계 뼈대: 30(탭으로 연 팝업 문서).
export const popupReadyBudgetMs = 300;
