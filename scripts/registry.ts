import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { format, resolveConfig } from 'prettier';
import {
  type FeatureDefinition,
  type PageBundle,
  pageBundles,
  sites,
} from '../src/contracts/index.ts';

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

// 콘텐츠 스크립트 묶음(결정 0029). 공통 묶음(content-common)은 늘 있고, 사이트 묶음(content-<사이트>)은 그 사이트 전용
// 기능이 있을 때만 있다.
export function contentBundles(features: readonly FeatureDefinition[]): readonly PageBundle[] {
  return [
    'common',
    ...sites.filter((site) => features.some((feature) => feature.content?.sites === site)),
  ];
}

// 그 기능의 페이지 쪽 일이 그 묶음에 드는지. 모든 사이트가 대상인 기능은 모든 묶음에, 사이트 전용 기능은 그 사이트의
// 묶음에만 든다.
function inBundle(feature: FeatureDefinition, bundle: PageBundle): boolean {
  const target = feature.content?.sites;
  return target === 'all' || (bundle !== 'common' && target === bundle);
}

// 그 묶음이 시작할 기능의 페이지 쪽 일. 그 묶음이 아는 기능 정의도 이것뿐이다(FeaturePagePart.feature, 결정 0027).
export function contentSource(
  features: readonly FeatureDefinition[],
  root: string,
  bundle: PageBundle,
): string {
  const parts = features.filter(
    (feature) =>
      inBundle(feature, bundle) &&
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

// 팝업이 기능 항목에 붙여 그릴 화면 조각(결정 0030). 켜고 끄기 기능 가운데 ui.tsx가 있는 것의 ui다.
export function popupSource(features: readonly FeatureDefinition[], root: string): string {
  const parts = features.filter(
    (feature) =>
      feature.kind === 'toggle' &&
      existsSync(path.join(root, 'src', 'features', feature.id, 'ui.tsx')),
  );
  const lines = [
    ...header,
    "import type { FeatureUiPart } from '../../ui/index.ts';",
    ...parts.map(
      (feature) =>
        `import { ui as ${camelCase(feature.id)} } from '../../features/${feature.id}/ui.tsx';`,
    ),
    '',
    `export const uiParts: readonly FeatureUiPart[] = [${parts.map((feature) => camelCase(feature.id)).join(', ')}];`,
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
  // 만들 파일과 그 내용. null이면 없어야 하는 파일이다(그 사이트 전용 기능을 모두 지운 사이트 묶음).
  const bundles = contentBundles(features);
  const files = new Map<string, string | null>([
    ...pageBundles.map((bundle): [string, string | null] => [
      path.join(generatedDirectory, `content-${bundle}.ts`),
      bundles.includes(bundle) ? contentSource(features, root, bundle) : null,
    ]),
    [path.join(generatedDirectory, 'sw.ts'), swSource(features, root)],
    [path.join(generatedDirectory, 'popup.ts'), popupSource(features, root)],
  ]);
  const stale: string[] = [];
  for (const [file, source] of files) {
    const target = path.join(root, file);
    if (source === null) {
      if (!existsSync(target)) continue;
      stale.push(file);
      if (write) rmSync(target);
      continue;
    }
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
