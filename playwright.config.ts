import { defineConfig } from '@playwright/test';

// 확장 전체 테스트(결정 0003, 아키텍처 11장). 빌드한 dist/를 Playwright의 Chromium에 올려 시험 페이지에서 확인한다.
// 브라우저는 테스트마다 따로 띄우므로 이 설정에는 브라우저 종류를 적지 않는다(tests/e2e/support/).

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  timeout: 30_000,
  forbidOnly: process.env['CI'] !== undefined,
  retries: 0,
  reporter: process.env['CI'] === undefined ? 'list' : [['list'], ['html', { open: 'never' }]],
  webServer: {
    command: 'node tests/server.ts',
    url: 'http://127.0.0.1:4173/video.html',
    reuseExistingServer: process.env['CI'] === undefined,
  },
});
