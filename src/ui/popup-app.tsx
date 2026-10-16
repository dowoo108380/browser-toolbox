import { useEffect, useRef, useState } from 'preact/hooks';
import type { ActionFeature, Category, FeatureDefinition, TabStatus } from '../contracts/index.ts';
import type { PopupAnnouncement } from '../platform/index.ts';
import { type AppError, type Result, appError, err } from '../shared/index.ts';
import {
  type RepairNotice,
  type RepairNoticeHandlers,
  type RepairScope,
  type SettingsReaderHandlers,
  type Snapshot,
  type TaskRecord,
  type TaskWatchHandlers,
  isEmptyRepair,
  mergeRepairs,
  noRepair,
  settingsOf,
} from '../storage/index.ts';
import { ActionItem } from './action-item.tsx';
import { unavailableReason } from './availability.ts';
import { visibleCategories } from './categories.ts';
import { CategoryTabs, categoryPanelId, categoryTabId } from './category-tabs.tsx';
import { FeatureItem } from './feature-item.tsx';
import { SearchBox, SearchResults } from './feature-search.tsx';
import { isSearchShortcut, searchFeatures } from './search.ts';
import { strings } from './strings.ts';
import { TaskStatus } from './task-status.tsx';

// 팝업(COM-2, 결정 0023). 위에 기능 검색 칸, 그 아래 왼쪽에 범주 목록, 오른쪽에 고른 범주의 기능 항목을 보인다.
// 검색어가 있으면 범주 대신 검색 결과를 보인다.

interface PopupProps {
  readonly features: readonly FeatureDefinition[];
  readonly subscribe: (handlers: SettingsReaderHandlers) => () => void;
  // 서비스 워커가 남긴 설정 복구 알림을 받는다(결정 0016).
  readonly watchRepairs: (handlers: RepairNoticeHandlers) => () => void;
  // 서비스 워커를 깨운다. 응답이 오면 깨어 있는 것이다.
  readonly wake: () => Promise<Result<unknown, AppError>>;
  readonly update: (
    featureId: string,
    patch: Readonly<Record<string, unknown>>,
  ) => Promise<Result<unknown, AppError>>;
  // 사용자가 본 복구 알림(stamp)을 확인했다고 서비스 워커에 알린다.
  readonly dismissRepair: (stamp: number) => Promise<Result<unknown, AppError>>;
  // 지난번에 고른 범주. 없거나 읽지 못하면 null이다(결정 0023).
  readonly rememberedCategory: () => Promise<Category | null>;
  // 고른 범주를 서비스 워커에 남긴다.
  readonly rememberCategory: (category: Category) => Promise<Result<unknown, AppError>>;
  // 팝업이 붙은 창의 지금 탭. 없으면 null이다.
  readonly currentTab: () => Promise<number | null>;
  // 그 탭에서 페이지에 작용하는 기능을 쓸 수 있는지, 찾지 못한 기능이 있는지 서비스 워커에 묻는다(결정 0023, 0026).
  readonly tabStatus: (tabId: number) => Promise<Result<TabStatus, AppError>>;
  // 그 탭에서 실행 기능의 작업을 시작한다(결정 0024). 진행과 결과는 작업 기록으로 받는다.
  readonly startTask: (featureId: string, tabId: number) => Promise<Result<unknown, AppError>>;
  // 그 탭의 작업 기록을 받는다(storage.session, 결정 0024).
  readonly watchTask: (tabId: number, handlers: TaskWatchHandlers) => () => void;
  // 그 탭의 끝난 작업(작업 id)을 보였다고 서비스 워커에 알린다(결정 0012).
  readonly taskSeen: (tabId: number, taskId: string) => Promise<Result<unknown, AppError>>;
  // 그 탭을 본다고 서비스 워커에 알린다(팝업의 연결, 결정 0024). 그 탭에서 끝난 작업은 페이지 위에 알리지 않고 이 팝업이
  // 보인다. renew는 연결이 끊겼으면(서비스 워커가 다시 시작함) 다시 잇는다.
  readonly announceTab: (tabId: number) => PopupAnnouncement;
}

// Chrome은 30초 동안 일이 없는 서비스 워커를 멈추고, 메시지를 받으면 그 시간을 다시 센다(Chrome 문서).
// 팝업이 열려 있는 동안 그보다 짧은 간격으로 깨워, 오래 열어 둔 뒤 누르자마자 닫혀도 요청이 닿게 한다(N-12, R-23).
export const keepAwakeIntervalMs = 20_000;

// 알림. 실패할 때마다 새 객체를 둔다. 같은 문구라도 다시 그려야 스위치가 저장된 값으로 돌아가기 때문이다.
interface Notice {
  readonly message: string;
}

