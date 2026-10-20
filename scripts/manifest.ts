import { type FeatureDefinition, siteMatches } from '../src/contracts/index.ts';
import { contentBundles } from './registry.ts';

// manifest는 기능 목록에서 만든다(결정 0004, 0009). 기능이 쓰지 않는 권한은 들어가지 않는다.

export const minimumChromeVersion = '150';

const pageMatches = ['http://*/*', 'https://*/*'];

// 공용으로 쓰는 권한(결정 0009). storage: 설정, scripting: 옛 스크립트 정리(결정 0008).
// 그 밖의 공용 권한(offscreen 등)은 처음 쓰는 기능을 만들 때 더한다.
const commonPermissions = ['storage', 'scripting'];

// 페이지의 세계(MAIN)에 싣는 페이지 쪽 스크립트를 가진 기능(아키텍처 2장, 결정 0043). 파일은 main-<기능 id>.js다.
export function mainWorldFeatures(
  features: readonly FeatureDefinition[],
): readonly FeatureDefinition[] {
  return features.filter((feature) => feature.content?.mainWorld === true);
}

// 콘텐츠 스크립트 묶음 하나의 항목. 모든 프레임에 싣고, about:blank 같은 프레임에도 만든 문서의 출처를 보고 싣는다
// (아키텍처 2장).
function contentScript(
  file: string,
  matches: readonly string[],
  excludeMatches: readonly string[],
) {
  return {
    matches,
    ...(excludeMatches.length === 0 ? {} : { exclude_matches: excludeMatches }),
    js: [file],
    all_frames: true,
    match_origin_as_fallback: true,
    run_at: 'document_start',
  };
}

export function createManifest(
  features: readonly FeatureDefinition[],
  version: string,
): Record<string, unknown> {
  const featurePermissions = features.flatMap((feature) => feature.permissions);
  const permissions = [...new Set([...commonPermissions, ...featurePermissions])].sort();
  const pageFeatures = features.filter((feature) => feature.content !== null);
  // 사이트 묶음이 있는 사이트에는 그 묶음만 싣는다. 사이트 묶음이 공통 기능도 담으므로 한 프레임에 실행 틀은 하나다
  // (결정 0029, COM-1.4).
  const siteBundles = contentBundles(features).flatMap((bundle) =>
    bundle === 'common' ? [] : [bundle],
  );
  // 페이지 쪽 스크립트는 그 기능의 사이트와 프레임에 싣는다. 격리된 쪽 묶음과 따로 실리고 서로 DOM 이벤트로 주고받는다.
  const mainScripts = mainWorldFeatures(features).flatMap((feature) => {
    if (feature.content === null) return [];
    const { sites: target, frames } = feature.content;
    return [
      {
        matches: target === 'all' ? pageMatches : siteMatches[target],
        js: [`main-${feature.id}.js`],
        all_frames: frames === 'all',
        match_origin_as_fallback: true,
        run_at: 'document_start',
        world: 'MAIN',
      },
    ];
  });
  return {
    manifest_version: 3,
    name: 'Browser Toolbox',
    version,
    description: '웹을 쓰는 동안 늘 켜 두는 도구 모음',
    minimum_chrome_version: minimumChromeVersion,
    permissions,
    host_permissions: pageMatches,
    background: { service_worker: 'sw.js', type: 'module' },
    action: { default_popup: 'popup.html', default_title: 'Browser Toolbox' },
    content_scripts:
      pageFeatures.length === 0
        ? []
        : [
            contentScript(
              'content-common.js',
              pageMatches,
              siteBundles.flatMap((site) => siteMatches[site]),
            ),
            ...siteBundles.map((site) =>
              contentScript(`content-${site}.js`, siteMatches[site], []),
            ),
            ...mainScripts,
          ],
  };
}
