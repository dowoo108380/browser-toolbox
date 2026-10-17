import { type Category, categories, v } from '../contracts/index.ts';
import type { KeyValueStore } from '../platform/index.ts';

// 팝업이 마지막으로 고른 범주(COM-2 기대 동작 5, 결정 0023). storage.local의 popup 키에 서비스 워커가 쓴다.
// 설정이 아니라 백업하지 않고 통째로 쓴다. 잃어도 되는 편의 값이다.

export const popupStateKey = 'popup';

interface PopupStateValue {
  readonly category: Category;
}

const popupStateSchema: v.Schema<PopupStateValue> = v.object({
  category: v.picklist(categories),
});

export function popupStateOf(category: Category): PopupStateValue {
  return { category };
}

// 남긴 범주. 없거나, 읽지 못하거나, 모양이 틀리면 null이다. 편의 값이라 틀린 값은 알리지 않고 기본으로 돌아간다.
export async function readRememberedCategory(
  store: Pick<KeyValueStore, 'get'>,
): Promise<Category | null> {
  try {
    const parsed = v.safeParse(popupStateSchema, await store.get(popupStateKey));
    return parsed.success ? parsed.output.category : null;
  } catch {
    return null;
  }
}
