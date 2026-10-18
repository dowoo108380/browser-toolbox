import {
  type FeatureDefinition,
  type PageStatus,
  featuresWithSettings,
  pageBundleSchema,
  popupRemember,
  problemReport,
  repairNoticeDismiss,
  settingsUpdate,
  storageEnsureReady,
  tabStatus,
  taskSeen,
  taskStart,
  v,
} from '../contracts/index.ts';
import type {
  Delivery,
  KeyValueStore,
  PageProbe,
  PopupWatch,
  Sender,
  TabBadge,
  TabEventHandlers,
  TabEvents,
  TabResponse,
} from '../platform/index.ts';
import { type AppError, type ErrorKind, ok } from '../shared/index.ts';
import type { SettingsFormat } from '../storage/index.ts';
import { createPopupState } from './popup-state.ts';
import { createProblemLog } from './problems.ts';
import { createRepairNoticeLog } from './repair-notice.ts';
import { createRouter, route } from './router.ts';
import { createSettingsStore } from './settings-store.ts';
import type { TaskPart } from './task-part.ts';
import { createTaskRunner } from './tasks.ts';

export { type TaskPart, defineTaskPart } from './task-part.ts';

export interface BackgroundDeps {
  readonly features: readonly FeatureDefinition[];
  readonly format: SettingsFormat;
  readonly store: KeyValueStore;
  // 탭마다의 작업 기록을 두는 저장소(chrome.storage.session, 결정 0024).
  readonly session: KeyValueStore;
  // 실행 기능의 서비스 워커 쪽 일. 빌드가 기능 목록에서 만든 등록 목록이다(src/entries/generated/sw.ts).
  readonly taskParts: readonly TaskPart[];
  readonly randomId: () => string;
  readonly tabExists: (tabId: number) => Promise<boolean>;
  // 확장 아이콘의 탭마다의 배지와 제목(결정 0024).
  readonly setTabBadge: (tabId: number, badge: TabBadge | null) => Promise<void>;
  // 탭 닫힘과 이동을 듣는다. 처음 실행될 때 바로 불러야 Chrome이 서비스 워커를 깨워 사건을 넘긴다.
  readonly listenTabEvents: (handlers: TabEventHandlers) => TabEvents;
  // 팝업의 연결을 듣는다. 처음 실행될 때 부른다(결정 0024).
  readonly watchPopups: () => PopupWatch;
  readonly isTabActive: (tabId: number) => Promise<boolean>;
  // 그 탭의 최상위 프레임에 작업 결과 알림을 보낸다(task.notice).
  readonly notifyTab: (tabId: number, text: string) => Promise<Delivery>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  // 서비스 워커가 처음 실행될 때 바로 걸어야 하는 Chrome 이벤트를 건다.
  readonly listenRequests: (
    handle: (message: unknown, sender: Sender) => Promise<unknown>,
  ) => unknown;
  readonly onInstalled: (listener: () => void) => void;
  // 열린 탭의 옛 스크립트에게 물러나라고 알린다(결정 0008). 넣을 수 없는 탭이 아닌데 실패한 것을 탭마다 끝나는 대로
  // report로 알리고, 모든 탭이 끝나거나 제한 시간을 넘기면 끝난다.
  readonly retireOldScripts: (report: (problem: AppError) => void) => Promise<void>;
  // 그 탭의 최상위 문서에 탐침을 넣어 이 확장의 실행 틀이 도는지와 그 묶음을 본다(결정 0023, 0029).
  readonly probePage: (tabId: number) => Promise<PageProbe>;
  // 그 탭의 최상위 프레임의 실행 틀에 지금 상태(찾지 못한 기능)를 묻는다(page.status, 결정 0026).
  readonly askPage: (tabId: number, timeoutMs: number) => Promise<TabResponse<PageStatus>>;
}

// 실행 틀에 묻는 제한 시간. 팝업의 tab.status 요청(5초) 안에 탐침과 함께 끝나게 짧게 둔다(결정 0026).
const askPageTimeoutMs = 1000;

