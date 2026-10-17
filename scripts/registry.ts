import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { format, resolveConfig } from 'prettier';
import type { FeatureDefinition } from '../src/contracts/index.ts';

// 기능 목록에서 진입점별 등록 목록(src/entries/generated/)을 만든다(결정 0004).
// 자리 파일(page.ts 등)을 가져오는 곳은 기능 목록과 이 등록 목록뿐이다.

const generatedDirectory = path.join('src', 'entries', 'generated');

export function camelCase(id: string): string {
  return id.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

const header = [
  '// 이 파일은 scripts/generate.ts가 기능 목록(src/features/list.ts)에서 만든다. 손으로 고치지 않는다.',
  '// 기능을 더하거나 뺀 뒤 `pnpm generate`를 실행한다.',
];

// 모든 사이트에 실리는 콘텐츠 스크립트(content-common)가 시작할 기능의 페이지 쪽 일. 그 묶음이 아는 기능 정의도 이것뿐이다
// (FeaturePagePart.feature, 결정 0027).
export function contentCommonSource(features: readonly FeatureDefinition[], root: string): string {
  const parts = features.filter(
    (feature) =>
      feature.content?.sites === 'all' &&
      existsSync(path.join(root, 'src', 'features', feature.id, 'page.ts')),
  );
  const lines = [
    ...header,
    "import type { FeaturePagePart } from '../../page/index.ts';",
    ...parts.map(
      (feature) =>
        `import { page as ${camelCase(feature.id)} } from '../../features/${feature.id}/page.ts';`,
    ),
    '',
    `export const pageParts: readonly FeaturePagePart[] = [${parts.map((feature) => camelCase(feature.id)).join(', ')}];`,
    '',
  ];
  return lines.join('\n');
}

// 서비스 워커가 실행 기능의 작업에 쓸 일(결정 0024). 실행 기능의 background.ts가 내놓는 task다.
// 실행 기능마다 일이 꼭 하나 있는지는 서비스 워커가 시작할 때 본다(src/background/tasks.ts).
export function swSource(features: readonly FeatureDefinition[], root: string): string {
  const parts = features.filter(
    (feature) =>
      feature.kind === 'action' &&
      existsSync(path.join(root, 'src', 'features', feature.id, 'background.ts')),
  );
  const lines = [
    ...header,
    "import type { TaskPart } from '../../background/index.ts';",
    ...parts.map(
      (feature) =>
        `import { task as ${camelCase(feature.id)} } from '../../features/${feature.id}/background.ts';`,
    ),
    '',
    `export const taskParts: readonly TaskPart[] = [${parts.map((feature) => camelCase(feature.id)).join(', ')}];`,
    '',
  ];
  return lines.join('\n');
}

// 등록 목록을 기능 목록에 맞춘다. write가 거짓이면 쓰지 않고 맞지 않는 파일만 돌려준다.
// 서식 검사와 어긋나지 않도록 Prettier로 정리한 결과를 쓴다.
export async function syncGenerated(
  features: readonly FeatureDefinition[],
  root: string,
  write: boolean,
): Promise<string[]> {
  const files = new Map([
    [path.join(generatedDirectory, 'content-common.ts'), contentCommonSource(features, root)],
    [path.join(generatedDirectory, 'sw.ts'), swSource(features, root)],
  ]);
  const stale: string[] = [];
  for (const [file, source] of files) {
    const target = path.join(root, file);
    const formatted = await format(source, {
      ...(await resolveConfig(target)),
      filepath: target,
    });
    const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
    if (current === formatted) continue;
    stale.push(file);
    if (write) {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, formatted);
    }
  }
  return stale;
}
