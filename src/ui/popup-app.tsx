import { useEffect, useRef, useState } from 'preact/hooks';
import type {
  ActionFeature,
  Category,
  FeatureDefinition,
  TabStatus,
  ToggleFeature,
} from '../contracts/index.ts';
import type { PopupAnnouncement, RequestError } from '../platform/index.ts';
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
import {
  type Choices,
  type Ending,
  accepted,
  answered,
  chose,
  chosenValues,
  noChoices,
} from './choices.ts';
import { FeatureItem } from './feature-item.tsx';
import type { FeatureUiPart } from './part.ts';
import { SearchBox, SearchResults } from './feature-search.tsx';
import { isSearchShortcut, searchFeatures } from './search.ts';
import { strings } from './strings.ts';
import { TaskStatus } from './task-status.tsx';

// 팝업(COM-2, 결정 0023). 위에 기능 검색 칸, 그 아래 왼쪽에 범주 목록, 오른쪽에 고른 범주의 기능 항목을 보인다.
// 검색어가 있으면 범주 대신 검색 결과를 보인다.

// 팝업이 쓰는 저장소, 서비스 워커, Chrome의 길. 진입점이 실제 것을, 시험이 가짜를 넣는다. 비동기 함수는 거절하지 않고
// 실패를 결과 값으로(지난번 범주는 null로) 준다. 그래서 아래의 효과와 처리기는 결과만 보고 거절을 따로 받지 않는다.
// 거절할 수 있는 Chrome API는 그것을 감싼 platform 함수가 결과로 바꾼다(아키텍처 7장 "오류", quality 067).
interface PopupProps {
  readonly features: readonly FeatureDefinition[];
  // 기능의 화면 조각(결정 0030). 그 기능 항목에 붙여 그린다.
  readonly uiParts: readonly FeatureUiPart[];
  readonly subscribe: (handlers: SettingsReaderHandlers) => () => void;
  // 서비스 워커가 남긴 설정 복구 알림을 받는다(결정 0016).
  readonly watchRepairs: (handlers: RepairNoticeHandlers) => () => void;
  // 서비스 워커를 깨운다. 응답이 오면 깨어 있는 것이다.
  readonly wake: () => Promise<Result<unknown, AppError>>;
  // 설정을 바꾼다. 저장하면 저장한 값의 세대 번호(revision)를 준다. 실패에는 서비스 워커가 그 실패로 답했는지가 있다.
  readonly update: (
    featureId: string,
    patch: Readonly<Record<string, unknown>>,
  ) => Promise<Result<{ readonly revision: number }, RequestError>>;
  // 사용자가 본 복구 알림(stamp)을 확인했다고 서비스 워커에 알린다.
  readonly dismissRepair: (stamp: number) => Promise<Result<unknown, AppError>>;
  // 지난번에 고른 범주. 없거나 읽지 못하면 null이다(결정 0023).
  readonly rememberedCategory: () => Promise<Category | null>;
  // 고른 범주를 서비스 워커에 남긴다.
  readonly rememberCategory: (category: Category) => Promise<Result<unknown, AppError>>;
  // 팝업이 붙은 창의 지금 탭. 없으면 null이다.
  readonly currentTab: () => Promise<Result<number | null, AppError>>;
  // 그 탭에서 페이지에 작용하는 기능을 쓸 수 있는지, 외부 화면에 기대한 것이 어긋난 기능이 있는지 서비스 워커에 묻는다(결정
  // 0023, 0026, 0034).
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

// 알림 줄의 소식(결정 0036). 줄은 소식 하나와 그 차례 번호를 든다. 번호는 요청이면 그 요청을 보낸 때, 그 밖의 알림(읽기
// 도우미, 작업 기록, 복구 알림 읽기의 문제)이면 받은 때 매기고, 매길 때마다 커진다. 실패는 받는 대로 보인다(실패를 숨기지
// 않는다, COM-3 기대 동작 3). 성공(저장, 작업 시작)은 줄이 담은 소식이 모두 그보다 앞일 때만 줄을 비운다. 그래서 늦게 온 앞
// 요청의 성공이 그 뒤에 보낸 요청의 실패나 그 뒤에 받은 알림을 지우지 않는다. 실패할 때마다 새 객체를 둔다. 같은 문구라도
// 다시 그려야 스위치가 저장된 값으로 돌아가기 때문이다.
interface Notice {
  readonly message: string;
  // 이 줄이 담은 소식 가운데 가장 나중 것의 번호. 앞의 실패가 더 나중의 소식을 덮었어도 그 소식의 번호를 남긴다.
  readonly order: number;
}

// 차례 번호 order의 실패나 알림을 줄에 보인다.
function noticed(notice: Notice | null, order: number, message: string): Notice {
  return { message, order: Math.max(notice?.order ?? order, order) };
}

// 차례 번호 order의 요청이 성공했다. 줄이 담은 소식이 모두 그보다 앞이면 줄을 비운다.
function cleared(notice: Notice | null, order: number): Notice | null {
  return notice !== null && notice.order < order ? null : notice;
}

// 지금 탭의 작업(결정 0024). 둘은 기록을 받을 때 함께 바뀐다. 작업 칸이 기록보다 늦게 그려지는 때가 없게 하기 위해서다.
interface TaskView {
  // 그 탭의 기록에 있는 것. 처음 받기 전에는 undefined이고, 받은 뒤 작업이 없으면 null이다.
  readonly latest: TaskRecord | null | undefined;
  // 작업 칸이 보이는 것. 끝난 결과는 보인 뒤 서비스 워커가 기록에서 지우지만 팝업을 닫을 때까지 보인다.
  readonly shown: TaskRecord | null;
}

const unreadTask: TaskView = { latest: undefined, shown: null };

// 기록을 받은 뒤의 작업. 기록이 비었을 때 끝난 결과는 확인으로 지워진 것이라 그대로 보이고, 진행 중이던 작업은 기록에서
// 사라진 것이라(탭이 닫힘) 감춘다.
function received(view: TaskView, record: TaskRecord | null): TaskView {
  if (record !== null) return { latest: record, shown: record };
  return { latest: null, shown: view.shown?.status === 'running' ? null : view.shown };
}

export function PopupApp({
  features,
  uiParts,
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
  const [stored, setStored] = useState<Snapshot | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // 알림 줄의 소식에 마지막으로 매긴 차례 번호. ref라 처음 그릴 때 만든 처리기가 불러도 같은 번호를 센다.
  const lastOrder = useRef(0);
  const nextOrder = () => {
    lastOrder.current += 1;
    return lastOrder.current;
  };
  // 실패나 알림을 줄에 보인다. 요청의 실패면 그 요청을 보낸 때의 번호를 넘기고, 아니면 받은 때의 번호를 매긴다.
  const report = (message: string, order = nextOrder()) => {
    setNotice((previous) => noticed(previous, order, message));
  };
  // 보낸 때의 번호가 order인 요청의 결과를 줄에 맞춘다.
  const reportResult = (order: number, result: Result<unknown, AppError>) => {
    if (result.ok) setNotice((previous) => cleared(previous, order));
    else report(result.error.message, order);
  };
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

  // 지금 탭의 상태(페이지에 작용하는 기능을 쓸 수 있는지, 어긋난 기능). 답을 받기 전에는 undefined이고, 받지 못했으면
  // null이다. 둘 다 이유를 보이지 않는다. 받지 못한 까닭은 알림으로 보인다. 팝업이 열린 동안 탭이 바뀌거나 기능이 찾지
  // 못함이 되어도 다시 묻지 않는다(결정 0023, 0026).
  const [tabState, setTabState] = useState<TabStatus | null | undefined>(undefined);
  // 지금 탭. 알기 전이거나 없으면 null이다. 실행 기능은 이 탭에서 작업을 시작한다.
  const [tabId, setTabId] = useState<number | null>(null);
  useEffect(() => {
    let open = true;
    const order = nextOrder();
    const ask = async (): Promise<Result<TabStatus, AppError>> => {
      const found = await currentTab();
      if (!found.ok) return found;
      const tab = found.value;
      if (tab === null) return err(appError('unavailable', strings.noCurrentTab));
      if (open) setTabId(tab);
      return tabStatus(tab);
    };
    void ask().then((result) => {
      if (!open) return;
      setTabState(result.ok ? result.value : null);
      if (!result.ok) report(result.error.message, order);
    });
    return () => {
      open = false;
    };
  }, [currentTab, tabStatus]);

  // 이 탭의 작업(COM-10, 결정 0024). 서비스 워커는 새 작업을 시작할 때 끝난 이전 결과를 팝업이 이미 보였다고 보고 바꾼다.
  // 그래서 결과를 보인 화면이 나오기 전에는 확인을 보내지 않고 실행 단추도 열지 않는다. 그러지 않으면 보지 않은 결과가 한
  // 번도 보이지 않고 사라진다(COM-10 기대 동작 3·6, 결정 0012).
  const [task, setTask] = useState<TaskView>(unreadTask);
  useEffect(() => {
    if (tabId === null) return undefined;
    return watchTask(tabId, {
      task: (record) => {
        setTask((previous) => received(previous, record));
      },
      problem: (error) => {
        report(error.message);
      },
    });
  }, [tabId, watchTask]);
  // 작업 칸에 보인 화면이 나온 task. Preact는 useEffect를 그 그리기를 DOM에 반영한 뒤에 부른다(보통 브라우저가 다음 화면을
  // 그린 뒤, 그 전에 다시 그리게 되면 다시 그리기 직전). 그래서 아래 효과가 불릴 때 작업 칸은 task.shown을 보이고 있고,
  // 확인과 실행 단추(actionReady)는 이것을 본다.
  const [drawnTask, setDrawnTask] = useState<TaskView | null>(null);
  // 확인을 보낸 결과의 id. 같은 결과에 두 번 보내지 않는다.
  const confirmedTask = useRef<string | null>(null);
  useEffect(() => {
    setDrawnTask(task);
    const { shown } = task;
    if (shown === null || shown.status === 'running' || tabId === null) return;
    if (confirmedTask.current === shown.id) return;
    confirmedTask.current = shown.id;
    // 결과를 보인 뒤 지우게 한다. 확인을 알리지 못하면 기록이 남아 다음에 열 때 다시 보이므로 따로 알리지 않는다.
    void taskSeen(tabId, shown.id);
  }, [task, tabId, taskSeen]);
  const running = task.latest?.status === 'running' ? task.latest : null;

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

  // 화면 조각이 정한 값과 보낸 저장의 기억(결정 0036, 0037). 조각은 범주를 바꾸거나 검색하면 사라졌다 다시 그려지므로 조각
  // 안이 아니라 팝업이 열려 있는 동안 여기에 둔다. 응답과 알림은 앞의 바꿈을 그리기 전에 잇달아 올 수 있어, 바꿀 때는 늘 ref의
  // 지금 값에서 시작하고 그리는 것은 상태로 둔다. ref와 상태 바꾸기 함수는 그리기마다 같은 것이라 처음 그릴 때 만든 처리기가
  // 불러도 맞다.
  const [choices, setChoicesState] = useState<Choices>(noChoices);
  const latestChoices = useRef(choices);
  const setChoices = (next: Choices) => {
    latestChoices.current = next;
    setChoicesState(next);
  };

  useEffect(
    () =>
      subscribe({
        apply: (snapshot, revision) => {
          setStored(snapshot);
          setChoices(accepted(latestChoices.current, revision));
        },
        corrupt: (scope) => {
          setSeenRepair((previous) => mergeRepairs(previous, scope));
        },
        newer: () => {
          setStored(null);
          report(strings.newer);
        },
        problem: (error) => {
          report(error.message);
        },
      }),
    [subscribe],
  );

  useEffect(
    () =>
      watchRepairs({
        notice: setRepairLog,
        problem: (error) => {
          report(error.message);
        },
      }),
    [watchRepairs],
  );

  useEffect(() => {
    let open = true;
    const wakeAndReport = async () => {
      const order = nextOrder();
      const result = await wake();
      // 깨우지 못했으면 이유를 보인다. 스위치를 누르면 그 요청이 다시 깨우고 결과를 알린다.
      if (open && !result.ok) report(result.error.message, order);
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

  // 화면은 저장된 값을 보인다. 저장에 실패하면 알리고, 스위치와 화면 조각은 저장된 값으로 돌아간다(COM-3 기대 동작 3).
  // 거절하지 않고, 그 저장이 끝난 방법을 돌려준다(결정 0036). 서비스 워커가 unexpected가 아닌 실패로 답했으면 저장하지 않은
  // 것이다(settings.update의 계약). 답을 받지 못했거나(시간 초과, 응답 형식이 어긋남, 보내지 못함, 연결이 끊김) 처리기가 예상하지
  // 못한 오류로 끝났으면(unexpected) 어디까지 했는지 모르므로 알 수 없다.
  const save = async (
    featureId: string,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<Ending> => {
    const order = nextOrder();
    const result = await update(featureId, patch);
    reportResult(order, result);
    if (result.ok) return result.value.revision;
    return result.error.answered && result.error.kind !== 'unexpected' ? 'unwritten' : 'unknown';
  };

  // 화면 조각이 그 기능의 값을 정했다. 칸에 보이는 값과 다르면 저장을 보내고, 응답은 조각이 그려져 있지 않아도 기억에
  // 담는다(결정 0037).
  const choose = (
    feature: ToggleFeature,
    settings: Snapshot,
    patch: Readonly<Record<string, unknown>>,
  ) => {
    const chosen = chose(latestChoices.current, feature.id, settingsOf(settings, feature), patch);
    if (chosen === null) return;
    setChoices(chosen.choices);
    void save(feature.id, patch).then((ending) => {
      setChoices(answered(latestChoices.current, chosen.sent, ending));
    });
  };

  // 지금 탭에서 작업을 시작한다. 시작하지 못하면 이유를 알린다(예: 이 탭에서 다른 작업이 진행 중).
  const run = async (feature: ActionFeature) => {
    if (tabId === null) return;
    const order = nextOrder();
    const result = await startTask(feature.id, tabId);
    reportResult(order, result);
  };

  // 실행 단추를 쓸 수 있는 때(결정 0024): 서비스 워커가 깨어났고(N-12), 지금 탭을 알고, 그 탭의 작업 기록을 처음 받았고,
  // 받은 기록을 작업 칸에 보인 화면이 나왔고(위), 페이지에 작용하는 기능이면 그 탭에서 쓸 수 있는지 답도 받았다. 답을 받기
  // 전에 누르면 쓸 수 없는 페이지에서 작업을 시작해, 막힌 단추와 이유 대신 실패를 보인다. 답을 받지 못했으면 이유 없이
  // 연다(결정 0023).
  const actionReady = (feature: ActionFeature) =>
    awake &&
    tabId !== null &&
    task.latest !== undefined &&
    drawnTask === task &&
    (feature.content === null || tabState !== undefined);

  // 기능 항목은 종류마다 다르다: 켜고 끄기는 스위치(와 그 기능의 화면 조각), 실행은 단추다.
  const itemOf = (feature: FeatureDefinition, settings: Snapshot) => {
    switch (feature.kind) {
      case 'toggle': {
        const part = uiParts.find((candidate) => candidate.featureId === feature.id);
        return (
          <FeatureItem
            key={feature.id}
            feature={feature}
            enabled={settingsOf(settings, feature).enabled}
            disabled={!awake}
            onToggle={(enabled) => {
              void save(feature.id, { enabled });
            }}
            unavailable={unavailableReason(feature, tabState ?? null)}
            controls={
              part === undefined
                ? null
                : part.render(settings, {
                    chosen: chosenValues(choices, feature.id),
                    disabled: !awake,
                    choose: (patch) => {
                      choose(feature, settings, patch);
                    },
                  })
            }
          />
        );
      }
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
    const order = nextOrder();
    const result = await dismissRepair(stamp);
    if (!result.ok) {
      setConfirmedStamp(null);
      report(result.error.message, order);
    }
  };

  return (
    <main ref={root}>
      <TaskStatus task={task.shown} nameOf={nameOf} />
      {stored === null || !categoryRead ? (
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
                      .map((feature) => itemOf(feature, stored))}
                  </ul>
                </section>
              </div>
            )
          )}
        </>
      )}
      {stored !== null && categoryRead && notice !== null && <p role="status">{notice.message}</p>}
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
