import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type FeatureDefinition, defineFeature, v } from '../src/contracts/index.ts';
import {
  assertUniqueFeatureIds,
  contentBundles,
  contentSource,
  popupSource,
  swSource,
  syncGenerated,
} from './registry.ts';

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
    settings: { schema: v.object({ enabled: v.boolean() }), defaults: { enabled: false } },
  });

const tabToggle = (id: string): FeatureDefinition =>
  defineFeature({
    id,
    requirements: [],
    name: id,
    description: id,
    category: 'tabs',
    kind: 'tab-toggle',
    content: { sites: 'all', frames: 'all' },
    permissions: [],
    settings: { schema: v.object({ enabled: v.boolean() }), defaults: { enabled: false } },
    notices: {},
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
    actions: [{ id: 'run', name: id }],
  });

describe('등록 목록의 생성 규칙(결정 0004)', () => {
  it('모든 사이트에 실리는 콘텐츠 스크립트에는 모든 사이트가 대상이고 page.ts가 있는 기능만 넣는다', () => {
    const root = rootWith({
      'media-speed': ['feature.ts', 'page.ts'],
      'no-page': ['feature.ts'],
      'not-on-pages': ['feature.ts', 'page.ts'],
    });
    const source = contentSource(
      [
        toggle('media-speed', { sites: 'all', frames: 'all' }),
        toggle('no-page', { sites: 'all', frames: 'top' }),
        toggle('not-on-pages', null),
      ],
      root,
      'common',
    );
    expect(source).toContain(
      "import { page as mediaSpeed } from '../../features/media-speed/page.ts';",
    );
    expect(source).toContain('export const pageParts: readonly FeaturePagePart[] = [mediaSpeed];');
    expect(source).not.toContain('noPage');
    expect(source).not.toContain('notOnPages');
  });

  it('결정 0029 사이트 묶음에는 모든 사이트의 기능과 그 사이트 전용 기능을 넣고, 공통 묶음에는 사이트 전용 기능을 넣지 않는다', () => {
    const root = rootWith({
      'media-speed': ['feature.ts', 'page.ts'],
      'chatgpt-width': ['feature.ts', 'page.ts'],
    });
    const features = [
      toggle('media-speed', { sites: 'all', frames: 'all' }),
      toggle('chatgpt-width', { sites: 'chatgpt', frames: 'top' }),
    ];
    expect(contentBundles(features)).toEqual(['common', 'chatgpt']);
    expect(contentSource(features, root, 'chatgpt')).toContain(
      'export const pageParts: readonly FeaturePagePart[] = [mediaSpeed, chatgptWidth];',
    );
    expect(contentSource(features, root, 'common')).toContain(
      'export const pageParts: readonly FeaturePagePart[] = [mediaSpeed];',
    );
    // 그 사이트 전용 기능이 없으면 사이트 묶음도 없다.
    expect(contentBundles([toggle('media-speed', { sites: 'all', frames: 'all' })])).toEqual([
      'common',
    ]);
  });

  it('결정 0029 사이트 전용 기능을 모두 지우면 그 사이트의 등록 목록을 맞지 않는 것으로 알리고, 만들 때 지운다', async () => {
    const root = rootWith({ 'media-speed': ['feature.ts', 'page.ts'] });
    const features = [toggle('media-speed', { sites: 'all', frames: 'all' })];
    expect(await syncGenerated(features, root, true)).toEqual([
      path.join('src', 'entries', 'generated', 'content-common.ts'),
      path.join('src', 'entries', 'generated', 'sw.ts'),
      path.join('src', 'entries', 'generated', 'popup.ts'),
    ]);
    const leftover = path.join(root, 'src', 'entries', 'generated', 'content-chatgpt.ts');
    writeFileSync(leftover, '');
    const stale = [path.join('src', 'entries', 'generated', 'content-chatgpt.ts')];
    expect(await syncGenerated(features, root, false)).toEqual(stale);
    expect(existsSync(leftover)).toBe(true);
    expect(await syncGenerated(features, root, true)).toEqual(stale);
    expect(existsSync(leftover)).toBe(false);
    expect(await syncGenerated(features, root, false)).toEqual([]);
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

  it('결정 0030 팝업의 등록 목록에는 켜고 끄기 기능 가운데 ui.tsx가 있는 것의 화면 조각만 넣는다', () => {
    const root = rootWith({
      'chatgpt-width': ['feature.ts', 'page.ts', 'ui.tsx'],
      'media-speed': ['feature.ts', 'page.ts'],
      'tab-url-copy': ['feature.ts', 'ui.tsx'],
    });
    const source = popupSource(
      [
        toggle('chatgpt-width', { sites: 'chatgpt', frames: 'top' }),
        toggle('media-speed', { sites: 'all', frames: 'all' }),
        action('tab-url-copy'),
      ],
      root,
    );
    expect(source).toContain(
      "import { ui as chatgptWidth } from '../../features/chatgpt-width/ui.tsx';",
    );
    expect(source).toContain('export const uiParts: readonly FeatureUiPart[] = [chatgptWidth];');
    expect(source).not.toContain('mediaSpeed');
    expect(source).not.toContain('tabUrlCopy');
  });

  it('이슈 #3 기능 목록에 같은 id의 기능이 둘이면 등록 목록을 만들지 않고 그 id를 알린다', async () => {
    const root = rootWith({ 'media-speed': ['feature.ts', 'page.ts'] });
    const twice = [
      toggle('media-speed', { sites: 'all', frames: 'all' }),
      toggle('media-speed', { sites: 'chatgpt', frames: 'top' }),
    ];
    await expect(syncGenerated(twice, root, false)).rejects.toThrow('media-speed');
    expect(() => {
      assertUniqueFeatureIds(twice);
    }).toThrow('기능 id가 겹친다: media-speed');
    expect(() => {
      assertUniqueFeatureIds([twice[0], action('tab-url-copy')].filter((f) => f !== undefined));
    }).not.toThrow();
  });

  it('결정 0043 서비스 워커의 등록 목록에는 탭마다 켜고 끄는 기능 가운데 background.ts가 있는 것의 background를 따로 넣는다', () => {
    const root = rootWith({
      'tab-keep-active': ['feature.ts', 'page.ts', 'background.ts'],
      'subtitle-export': ['feature.ts', 'background.ts'],
      'tab-without-background': ['feature.ts'],
    });
    const source = swSource(
      [
        tabToggle('tab-keep-active'),
        action('subtitle-export'),
        tabToggle('tab-without-background'),
      ],
      root,
    );
    expect(source).toContain(
      "import { background as tabKeepActive } from '../../features/tab-keep-active/background.ts';",
    );
    expect(source).toContain(
      'export const tabToggleParts: readonly TabTogglePart[] = [tabKeepActive];',
    );
    expect(source).toContain('export const taskParts: readonly TaskPart[] = [subtitleExport];');
    expect(source).not.toContain('tabWithoutBackground');
  });

  it('넣을 기능이 없으면 빈 목록을 만든다(타입은 가져온다)', () => {
    const source = swSource([], rootWith({}));
    expect(source).toContain(
      "import type { TabTogglePart, TaskPart } from '../../background/index.ts';",
    );
    expect(source).toContain('export const taskParts: readonly TaskPart[] = [];');
    expect(source).toContain('export const tabToggleParts: readonly TabTogglePart[] = [];');
  });
});
