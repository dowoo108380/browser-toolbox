import { v } from '../contracts/index.ts';
import type { KeyValueStore } from '../platform/index.ts';
import { type AppError, appError } from '../shared/index.ts';

// 탭마다 켜고 끄는 기능의 탭마다의 기록(TAB-2 기대 동작 1, 결정 0043). storage.session의 tabToggles 키 하나에 기능 id → 그
// 기능의 기록으로 둔다. 쓰는 곳은 서비스 워커 하나다. storage.session은 확장을 다시 불러오거나 갱신하거나 브라우저를 다시
// 시작하면 비므로(결정 0024의 실험 2) 탭마다 켠 것은 그때 사라지고, 이 모양은 판 사이에 이어지지 않는다(형식 버전이 없다).
// 기록을 바꾸는 함수는 받은 기록을 고치지 않고 새 기록을 만드는 순수 함수다. watchTabToggles는 확장 화면이 읽는 도우미다.

export const tabTogglesKey = 'tabToggles';

// 탭 하나의 기록. choice는 사용자가 그 탭에 고른 것(켬, 끔)이고, null이면 "모든 탭" 스위치를 따른다. notice는 그 기능이 그
// 탭에 남긴 알림의 이름(기능 정의의 notices)이고, 없으면 null이다. 둘 다 null인 탭은 기록하지 않는다.
interface TabToggleEntry {
  readonly choice: boolean | null;
  readonly notice: string | null;
}

// 기능 하나의 기록. allTabs는 지금 기록이 따르는 "모든 탭" 스위치의 값이다. 설정의 스위치가 이것과 다르면 스위치가 바뀐
// 것이라(새 세션이면 기록이 없다) 탭마다 고른 것을 지우고 그 값으로 맞춘다(한꺼번에 적용, withAllTabs).
interface FeatureTabToggles {
  readonly allTabs: boolean;
  readonly tabs: Readonly<Record<string, TabToggleEntry>>;
}

export type TabToggleRecords = Readonly<Record<string, FeatureTabToggles>>;

const nameSchema = v.pipe(v.string(), v.maxLength(64));

const recordsSchema: v.Schema<TabToggleRecords> = v.record(
  v.string(),
  v.object({
    allTabs: v.boolean(),
    tabs: v.record(
      v.string(),
      v.object({ choice: v.nullable(v.boolean()), notice: v.nullable(nameSchema) }),
    ),
  }),
);

// 읽은 값. 없으면 빈 기록이고, 모양이 틀리면 null이다(쓰는 곳이 하나라 틀린 값은 결함이다).
export function parseTabToggles(raw: unknown): TabToggleRecords | null {
  if (raw === undefined) return {};
  const parsed = v.safeParse(recordsSchema, raw);
  return parsed.success ? parsed.output : null;
}

const keyOf = (tabId: number) => String(tabId);

const entryOf = (
  records: TabToggleRecords,
  featureId: string,
  tabId: number,
): TabToggleEntry | null => records[featureId]?.tabs[keyOf(tabId)] ?? null;

// 그 탭에서 그 기능이 켜졌는지. 고른 것이 없으면 스위치를 따른다.
export function tabIsOn(
  records: TabToggleRecords,
  featureId: string,
  tabId: number,
  allTabs: boolean,
): boolean {
  return entryOf(records, featureId, tabId)?.choice ?? allTabs;
}

// 그 탭에 남긴 알림의 이름. 없으면 null이다.
export function tabNotice(
  records: TabToggleRecords,
  featureId: string,
  tabId: number,
): string | null {
  return entryOf(records, featureId, tabId)?.notice ?? null;
}

// 기록이 있는 탭(고른 것이나 알림이 있는 탭).
export function recordedTabs(records: TabToggleRecords, featureId: string): readonly number[] {
  return Object.keys(records[featureId]?.tabs ?? {}).map(Number);
}

// 어느 탭에서 켜졌을 수 있는지: 스위치가 켜졌거나 켬을 고른 탭이 있다.
export function mayBeOn(records: TabToggleRecords, featureId: string, allTabs: boolean): boolean {
  return (
    allTabs || Object.values(records[featureId]?.tabs ?? {}).some((entry) => entry.choice === true)
  );
}

// 그 기능의 탭 기록을 고친 새 기록. 둘 다 null인 탭은 빼고, 고칠 탭이 없는 기능이면 그대로 둔다.
function withEntries(
  records: TabToggleRecords,
  featureId: string,
  allTabs: boolean,
  tabIds: readonly number[],
  next: (current: TabToggleEntry | null) => TabToggleEntry,
): TabToggleRecords {
  const feature = records[featureId] ?? { allTabs, tabs: {} };
  const changed = new Map(
    tabIds.map((tabId) => [keyOf(tabId), next(feature.tabs[keyOf(tabId)] ?? null)]),
  );
  const tabs = Object.fromEntries(
    [...Object.entries(feature.tabs).filter(([key]) => !changed.has(key)), ...changed].filter(
      ([, entry]) => entry.choice !== null || entry.notice !== null,
    ),
  );
  return { ...records, [featureId]: { allTabs: feature.allTabs, tabs } };
}

// 스위치가 allTabs가 된 기록. 기록이 따르던 값과 같으면 null이다(바뀐 것이 없다). 다르면 탭마다 고른 것과 알림을 모두
// 지운다: 스위치는 지금 열린 탭과 앞으로 여는 탭에 한꺼번에 적용된다(TAB-2 기대 동작 1).
export function withAllTabs(
  records: TabToggleRecords,
  featureId: string,
  allTabs: boolean,
): TabToggleRecords | null {
  if (records[featureId]?.allTabs === allTabs) return null;
  return { ...records, [featureId]: { allTabs, tabs: {} } };
}

