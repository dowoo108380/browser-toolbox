import type { KnipConfig } from 'knip';

// 쓰지 않는 파일, 내보내기, 의존성을 찾는다(quality 034).
const config: KnipConfig = {
  // tests/contract/run-*.ts는 확장 전체 시험이 esbuild로 묶어 확장 안에서 실행하므로 가져오는 곳이 없다.
  // tests/extension/task-parts.ts는 시험 빌드의 플러그인이 진입점의 등록 목록 대신 넣는다(결정 0025).
  entry: [
    'src/entries/*.{ts,tsx}',
    'scripts/*.ts',
    'tests/{e2e,measure}/**/*.spec.ts',
    'tests/contract/run-*.ts',
    'tests/extension/task-parts.ts',
  ],
  project: ['src/**/*.{ts,tsx}', 'scripts/**/*.ts', 'tests/**/*.{ts,tsx}'],
  // Stryker의 명령 실행기(testRunner: command)는 @stryker-mutator/core 안에 있다. 별도 패키지가 없다.
  ignoreDependencies: ['@stryker-mutator/command-runner'],
};

export default config;
