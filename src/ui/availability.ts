import type { FeatureDefinition, TabStatus } from '../contracts/index.ts';
import { strings } from './strings.ts';

// 지금 탭에서 그 기능을 쓸 수 없거나 그 기능이 동작하지 않는 이유(COM-2 기대 동작 4, COM-6 기대 동작 2, COM-7 기대
// 동작 2, 결정 0023, 0026). 쓸 수 없음(확장이 접근할 수 없는 페이지, 새로 고쳐야 하는 탭) 또는 찾지 못함(기대는 외부
// 화면 요소). 쓸 수 있거나 아직 모르면 null이다. 페이지에 작용하는 기능(content가 있는 기능)만 지금 탭의 상태를 따른다.
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
      const missing = tab.notFound.find((entry) => entry.featureId === feature.id);
      return missing === undefined ? null : strings.notFound(missing.element.name);
    }
  }
}
