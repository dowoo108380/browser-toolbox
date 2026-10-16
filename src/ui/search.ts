import { type FeatureDefinition, categories } from '../contracts/index.ts';

// 팝업의 기능 검색(COM-2 기대 동작 3, 결정 0023).

// 검색어(앞뒤 공백을 뺀 것)가 이름이나 설명에 들어 있는 기능. 대소문자는 가리지 않는다. 결과는 범주 순서이고, 범주
// 안에서는 기능 목록의 순서다. 검색어가 비면 결과도 없다(그때는 범주 화면을 보인다).
export function searchFeatures(
  features: readonly FeatureDefinition[],
  query: string,
): readonly FeatureDefinition[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') return [];
  const contains = (text: string) => text.toLocaleLowerCase().includes(needle);
  const found = features.filter(
    (feature) => contains(feature.name) || contains(feature.description),
  );
  return categories.flatMap((category) => found.filter((feature) => feature.category === category));
}

// 팝업 어디서든 검색 칸으로 가는 키(Ctrl+K). 글자가 아니라 자판의 자리(code)로 본다. 한글 자판에서도 같다(N-01).
export function isSearchShortcut(event: {
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}): boolean {
  return (
    event.code === 'KeyK' && event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey
  );
}

export type SearchKeyAction =
  // 결과의 index번째를 고른다.
  | { readonly kind: 'select'; readonly index: number }
  // 결과의 index번째 기능의 화면으로 간다.
  | { readonly kind: 'go'; readonly index: number }
  // 검색어를 지운다.
  | { readonly kind: 'clear' };

interface SearchKeyState {
  // 한글 등을 조합하는 중인지(KeyboardEvent.isComposing).
  readonly composing: boolean;
  // 검색 칸의 글자 그대로.
  readonly query: string;
  // 고른 결과의 자리. 고른 것이 없으면 null이다.
  readonly active: number | null;
  readonly count: number;
}

// 검색 칸에서 누른 키가 할 일(ARIA 콤보박스, 결정 0023). 할 일이 없으면 null이다. 아래·위는 결과를 고르고(끝에서는
// 반대쪽 끝으로), Enter는 고른 결과로 가며 고른 것이 없으면 첫 결과다. Esc는 검색어가 있을 때만 지운다. 조합 중인 키는
// 조합을 끝내는 데 쓰이므로 할 일이 없다(N-01).
export function searchKeyAction(key: string, state: SearchKeyState): SearchKeyAction | null {
  if (state.composing) return null;
  const { active, count } = state;
  switch (key) {
    case 'ArrowDown':
      if (count === 0) return null;
      return { kind: 'select', index: active === null ? 0 : (active + 1) % count };
    case 'ArrowUp':
      if (count === 0) return null;
      return { kind: 'select', index: active === null ? count - 1 : (active - 1 + count) % count };
    case 'Enter':
      if (count === 0) return null;
      return { kind: 'go', index: active ?? 0 };
    case 'Escape':
      return state.query === '' ? null : { kind: 'clear' };
    default:
      return null;
  }
}
