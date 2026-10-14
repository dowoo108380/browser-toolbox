import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// 단위 테스트는 Node에서, DOM 테스트는 실제 Chromium에서 돈다(결정 0003).
// 브라우저는 저장소 안(node_modules)에 받은 Playwright의 Chromium이다. 그래서 headless에서도
// 별도의 headless shell이 아니라 같은 Chromium을 쓴다(channel: 'chromium').

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'tests/lint/**/*.test.ts'],
          exclude: ['src/**/*.dom.test.{ts,tsx}'],
        },
      },
      {
        test: {
          name: 'dom',
          // tests/integration은 실제 모듈끼리 연결한 시험이다. 가짜는 Chrome 경계(저장소, 메시지 통로)뿐이다.
          include: ['src/**/*.dom.test.{ts,tsx}', 'tests/integration/**/*.dom.test.{ts,tsx}'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({ launchOptions: { channel: 'chromium' } }),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
    coverage: {
      provider: 'v8',
      // 핵심 로직(quality 015, 102): 설정 해석과 형식 이전, 기능의 core/, 상태 기계(quality 062).
      include: ['src/storage/**/*.ts', 'src/features/*/core/**/*.ts', 'src/page/lifecycle.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
      thresholds: { lines: 90 },
    },
  },
});
