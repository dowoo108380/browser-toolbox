import { type Category, type FeatureDefinition, categories } from '../contracts/index.ts';

// 팝업의 범주 목록(COM-2, 결정 0023).

// 기능이 하나라도 있는 범주를 정해진 순서로. 기능이 없는 범주는 고르면 빈 화면이라 보이지 않는다.
export function visibleCategories(features: readonly FeatureDefinition[]): readonly Category[] {
  return categories.filter((category) => features.some((feature) => feature.category === category));
}

// 범주 목록에서 누른 키가 초점을 옮길 범주의 자리. 옮기지 않는 키면 null이다. 아래·위는 끝에서 반대쪽 끝으로 간다
// (ARIA 탭 패턴, COM-2.2).
export function categoryIndexAfterKey(key: string, index: number, count: number): number | null {
  switch (key) {
    case 'ArrowDown':
      return (index + 1) % count;
    case 'ArrowUp':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
