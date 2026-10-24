import { defineConfig } from '@playwright/test';

// 확장 전체 테스트(결정 0003, 아키텍처 11장). 빌드한 dist/를 Playwright의 Chromium에 올려 시험 페이지에서 확인한다.
// 브라우저는 테스트마다 따로 띄우므로 이 설정에는 브라우저 종류를 적지 않는다(tests/e2e/support/).
// 성능 측정(tests/measure/)은 시각이 흔들리므로 pnpm verify에 넣지 않고 pnpm measure로 따로 돈다(quality 079, 110).

export default defineConfig({
  outputDir: 'test-results',
  // 시험 도우미 곁의 .test.ts는 Vitest가 돈다(vitest.config.ts).
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  forbidOnly: process.env['CI'] !== undefined,
  retries: 0,
  reporter: process.env['CI'] === undefined ? 'list' : [['list'], ['html', { open: 'never' }]],
  projects: [
    { name: 'e2e', testDir: 'tests/e2e' },
    { name: 'measure', testDir: 'tests/measure', timeout: 600_000 },
  ],
  webServer: {
    command: 'node tests/server.ts',
    url: 'http://127.0.0.1:4173/video.html',
    reuseExistingServer: process.env['CI'] === undefined,
  },
});
