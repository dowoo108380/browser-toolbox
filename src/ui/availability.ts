import type { FeatureDefinition, TabRuntime, TabStatus } from '../contracts/index.ts';
import { strings } from './strings.ts';

// 그 탭의 실행 틀 때문에 그 기능을 쓸 수 없는 이유(COM-2 기대 동작 4, COM-7 기대 동작 2, 결정 0023, 0029, 0045): 확장이
// 접근할 수 없는 페이지, 새로 고쳐야 하는 탭, 다른 사이트에서 연 사이트 전용 기능. 쓸 수 있거나 아직 모르면 null이다. 페이지에
// 작용하는 기능(content가 있는 기능)만 그 탭의 실행 틀을 따른다. 지금 탭의 상태와 탭 목록의 탭마다 쓴다.
// 실행 틀 없이 누를 때 스크립트를 넣는 기능(injectedScript, 결정 0046)은 그 탭에 넣을 수 있기만 하면 된다. 새로 고치기 전의
// 탭(reload)에서도 쓸 수 있다.
export function runtimeReason(
  feature: FeatureDefinition,
  runtime: TabRuntime | null,
): string | null {
  if (runtime === null) return null;
  if (feature.content === null) {
    return feature.injectedScript === true && runtime.page === 'denied'
      ? strings.unavailable(strings.pageDenied)
      : null;
  }
  switch (runtime.page) {
    case 'denied':
      return strings.unavailable(strings.pageDenied);
    case 'reload':
      return strings.unavailable(strings.pageReload);
    case 'ready': {
      // 사이트 전용 기능은 그 탭에 그 사이트의 묶음이 실렸을 때만 돈다(결정 0029).
      const { sites } = feature.content;
      return sites !== 'all' && runtime.bundle !== sites
        ? strings.unavailable(strings.siteOnly[sites])
        : null;
    }
  }
}

// 지금 탭에서 그 기능을 쓸 수 없거나 그 기능이 동작하지 않는 이유(COM-2 기대 동작 4, COM-6 기대 동작 2, COM-7 기대
// 동작 2, 결정 0023, 0026, 0029, 0034). 쓸 수 없음(위), 찾지 못함(기대는 외부 화면 요소), 적용되지 않음(찾은 요소에 건
// 변경). 쓸 수 있거나 아직 모르면 null이다.
export function unavailableReason(
  feature: FeatureDefinition,
  tab: TabStatus | null,
): string | null {
  if (tab === null) return null;
  const reason = runtimeReason(feature, tab);
  // 외부 화면에 기대한 것(unmet)은 실행 틀이 도는 기능의 것이다.
  if (reason !== null || tab.page !== 'ready' || feature.content === null) return reason;
  const unmet = tab.unmet.find((entry) => entry.featureId === feature.id);
  if (unmet === undefined) return null;
  switch (unmet.reason) {
    case 'not-found':
      return strings.notFound(unmet.element.name);
    case 'not-applied':
      return strings.notApplied(unmet.element.name);
  }
}
