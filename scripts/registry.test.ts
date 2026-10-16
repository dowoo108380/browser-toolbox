import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod/mini';
import { type FeatureDefinition, defineFeature } from '../src/contracts/index.ts';
import { contentCommonSource, swSource } from './registry.ts';

// 결정 0004: 빌드가 기능 목록에서 진입점별 등록 목록을 만든다. 그 생성 규칙(어느 기능의 어느 자리 파일을 넣는가)을 본다.
// 자리 파일이 있는지는 실제 폴더를 보므로 시험마다 임시 폴더에 기능 폴더를 만든다.

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// 그 기능 폴더에 자리 파일을 둔 임시 저장소.
function rootWith(files: Readonly<Record<string, readonly string[]>>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'registry-'));
  roots.push(root);
  for (const [featureId, names] of Object.entries(files)) {
    const folder = path.join(root, 'src', 'features', featureId);
    mkdirSync(folder, { recursive: true });
    for (const name of names) writeFileSync(path.join(folder, name), '');
  }
  return root;
}

const toggle = (id: string, content: FeatureDefinition['content']): FeatureDefinition =>
  defineFeature({
    id,
    requirements: [],
    name: id,
    description: id,
    category: 'media',
    kind: 'toggle',
    content,
    permissions: [],
    settings: { schema: z.object({ enabled: z.boolean() }), defaults: { enabled: false } },
  });

const action = (id: string): FeatureDefinition =>
  defineFeature({
    id,
    requirements: [],
    name: id,
    description: id,
    category: 'tabs',
    kind: 'action',
    content: null,
    permissions: [],
    task: { timeoutMs: 1000 },
  });

describe('등록 목록의 생성 규칙(결정 0004)', () => {
  it('모든 사이트에 실리는 콘텐츠 스크립트에는 모든 사이트가 대상이고 page.ts가 있는 기능만 넣는다', () => {
    const root = rootWith({
      'media-speed': ['feature.ts', 'page.ts'],
      'no-page': ['feature.ts'],
      'not-on-pages': ['feature.ts', 'page.ts'],
    });
    const source = contentCommonSource(
      [
        toggle('media-speed', { sites: 'all', frames: 'all' }),
        toggle('no-page', { sites: 'all', frames: 'top' }),
        toggle('not-on-pages', null),
      ],
      root,
    );
    expect(source).toContain(
      "import { page as mediaSpeed } from '../../features/media-speed/page.ts';",
    );
    expect(source).toContain('export const pageParts: readonly PagePart[] = [mediaSpeed];');
    expect(source).not.toContain('noPage');
    expect(source).not.toContain('notOnPages');
  });

  it('결정 0024 서비스 워커의 등록 목록에는 실행 기능 가운데 background.ts가 있는 것의 task만 넣는다', () => {
    const root = rootWith({
      'subtitle-export': ['feature.ts', 'background.ts'],
      'tab-url-copy': ['feature.ts'],
      'toggle-with-background': ['feature.ts', 'background.ts'],
    });
    const source = swSource(
      [action('subtitle-export'), action('tab-url-copy'), toggle('toggle-with-background', null)],
      root,
    );
    expect(source).toContain(
      "import { task as subtitleExport } from '../../features/subtitle-export/background.ts';",
    );
    expect(source).toContain('export const taskParts: readonly TaskPart[] = [subtitleExport];');
    expect(source).not.toContain('tabUrlCopy');
    expect(source).not.toContain('toggleWithBackground');
  });

  it('넣을 기능이 없으면 빈 목록을 만든다(타입은 가져온다)', () => {
    const source = swSource([], rootWith({}));
    expect(source).toContain("import type { TaskPart } from '../../background/index.ts';");
    expect(source).toContain('export const taskParts: readonly TaskPart[] = [];');
  });
});
