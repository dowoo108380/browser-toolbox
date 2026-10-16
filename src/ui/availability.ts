import type { FeatureDefinition, PageAccess } from '../contracts/index.ts';
import { strings } from './strings.ts';

// 지금 탭에서 그 기능을 쓸 수 없는 이유(COM-2 기대 동작 4, COM-7 기대 동작 2, 결정 0023). 쓸 수 있거나 아직 모르면
// null이다. 페이지에 작용하는 기능(content가 있는 기능)만 지금 탭의 상태를 따른다.
export function unavailableReason(
  feature: FeatureDefinition,
  page: PageAccess | null,
): string | null {
  if (feature.content === null) return null;
  switch (page) {
    case 'denied':
      return strings.unavailable(strings.pageDenied);
    case 'reload':
      return strings.unavailable(strings.pageReload);
    case 'ready':
    case null:
      return null;
  }
}
