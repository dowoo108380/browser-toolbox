import { useRef } from 'preact/hooks';
import type { Category } from '../contracts/index.ts';
import { categoryIndexAfterKey } from './categories.ts';
import { strings } from './strings.ts';

// 팝업의 범주 목록. 세로 탭 목록이다(ARIA 탭 패턴, 결정 0023). 목록 안에서는 고른 범주만 Tab으로 들어가고,
// 방향키·Home·End로 초점을 옮기면 그 범주를 바로 보인다(COM-2.2).

export function categoryTabId(category: Category): string {
  return `category-tab-${category}`;
}

export function categoryPanelId(category: Category): string {
  return `category-panel-${category}`;
}

interface CategoryTabsProps {
  readonly categories: readonly Category[];
  readonly selected: Category;
  readonly onSelect: (category: Category) => void;
}

export function CategoryTabs({ categories, selected, onSelect }: CategoryTabsProps) {
  const tabs = useRef(new Map<Category, HTMLButtonElement>());

  const onKeyDown = (event: KeyboardEvent) => {
    // 조합 키가 함께 눌린 것은 다른 단축키(예: Ctrl+K)의 몫이다.
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const next = categoryIndexAfterKey(event.key, categories.indexOf(selected), categories.length);
    const category = next === null ? undefined : categories[next];
    if (category === undefined) return;
    event.preventDefault();
    onSelect(category);
    tabs.current.get(category)?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={strings.categoriesLabel}
      aria-orientation="vertical"
      class="categories"
      onKeyDown={onKeyDown}
    >
      {categories.map((category) => {
        const isSelected = category === selected;
        return (
          <button
            key={category}
            type="button"
            role="tab"
            id={categoryTabId(category)}
            aria-selected={isSelected}
            // 그리는 패널은 고른 범주의 것 하나라, 없는 패널을 가리키지 않게 고른 탭에만 둔다.
            aria-controls={isSelected ? categoryPanelId(category) : undefined}
            tabIndex={isSelected ? 0 : -1}
            ref={(element) => {
              if (element === null) tabs.current.delete(category);
              else tabs.current.set(category, element);
            }}
            onClick={() => {
              onSelect(category);
            }}
          >
            {strings.categories[category]}
          </button>
        );
      })}
    </div>
  );
}
