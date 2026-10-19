// 화면 조각이 정한 값과 그 저장의 기억(결정 0036, 0037). 팝업이 열려 있는 동안 하나를 둔다.
// - 조각은 범주를 바꾸거나 검색하면 사라졌다 다시 그려지므로, 이 기억은 조각 안이 아니라 팝업에 있다. 저장의 응답은 조각이
//   그려져 있지 않아도 여기에 담긴다(결정 0037).
// - 저장된 설정은 조각이 보낸 저장을 늦게 담고, 응답과 바뀜 알림은 어느 쪽이 먼저 올지 모른다. 그래서 칸에는 아직 담기지 않은
//   저장의 값을 보이고, 보낼지는 그 보이는 값과 견준다. 담겼는지는 세대 번호(revision)로 가른다. 서비스 워커는 쓸 때마다 앞
//   값보다 크게 정하므로, 보이는 설정의 세대 번호가 그 저장의 것보다 작지 않으면 그 저장(이나 그 뒤의 저장)을 담은 것이다
//   (결정 0011, 0036).
// - 설정 항목(기능 하나의 설정 키 하나)마다 따로 센다.

// 설정 항목 하나의 기억.
interface Item {
  // 응답을 기다리는 저장의 수.
  readonly pending: number;
  // 마지막으로 정해 보낸 값. 응답을 기다리는 동안 칸에 보인다.
  readonly last: unknown;
  // 저장한 것 가운데 세대 번호가 가장 큰 것. 서비스 워커는 들어온 차례로 저장하므로 마지막에 저장된 이 항목의 값이다.
  readonly written: { readonly revision: number; readonly value: unknown } | null;
}

export interface Choices {
  // 읽기 도우미가 받아들인 설정의 세대 번호. 받기 전이거나 기본값으로 대신 쓰면 null이다.
  readonly revision: number | null;
  // 기능 id → 설정 키 → 그 항목의 기억.
  readonly items: ReadonlyMap<string, ReadonlyMap<string, Item>>;
}

export const noChoices: Choices = { revision: null, items: new Map() };

// 보낸 저장 하나. 응답이 오면 answered에 넘긴다.
export interface Sent {
  readonly featureId: string;
  readonly patch: Readonly<Record<string, unknown>>;
}

const empty: Item = { pending: 0, last: undefined, written: null };

// 그 항목의 칸에 저장된 값 대신 보일 값. 응답을 기다리는 동안은 마지막으로 정해 보낸 값이고, 모두 끝났지만 보이는 설정이
// 마지막 저장을 아직 담지 않았으면 그 저장의 값이다. 둘 다 아니면 null(저장된 값을 보인다). 기본값으로 대신 쓰는 동안(세대
// 번호 없음)은 저장된 값이다.
function unsettled(item: Item, revision: number | null): { readonly value: unknown } | null {
  if (item.pending > 0) return { value: item.last };
  const { written } = item;
  if (written === null || revision === null || revision >= written.revision) return null;
  return { value: written.value };
}

// 그 기능의 칸에 저장된 값 대신 보일 값(설정 키 → 값). 정했지만 보이는 설정에 아직 담기지 않은 값이다.
export function chosenValues(choices: Choices, featureId: string): ReadonlyMap<string, unknown> {
  const values = new Map<string, unknown>();
  for (const [key, item] of choices.items.get(featureId) ?? []) {
    const value = unsettled(item, choices.revision);
    if (value !== null) values.set(key, value.value);
  }
  return values;
}

// 읽기 도우미가 설정을 받아들였다(그 값의 세대 번호). 기본값으로 대신 쓰면(설정 전체의 손상) 저장한 것을 잊는다. 고쳐 쓴 값의
// 세대 번호는 시계를 따라 정해져 그보다 작을 수 있다(결정 0011).
export function accepted(choices: Choices, revision: number | null): Choices {
  if (revision !== null) return { ...choices, revision };
  const items = new Map(
    [...choices.items].map(([featureId, featureItems]) => [
      featureId,
      new Map([...featureItems].map(([key, item]) => [key, { ...item, written: null }])),
    ]),
  );
  return { revision, items };
}

// 조각이 그 기능의 값을 정했다. stored는 그 기능의 저장된 설정이다. 정한 값이 모두 칸에 보이는 값과 같으면 보내지 않으므로
// null을, 아니면 보낸 뒤의 기억과 보낼 저장을 돌려준다.
export function chose(
  choices: Choices,
  featureId: string,
  stored: object,
  patch: Readonly<Record<string, unknown>>,
): { readonly choices: Choices; readonly sent: Sent } | null {
  const featureItems = choices.items.get(featureId) ?? new Map<string, Item>();
  const entries = Object.entries(patch);
  const changed = entries.some(([key, value]) => {
    const shown = unsettled(featureItems.get(key) ?? empty, choices.revision);
    const current: unknown = shown === null ? Reflect.get(stored, key) : shown.value;
    return !Object.is(value, current);
  });
  if (!changed) return null;
  const nextItems = new Map(featureItems);
  for (const [key, value] of entries) {
    const item = featureItems.get(key) ?? empty;
    nextItems.set(key, { ...item, pending: item.pending + 1, last: value });
  }
  return {
    choices: { ...choices, items: new Map(choices.items).set(featureId, nextItems) },
    sent: { featureId, patch },
  };
}

// 보낸 저장의 응답이 왔다. written은 저장한 값의 세대 번호이고, 저장하지 못했으면 null이다. 응답의 차례가 바뀌어도 세대
// 번호가 가장 큰 저장을 남긴다.
export function answered(choices: Choices, sent: Sent, written: number | null): Choices {
  const featureItems = choices.items.get(sent.featureId) ?? new Map<string, Item>();
  const nextItems = new Map(featureItems);
  for (const [key, value] of Object.entries(sent.patch)) {
    const item = featureItems.get(key) ?? empty;
    nextItems.set(key, {
      ...item,
      pending: item.pending - 1,
      written:
        written !== null && (item.written === null || written > item.written.revision)
          ? { revision: written, value }
          : item.written,
    });
  }
  return { ...choices, items: new Map(choices.items).set(sent.featureId, nextItems) };
}
