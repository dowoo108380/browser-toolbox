import type { KnipConfig } from 'knip';

// 쓰지 않는 파일, 내보내기, 의존성을 찾는다(quality 034).
const config: KnipConfig = {
  entry: ['src/entries/*.{ts,tsx}', 'scripts/*.ts', 'tests/e2e/**/*.spec.ts'],
  project: ['src/**/*.{ts,tsx}', 'scripts/**/*.ts', 'tests/**/*.ts'],
  // Stryker의 명령 실행기(testRunner: command)는 @stryker-mutator/core 안에 있다. 별도 패키지가 없다.
  ignoreDependencies: ['@stryker-mutator/command-runner'],
};

export default config;
