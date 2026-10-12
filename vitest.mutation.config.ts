import { defineConfig } from 'vitest/config';

// 돌연변이 테스트(Stryker)가 쓰는 설정. 핵심 로직은 Node의 단위 테스트로 확인하므로 단위 테스트만 돈다(quality 092).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.dom.test.ts'],
  },
});
