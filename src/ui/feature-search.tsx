import type { RefObject } from 'preact';
import type { FeatureDefinition } from '../contracts/index.ts';
import { searchKeyAction } from './search.ts';
import { strings } from './strings.ts';

// 팝업의 기능 검색 칸과 결과(ARIA 콤보박스의 목록 자동 완성, 결정 0023). 초점은 검색 칸에 남고, 고른 결과는
// aria-activedescendant로 가리킨다.

const resultsId = 'search-results';

function resultId(feature: FeatureDefinition): string {
  return `search-result-${feature.id}`;
}

interface SearchBoxProps {
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly query: string;
  readonly results: readonly FeatureDefinition[];
  // 고른 결과의 자리. 고른 것이 없으면 null이다.
  readonly active: number | null;
  readonly onQuery: (query: string) => void;
  readonly onActive: (index: number) => void;
  readonly onGo: (feature: FeatureDefinition) => void;
}

export function SearchBox({
  inputRef,
  query,
  results,
  active,
  onQuery,
  onActive,
  onGo,
}: SearchBoxProps) {
  const expanded = results.length > 0;
  const activeResult = active === null ? undefined : results[active];

  const onKeyDown = (event: KeyboardEvent) => {
    const action = searchKeyAction(event.key, {
      composing: event.isComposing,
      query,
      active,
      count: results.length,
    });
    if (action === null) return;
    event.preventDefault();
    switch (action.kind) {
      case 'select':
        onActive(action.index);
        return;
      case 'go': {
        const feature = results[action.index];
        if (feature !== undefined) onGo(feature);
        return;
      }
      case 'clear':
        onQuery('');
        return;
    }
  };

  return (
    <input
      ref={inputRef}
      type="text"
      class="search"
      role="combobox"
      aria-label={strings.searchLabel}
      aria-autocomplete="list"
      aria-expanded={expanded}
      // 결과 목록이 있을 때만 가리킨다. 없는 요소를 가리키지 않기 위해서다.
      aria-controls={expanded ? resultsId : undefined}
      aria-activedescendant={activeResult === undefined ? undefined : resultId(activeResult)}
      placeholder={strings.searchPlaceholder}
      autocomplete="off"
      spellcheck={false}
      value={query}
      onInput={(event) => {
        onQuery(event.currentTarget.value);
      }}
      onKeyDown={onKeyDown}
    />
  );
}

interface SearchResultsProps {
  readonly results: readonly FeatureDefinition[];
  readonly active: number | null;
  readonly onGo: (feature: FeatureDefinition) => void;
}

export function SearchResults({ results, active, onGo }: SearchResultsProps) {
  if (results.length === 0) return <p class="no-results">{strings.noResults}</p>;
  return (
    <ul role="listbox" id={resultsId} aria-label={strings.searchResultsLabel} class="results">
      {results.map((feature, index) => (
        <li
          key={feature.id}
          role="option"
          id={resultId(feature)}
          aria-selected={index === active}
          onClick={() => {
            onGo(feature);
          }}
        >
          <span class="name">{feature.name}</span>
          <span class="category">{strings.categories[feature.category]}</span>
          <span class="description">{feature.description}</span>
        </li>
      ))}
    </ul>
  );
}