export function PopupApp({
  features,
  subscribe,
  watchRepairs,
  wake,
  update,
  dismissRepair,
  rememberedCategory,
  rememberCategory,
  currentTab,
  tabStatus,
  startTask,
  watchTask,
  taskSeen,
  announceTab,
}: PopupProps) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // 서비스 워커가 깨어났는지(첫 깨우기의 응답을 받았는지). 그 전에는 스위치를 쓸 수 없다.
  // 깨어나는 중에 보낸 요청은 팝업이 곧바로 닫히면 닿지 않기 때문이다(N-12, R-23).
  const [awake, setAwake] = useState(false);
  // 기본값으로 바꾼 설정을 사용자가 확인할 때까지 알린다(COM-3 기대 동작 4, 결정 0016). 알릴 범위는
  // 서비스 워커가 남긴 기록과, 이 팝업이 읽기 도우미에게서 직접 본 손상을 합친 것이다. 서비스 워커가 먼저
  // 고쳐 쓰면 팝업은 고친 값만 읽으므로 기록으로 알고, 고쳐 쓰기 전이나 고쳐 쓰지 못했으면 직접 본 것으로 안다.
  const [repairLog, setRepairLog] = useState<RepairNotice | null>(null);
  const [seenRepair, setSeenRepair] = useState<RepairScope>(noRepair);
  // 사용자가 확인한 기록의 stamp. 서비스 워커가 비운 기록이 오기 전에도 감춘다.
  const [confirmedStamp, setConfirmedStamp] = useState<number | null>(null);
  const shownCategories = visibleCategories(features);
  // 고른 범주. 기능이 하나도 없으면 범주도 없다. 지난번 범주를 읽기 전에는 범주를 그리지 않는다. 첫 범주를 잠깐
  // 보였다가 바꾸지 않기 위해서다.
  const [category, setCategory] = useState<Category | undefined>(undefined);
  const [categoryRead, setCategoryRead] = useState(false);

  // 지난번에 고른 범주로 연다. 그 범주가 보이지 않거나(기능이 없음) 남긴 것이 없으면 첫 범주다(COM-2 기대 동작 5).
  useEffect(() => {
    let open = true;
    void rememberedCategory().then((remembered) => {
      if (!open) return;
      const shown = visibleCategories(features);
      setCategory(remembered !== null && shown.includes(remembered) ? remembered : shown[0]);
      setCategoryRead(true);
    });
    return () => {
      open = false;
    };
  }, [rememberedCategory, features]);

  // 지금 탭의 상태(페이지에 작용하는 기능을 쓸 수 있는지, 찾지 못한 기능). 답을 받기 전에는 undefined이고, 받지 못했으면
  // null이다. 둘 다 이유를 보이지 않는다. 받지 못한 까닭은 알림으로 보인다. 팝업이 열린 동안 탭이 바뀌거나 기능이 찾지
  // 못함이 되어도 다시 묻지 않는다(결정 0023, 0026).
  const [tabState, setTabState] = useState<TabStatus | null | undefined>(undefined);
  // 지금 탭. 알기 전이거나 없으면 null이다. 실행 기능은 이 탭에서 작업을 시작한다.
  const [tabId, setTabId] = useState<number | null>(null);
  useEffect(() => {
    let open = true;
    const ask = async () => {
      const tab = await currentTab();
      if (tab === null) return err(appError('unavailable', strings.noCurrentTab));
      if (open) setTabId(tab);
      return tabStatus(tab);
    };
    void ask().then((result) => {
      if (!open) return;
      setTabState(result.ok ? result.value : null);
      if (!result.ok) setNotice({ message: result.error.message });
    });
    return () => {
      open = false;
    };
  }, [currentTab, tabStatus]);

  // 이 탭의 작업(COM-10, 결정 0024). latest는 기록에 있는 것이고, shown은 작업 칸이 보이는 것이다. 끝난 결과는 보인 뒤
  // 서비스 워커가 기록에서 지우지만 팝업을 닫을 때까지 보인다.
  // latest는 그 탭의 기록을 처음 받기 전에는 undefined이고, 받은 뒤 작업이 없으면 null이다. 처음 받기 전에는 실행 단추를
  // 막는다(actionReady). 서비스 워커는 새 작업을 시작할 때 끝난 이전 결과를 팝업이 이미 보였다고 보고 바꾸므로, 그 전에
  // 시작하면 보지 않은 결과가 한 번도 보이지 않고 사라진다(COM-10 기대 동작 3·6).
  const [latest, setLatest] = useState<TaskRecord | null | undefined>(undefined);
  const [shown, setShown] = useState<TaskRecord | null>(null);
  useEffect(() => {
    if (tabId === null) return undefined;
    return watchTask(tabId, {
      task: setLatest,
      problem: (error) => {
        setNotice({ message: error.message });
      },
    });
  }, [tabId, watchTask]);
  // 확인을 보낸 결과의 id. 같은 결과에 두 번 보내지 않는다.
  const confirmedTask = useRef<string | null>(null);
  useEffect(() => {
    if (latest === undefined) return;
    if (latest === null) {
      // 진행 중이던 작업이 기록에서 사라지면(탭이 닫힘) 감춘다. 끝난 결과는 확인으로 지워진 것이라 그대로 보인다.
      setShown((previous) => (previous?.status === 'running' ? null : previous));
      return;
    }
    setShown(latest);
    if (latest.status === 'running' || tabId === null || confirmedTask.current === latest.id)
      return;
    confirmedTask.current = latest.id;
    // 그린 뒤에 보낸다(결과를 보인 뒤 지운다). 확인을 알리지 못하면 기록이 남아 다음에 열 때 다시 보이므로 따로 알리지 않는다.
    void taskSeen(tabId, latest.id);
  }, [latest, tabId, taskSeen]);
  const running = latest?.status === 'running' ? latest : null;

  // 지금 탭을 알면 그 탭을 본다고 알리고, 팝업이 닫히면 연결을 닫는다. 깨울 때마다 끊긴 연결을 다시 잇는다(아래).
  const announcement = useRef<{ readonly renew: () => void } | null>(null);
  useEffect(() => {
    if (tabId === null) return undefined;
    const opened = announceTab(tabId);
    announcement.current = opened;
    return () => {
      announcement.current = null;
      opened.close();
    };
  }, [tabId, announceTab]);

  const nameOf = (featureId: string) =>
    features.find((feature) => feature.id === featureId)?.name ?? featureId;

  const selectCategory = (next: Category) => {
    setCategory(next);
    // 남기지 못해도 알리지 않는다. 편의 값이고, 서비스 워커가 기록한다(결정 0023).
    void rememberCategory(next);
  };

  const [query, setQuery] = useState('');
  // 검색 결과에서 고른 것의 자리. 고른 것이 없으면 null이다.
  const [active, setActive] = useState<number | null>(null);
  const results = searchFeatures(features, query);
  const searching = query.trim() !== '';
  const changeQuery = (next: string) => {
    setQuery(next);
    setActive(null);
  };

  const root = useRef<HTMLElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  // 검색에서 간 기능. 그 기능 항목을 그린 뒤 첫 조작 요소에 초점을 둔다.
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  useEffect(() => {
    if (focusTarget === null) return;
    root.current
      ?.querySelector<HTMLElement>(`[data-feature="${CSS.escape(focusTarget)}"]`)
      ?.focus();
    setFocusTarget(null);
  }, [focusTarget]);

  // 검색 결과의 그 기능 화면으로 간다: 검색어를 지우고, 그 기능의 범주를 고르고, 그 기능 항목의 첫 조작 요소에
  // 초점을 둔다(결정 0023). 그래서 Ctrl+K, 검색어, Enter, Space로 기능을 켜고 끈다.
  const goTo = (feature: FeatureDefinition) => {
    changeQuery('');
    selectCategory(feature.category);
    setFocusTarget(feature.id);
  };

  // 팝업 어디서든 Ctrl+K는 검색 칸으로 간다(COM-2.1).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const input = searchInput.current;
      if (input === null || !isSearchShortcut(event)) return;
      event.preventDefault();
      input.focus();
      input.select();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  useEffect(
    () =>
      subscribe({
        apply: setSnapshot,
        corrupt: (scope) => {
          setSeenRepair((previous) => mergeRepairs(previous, scope));
        },
        newer: () => {
          setSnapshot(null);
          setNotice({ message: strings.newer });
        },
        problem: (error) => {
          setNotice({ message: error.message });
        },
      }),
    [subscribe],
  );

  useEffect(
    () =>
      watchRepairs({
        notice: setRepairLog,
        problem: (error) => {
          setNotice({ message: error.message });
        },
      }),
    [watchRepairs],
  );

  useEffect(() => {
    let open = true;
    const wakeAndReport = async () => {
      const result = await wake();
      // 깨우지 못했으면 이유를 보인다. 스위치를 누르면 그 요청이 다시 깨우고 결과를 알린다.
      if (open && !result.ok) setNotice({ message: result.error.message });
      if (open && result.ok) announcement.current?.renew();
    };
    void wakeAndReport().then(() => {
      if (open) setAwake(true);
    });
    const timer = setInterval(() => {
      void wakeAndReport();
    }, keepAwakeIntervalMs);
    return () => {
      open = false;
      clearInterval(timer);
    };
  }, [wake]);

  // 화면은 저장된 값을 보인다. 저장에 실패하면 알리고 스위치를 저장된 값으로 되돌린다(COM-3 기대 동작 3).
  const toggle = async (featureId: string, enabled: boolean) => {
    const result = await update(featureId, { enabled });
    setNotice(result.ok ? null : { message: result.error.message });
  };

  // 지금 탭에서 작업을 시작한다. 시작하지 못하면 이유를 알린다(예: 이 탭에서 다른 작업이 진행 중).
  const run = async (feature: ActionFeature) => {
    if (tabId === null) return;
    const result = await startTask(feature.id, tabId);
    setNotice(result.ok ? null : { message: result.error.message });
  };

  // 실행 단추를 쓸 수 있는 때(결정 0024): 서비스 워커가 깨어났고(N-12), 지금 탭을 알고, 그 탭의 작업 기록을 처음 받았고,
  // 페이지에 작용하는 기능이면 그 탭에서 쓸 수 있는지 답도 받았다. 답을 받기 전에 누르면 쓸 수 없는 페이지에서 작업을
  // 시작해, 막힌 단추와 이유 대신 실패를 보인다. 답을 받지 못했으면 이유 없이 연다(결정 0023).
  const actionReady = (feature: ActionFeature) =>
    awake &&
    tabId !== null &&
    latest !== undefined &&
    (feature.content === null || tabState !== undefined);

  // 기능 항목은 종류마다 다르다: 켜고 끄기는 스위치, 실행은 단추다.
  const itemOf = (feature: FeatureDefinition, settings: Snapshot) => {
    switch (feature.kind) {
      case 'toggle':
        return (
          <FeatureItem
            key={feature.id}
            feature={feature}
            enabled={settingsOf(settings, feature).enabled}
            disabled={!awake}
            onToggle={(enabled) => {
              void toggle(feature.id, enabled);
            }}
            unavailable={unavailableReason(feature, tabState ?? null)}
          />
        );
      case 'action':
        return (
          <ActionItem
            key={feature.id}
            feature={feature}
            waiting={!actionReady(feature)}
            onRun={() => {
              void run(feature);
            }}
            unavailable={
              running === null
                ? unavailableReason(feature, tabState ?? null)
                : strings.unavailable(strings.runningHere(nameOf(running.featureId)))
            }
          />
        );
    }
  };

  const loggedRepair =
    repairLog === null || repairLog.stamp === confirmedStamp ? noRepair : repairLog;
  const repair = mergeRepairs(loggedRepair, seenRepair);

  // 확인하면 본 기록만 지운다. 그 뒤에 서비스 워커가 더한 손상은 새 기록으로 다시 보인다.
  const confirmRepair = async () => {
    setSeenRepair(noRepair);
    if (repairLog === null || isEmptyRepair(repairLog)) return;
    const { stamp } = repairLog;
    setConfirmedStamp(stamp);
    const result = await dismissRepair(stamp);
    if (!result.ok) {
      setConfirmedStamp(null);
      setNotice({ message: result.error.message });
    }
  };

  return (
    <main ref={root}>
      <TaskStatus task={shown} nameOf={nameOf} />
      {snapshot === null || !categoryRead ? (
        <p>{notice?.message ?? strings.loading}</p>
      ) : (
        <>
          <SearchBox
            inputRef={searchInput}
            query={query}
            results={results}
            active={active}
            onQuery={changeQuery}
            onActive={setActive}
            onGo={goTo}
          />
          {searching ? (
            <SearchResults results={results} active={active} onGo={goTo} />
          ) : (
            category !== undefined && (
              <div class="layout">
                <CategoryTabs
                  categories={shownCategories}
                  selected={category}
                  onSelect={selectCategory}
                />
                <section
                  role="tabpanel"
                  id={categoryPanelId(category)}
                  aria-labelledby={categoryTabId(category)}
                  class="panel"
                >
                  <ul class="features">
                    {features
                      .filter((feature) => feature.category === category)
                      .map((feature) => itemOf(feature, snapshot))}
                  </ul>
                </section>
              </div>
            )
          )}
        </>
      )}
      {snapshot !== null && categoryRead && notice !== null && (
        <p role="status">{notice.message}</p>
      )}
      {!isEmptyRepair(repair) && (
        <section class="repair" aria-label={strings.repairLabel} aria-live="polite">
          {repair.whole && <p>{strings.repairWhole}</p>}
          {repair.features.length > 0 && (
            <p>{strings.repairFeatures(repair.features.map(nameOf).join(', '))}</p>
          )}
          {repair.sites.length > 0 && (
            <p>
              {strings.repairSites(
                repair.sites
                  .map(({ host, featureId }) =>
                    strings.siteItem(host, featureId === null ? null : nameOf(featureId)),
                  )
                  .join(', '),
              )}
            </p>
          )}
          <button
            type="button"
            onClick={() => {
              void confirmRepair();
            }}
          >
            {strings.repairConfirm}
          </button>
        </section>
      )}
    </main>
  );
}
