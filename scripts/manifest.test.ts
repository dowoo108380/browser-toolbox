import { describe, expect, it } from 'vitest';
import { defineFeature, v } from '../src/contracts/index.ts';
import { features } from '../src/features/list.ts';
import { createManifest } from './manifest.ts';

// 결정이 manifest에 약속한 것(0005, 0006, 0009).

const manifest = createManifest(features, '0.1.0');

// 콘텐츠 스크립트 항목마다 같은 것(아키텍처 2장): 모든 프레임, 만든 문서의 출처로 고르기, 문서 시작 때.
const everyFrame = { all_frames: true, match_origin_as_fallback: true, run_at: 'document_start' };

// 활성 상태 유지(TAB-2)의 페이지 쪽 방패(결정 0041, 0043): 모든 http·https 페이지의 모든 프레임, 페이지의 세계.
const keepActiveShield = {
  matches: ['http://*/*', 'https://*/*'],
  js: ['main-tab-keep-active.js'],
  ...everyFrame,
  world: 'MAIN',
};

describe('manifest', () => {
  it('결정 0006 외부 웹사이트나 다른 확장이 메시지를 보낼 길(externally_connectable)을 두지 않는다', () => {
    expect(manifest).not.toHaveProperty('externally_connectable');
  });

  it('결정 0005·0009·0041·0047·0048 지금 기능에 필요한 권한만 둔다(TAB-2와 PAGE-1의 debugger, PAGE-1의 저장·복사와 activeTab, 공용 offscreen, unlimitedStorage 없음)', () => {
    expect(manifest['permissions']).toEqual([
      'activeTab',
      'clipboardWrite',
      'debugger',
      'downloads',
      'offscreen',
      'scripting',
      'storage',
    ]);
  });

  it('결정 0046 누를 때 넣는 페이지 쪽 스크립트는 manifest에 싣지 않고, 웹 페이지가 확장의 파일에 닿는 길(web_accessible_resources)도 두지 않는다', () => {
    const scripts = JSON.stringify(manifest['content_scripts']);
    expect(scripts).not.toContain('inject-');
    expect(manifest).not.toHaveProperty('web_accessible_resources');
  });

  it('결정 0004 공통 콘텐츠 스크립트를 모든 http·https 페이지(content.sites "all")의 모든 프레임에 싣는다. 최상위에서만 작용하는 기능은 실행 틀이 거른다', () => {
    const everySite = features.filter((feature) => feature.content?.sites === 'all');
    expect(createManifest(everySite, '0.1.0')['content_scripts']).toEqual([
      { matches: ['http://*/*', 'https://*/*'], js: ['content-common.js'], ...everyFrame },
      keepActiveShield,
    ]);
  });

  it('결정 0029 사이트 전용 기능(GPT-2, CLD-1)이 있는 사이트에는 그 사이트의 묶음만 싣고, 공통 묶음은 그 사이트들을 뺀다', () => {
    expect(manifest['content_scripts']).toEqual([
      {
        matches: ['http://*/*', 'https://*/*'],
        exclude_matches: ['https://chatgpt.com/*', 'https://claude.ai/*'],
        js: ['content-common.js'],
        ...everyFrame,
      },
      { matches: ['https://chatgpt.com/*'], js: ['content-chatgpt.js'], ...everyFrame },
      { matches: ['https://claude.ai/*'], js: ['content-claude.js'], ...everyFrame },
      keepActiveShield,
    ]);
  });

  it('결정 0043 페이지 쪽 스크립트(content.mainWorld)를 가진 기능은 그 기능의 사이트와 프레임에 페이지의 세계(MAIN)로 싣는다', () => {
    const topOnly = defineFeature({
      id: 'site-main',
      requirements: [],
      name: '사이트의 페이지 쪽',
      description: '시험',
      category: 'chatgpt',
      kind: 'toggle',
      content: { sites: 'chatgpt', frames: 'top', mainWorld: true },
      permissions: [],
      settings: { schema: v.object({ enabled: v.boolean() }), defaults: { enabled: false } },
    });
    expect(createManifest([topOnly], '0.1.0')['content_scripts']).toContainEqual({
      matches: ['https://chatgpt.com/*'],
      js: ['main-site-main.js'],
      all_frames: false,
      match_origin_as_fallback: true,
      run_at: 'document_start',
      world: 'MAIN',
    });
  });
});
