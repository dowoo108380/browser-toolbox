import type { FeatureDefinition, TabStatus } from '../contracts/index.ts';
import { strings } from './strings.ts';

// 지금 탭에서 그 기능을 쓸 수 없거나 그 기능이 동작하지 않는 이유(COM-2 기대 동작 4, COM-6 기대 동작 2, COM-7 기대
// 동작 2, 결정 0023, 0026, 0029, 0034). 쓸 수 없음(확장이 접근할 수 없는 페이지, 새로 고쳐야 하는 탭, 다른 사이트에서 연
// 사이트 전용 기능), 찾지 못함(기대는 외부 화면 요소), 적용되지 않음(찾은 요소에 건 변경). 쓸 수 있거나 아직 모르면 null이다.
// 페이지에 작용하는 기능(content가 있는 기능)만 지금 탭의 상태를 따른다.
export function unavailableReason(
  feature: FeatureDefinition,
  tab: TabStatus | null,
): string | null {
  if (feature.content === null || tab === null) return null;
  switch (tab.page) {
    case 'denied':
      return strings.unavailable(strings.pageDenied);
    case 'reload':
      return strings.unavailable(strings.pageReload);
    case 'ready': {
      // 사이트 전용 기능은 그 탭에 그 사이트의 묶음이 실렸을 때만 돈다(결정 0029).
      const { sites } = feature.content;
      if (sites !== 'all' && tab.bundle !== sites) {
        return strings.unavailable(strings.siteOnly[sites]);
      }
      const unmet = tab.unmet.find((entry) => entry.featureId === feature.id);
      if (unmet === undefined) return null;
      switch (unmet.reason) {
        case 'not-found':
          return strings.notFound(unmet.element.name);
        case 'not-applied':
          return strings.notApplied(unmet.element.name);
      }
    }
  }
}