export function startBackground(deps: BackgroundDeps): void {
  const problems = createProblemLog({ store: deps.store, now: deps.now });
  const record = (problem: Parameters<typeof problems.record>[0]) => {
    // 기록을 못 남겨도 할 수 있는 일이 없다. 기록 실패는 기능에 영향이 없다.
    problems.record(problem).catch(() => undefined);
  };
  const repairNotice = createRepairNoticeLog({ store: deps.store, now: deps.now });
  const settings = createSettingsStore({
    store: deps.store,
    now: deps.now,
    sleep: deps.sleep,
    format: deps.format,
    features: featuresWithSettings(deps.features),
    record,
    noticeRepair: repairNotice.add,
  });
  // 탭 사건은 처음 실행될 때 바로 듣는다. 사건은 나중에 오므로 그때 tasks는 만들어져 있다.
  const tabEvents = deps.listenTabEvents({
    removed: (tabId) => {
      tasks.tabRemoved(tabId).catch(() => {
        record({ featureId: null, kind: 'unexpected' });
      });
    },
    navigated: (tabId) => {
      tasks.tabNavigated(tabId).catch(() => {
        record({ featureId: null, kind: 'unexpected' });
      });
    },
  });
  const popups = deps.watchPopups();
  const tasks = createTaskRunner({
    session: deps.session,
    features: deps.features,
    parts: deps.taskParts,
    randomId: deps.randomId,
    tabExists: deps.tabExists,
    badge: deps.setTabBadge,
    listenTabs: tabEvents.listen,
    popupViewing: popups.viewing,
    isTabActive: deps.isTabActive,
    notify: deps.notifyTab,
    record,
  });
  const popupState = createPopupState({ store: deps.store, record });
  // 실행 틀이 찾지 못한 기능(결정 0026). 묻지 못하면 비워 답한다. 받는 쪽이 없는 것(탐침 뒤에 물러남)은 기록하지 않는다.
  const notFoundOn = async (tabId: number): Promise<PageStatus['notFound']> => {
    const response = await deps.askPage(tabId, askPageTimeoutMs);
    switch (response.delivery) {
      case 'delivered':
        return response.value.notFound;
      case 'unreachable':
        return [];
      case 'timeout':
      case 'failed':
        record({ featureId: null, kind: response.delivery === 'timeout' ? 'timeout' : 'platform' });
        return [];
    }
  };
  const router = createRouter(
    [
      route(settingsUpdate, (payload) => settings.updateFeature(payload.featureId, payload.patch)),
      route(storageEnsureReady, () => settings.ensureReady()),
      route(repairNoticeDismiss, (payload) => repairNotice.dismiss(payload.stamp)),
      route(problemReport, async (payload) => {
        await problems.record(payload);
        return ok(null);
      }),
      route(popupRemember, (payload) => popupState.remember(payload.category)),
      route(tabStatus, async (payload) => {
        const probe = await deps.probePage(payload.tabId);
        switch (probe.status) {
          case 'ran': {
            if (probe.marker === null) return ok({ page: 'reload' });
            // 표식은 같은 판의 실행 틀만 둔다(옛 판은 다른 세계다). 묶음 이름이 아니면 일어나면 안 되는 상태다.
            const bundle = v.safeParse(pageBundleSchema, probe.marker);
            if (!bundle.success) {
              record({ featureId: null, kind: 'unexpected' });
              return ok({ page: 'reload' });
            }
            return ok({
              page: 'ready',
              bundle: bundle.output,
              notFound: await notFoundOn(payload.tabId),
            });
          }
          case 'unavailable':
            return ok({ page: 'denied' });
          case 'failed':
            // 알려지지 않은 거절도 그 페이지에는 넣을 수 없는 것이다. 쓸 수 없다고 답하되 숨기지 않고 기록한다(quality 067).
            record({ featureId: null, kind: 'platform' });
            return ok({ page: 'denied' });
        }
      }),
      route(taskStart, (payload) => tasks.start(payload.featureId, payload.tabId)),
      route(taskSeen, (payload) => tasks.seen(payload.tabId, payload.taskId)),
    ],
    () => {
      record({ featureId: null, kind: 'unexpected' });
    },
  );
  deps.listenRequests(router);
  deps.onInstalled(() => {
    // 탭이 많아도 문제 기록(최근 100개)을 채우지 않게 종류마다 처음 한 번만 남긴다(quality 067). 알리는 대로 바로 남겨,
    // 늦은 탭을 기다리는 사이 서비스 워커가 멈춰도 앞의 기록은 남는다.
    const recorded = new Set<ErrorKind>();
    deps
      .retireOldScripts((problem) => {
        if (recorded.has(problem.kind)) return;
        recorded.add(problem.kind);
        record({ featureId: null, kind: problem.kind });
      })
      .catch(() => {
        record({ featureId: null, kind: 'platform' });
      });
  });
  // 앞 서비스 워커가 남긴 작업 기록을 고치고, 기록이 없으면 탭 사건 듣기를 그만둔다(결정 0024).
  tasks.recover().catch(() => {
    record({ featureId: null, kind: 'unexpected' });
  });
  // 서비스 워커가 시작할 때 설정을 준비한다(처음 설치, 손상, 옛 형식). 실패 결과도 버리지 않고 기록한다(quality 067).
  // 읽는 쪽은 준비되지 않은 설정을 보면 storage.ensureReady로 다시 부탁한다(결정 0011).
  settings
    .ensureReady()
    .then((result) => {
      if (!result.ok) record({ featureId: null, kind: result.error.kind });
    })
    .catch(() => {
      record({ featureId: null, kind: 'unexpected' });
    });
}
