// 이 기능이 Chrome 상태를 바꾼 탭과 바꾸기 전의 값(TAB-2 기대 동작 5, 결정 0041). 탭 id → 그 탭의 원래 autoDiscardable(메모리
// 절약으로 비울 수 있는지). 그 탭의 Chrome 상태(비우기 막기, 디버거 연결)를 바꾸기 전에 적고, 모두 되돌린 뒤 지운다(결정 0038의
// 차례). 서비스 워커는 이것을 storage.local에 둔다. 확장을 다시 불러와도 남아, 새 서비스 워커가 탭마다 켠 것이 사라진 탭을
// 원래 값으로 되돌린다. 받은 장부를 고치지 않고 새 장부를 만드는 순수 함수다.

export type Ledger = Readonly<Record<string, { readonly discardable: boolean }>>;

const keyOf = (tabId: number) => String(tabId);

// 그 탭을 적은 장부. 이미 적었으면 처음 적은 원래 값을 그대로 둔다(그 뒤에 읽은 값은 이 기능이 바꾼 값이다).
export function withHeld(ledger: Ledger, tabId: number, discardable: boolean): Ledger {
  if (ledger[keyOf(tabId)] !== undefined) return ledger;
  return { ...ledger, [keyOf(tabId)]: { discardable } };
}

// 그 탭을 지운 장부.
export function withoutHeld(ledger: Ledger, tabId: number): Ledger {
  return Object.fromEntries(Object.entries(ledger).filter(([key]) => key !== keyOf(tabId)));
}

// 그 탭의 원래 값. 적지 않은 탭이면 null이다.
export function originalOf(ledger: Ledger, tabId: number): boolean | null {
  return ledger[keyOf(tabId)]?.discardable ?? null;
}

export function heldTabs(ledger: Ledger): readonly number[] {
  return Object.keys(ledger).map(Number);
}

// Chrome이 탭을 바꿨다(tabs.onReplaced). 옛 탭의 원래 값을 새 탭으로 옮긴 장부.
export function withReplaced(ledger: Ledger, added: number, removed: number): Ledger {
  const original = originalOf(ledger, removed);
  const without = withoutHeld(ledger, removed);
  return original === null ? without : withHeld(without, added, original);
}
