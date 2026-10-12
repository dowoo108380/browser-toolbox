import type { FeatureDefinition } from '../src/contracts/index.ts';

// manifest는 기능 목록에서 만든다(결정 0004, 0009). 기능이 쓰지 않는 권한은 들어가지 않는다.

export const minimumChromeVersion = '150';

const pageMatches = ['http://*/*', 'https://*/*'];

// 공용으로 쓰는 권한(결정 0009). storage: 설정, scripting: 옛 스크립트 정리(결정 0008).
// 그 밖의 공용 권한(offscreen 등)은 처음 쓰는 기능을 만들 때 더한다.
const commonPermissions = ['storage', 'scripting'];

export function createManifest(
  features: readonly FeatureDefinition[],
  version: string,
): Record<string, unknown> {
  const featurePermissions = features.flatMap((feature) => feature.permissions);
  const permissions = [...new Set([...commonPermissions, ...featurePermissions])].sort();
  const pageFeatures = features.filter((feature) => feature.content !== null);
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
            {
              matches: pageMatches,
              js: ['content-common.js'],
              // about:blank 같은 프레임에도 만든 문서의 출처를 보고 싣는다(아키텍처 2장).
              all_frames: true,
              match_origin_as_fallback: true,
              run_at: 'document_start',
            },
          ],
  };
}