// 사용자가 그 탭들을 켜거나 끈 기록. 스위치와 같은 쪽을 고르면 고른 것을 지운다(스위치를 따른다). 알림도 지운다. 스위치의
// 값은 기록이 따르는 값(allTabs)이다.
export function withChoice(
  records: TabToggleRecords,
  featureId: string,
  allTabs: boolean,
  tabIds: readonly number[],
  on: boolean,
): TabToggleRecords {
  const switchValue = records[featureId]?.allTabs ?? allTabs;
  return withEntries(records, featureId, allTabs, tabIds, () => ({
    choice: on === switchValue ? null : on,
    notice: null,
  }));
}

// 기능이 그 탭들을 끄고 그 까닭을 남긴 기록(디버거를 붙이지 못함 등, TAB-2 기대 동작 9).
export function withTurnedOff(
  records: TabToggleRecords,
  featureId: string,
  allTabs: boolean,
  tabIds: readonly number[],
  notice: string,
): TabToggleRecords {
  const switchValue = records[featureId]?.allTabs ?? allTabs;
  return withEntries(records, featureId, allTabs, tabIds, () => ({
    choice: switchValue ? false : null,
    notice,
  }));
}

// 기능이 그 탭에 알림을 남기거나 지운 기록. 고른 것은 그대로다.
export function withNotice(
  records: TabToggleRecords,
  featureId: string,
  allTabs: boolean,
  tabId: number,
  notice: string | null,
): TabToggleRecords {
  return withEntries(records, featureId, allTabs, [tabId], (current) => ({
    choice: current?.choice ?? null,
    notice,
  }));
}

// 그 탭의 기록을 모든 기능에서 지운 것(탭이 닫힘).
export function withoutTab(records: TabToggleRecords, tabId: number): TabToggleRecords {
  return Object.fromEntries(
    Object.entries(records).map(([featureId, feature]) => [
      featureId,
      {
        allTabs: feature.allTabs,
        tabs: Object.fromEntries(
          Object.entries(feature.tabs).filter(([key]) => key !== keyOf(tabId)),
        ),
      },
    ]),
  );
}

// Chrome이 탭을 다른 탭으로 바꿨다(tabs.onReplaced, 미리 렌더링한 문서 등). 옛 탭의 기록을 새 탭으로 옮긴 것.
export function withReplacedTab(
  records: TabToggleRecords,
  added: number,
  removed: number,
): TabToggleRecords {
  return Object.fromEntries(
    Object.entries(records).map(([featureId, feature]) => {
      const { [keyOf(removed)]: moved, ...rest } = feature.tabs;
      return [
        featureId,
        {
          allTabs: feature.allTabs,
          tabs: moved === undefined ? rest : { ...rest, [keyOf(added)]: moved },
        },
      ];
    }),
  );
}

export interface TabTogglesWatchHandlers {
  readonly records: (records: TabToggleRecords) => void;
  readonly problem: (error: AppError) => void;
}

// 확장 화면이 탭마다 켜고 끄는 기능의 기록을 읽는다. 바뀜 알림을 먼저 듣고 읽는다. 알림이 읽기 결과보다 먼저 오면 읽기
// 결과(더 옛 값일 수 있다)는 버린다. 모양이 틀린 기록은 빈 기록으로 보인다(쓰는 서비스 워커가 기록한다). 그만둔 뒤에는
// 알리지 않는다.
export function watchTabToggles(
  store: Pick<KeyValueStore, 'get' | 'onChanged'>,
  handlers: TabTogglesWatchHandlers,
): () => void {
  let stopped = false;
  let changed = false;
  const receive = (raw: unknown) => {
    handlers.records(parseTabToggles(raw) ?? {});
  };
  const unsubscribe = store.onChanged(tabTogglesKey, (raw) => {
    changed = true;
    receive(raw);
  });
  store.get(tabTogglesKey).then(
    (raw) => {
      if (!stopped && !changed) receive(raw);
    },
    () => {
      if (!stopped) handlers.problem(appError('platform', '탭마다 켠 기능의 기록을 읽지 못했다.'));
    },
  );
  return () => {
    stopped = true;
    unsubscribe();
  };
}

// 콘텐츠 스크립트가 시작할 때 서비스 워커에 탭의 상태를 물을지 정하는 표시(storage.local의 tabToggleHint, 결정 0043). 어느
// 탭에서 켜졌을 수 있는 기능 id의 목록이다. 서비스 워커가 쓰고, 콘텐츠 스크립트는 이것이 비었으면 묻지 않는다. 그래서 탭마다
// 켜는 기능을 아무 데서도 켜지 않은 동안은 페이지를 열 때마다 서비스 워커를 깨우지 않는다. 표시는 켜진 탭보다 먼저 생기고
// 나중에 없어진다(결정 0038의 차례).
export const tabToggleHintKey = 'tabToggleHint';

const hintSchema = v.array(nameSchema);

// 읽은 표시. 없거나 모양이 틀리면 빈 목록이다(틀린 값은 쓰는 서비스 워커가 다음에 고쳐 쓴다).
export function parseTabToggleHint(raw: unknown): readonly string[] {
  const parsed = v.safeParse(hintSchema, raw);
  return parsed.success ? parsed.output : [];
}
