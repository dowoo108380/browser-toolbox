import {
  type FeatureDefinition,
  popupRemember,
  problemReport,
  repairNoticeDismiss,
  settingsUpdate,
  storageEnsureReady,
  tabStatus,
} from '../contracts/index.ts';
import type { LocalStore, PageProbe, Sender } from '../platform/index.ts';
import { type AppError, type ErrorKind, ok } from '../shared/index.ts';
import type { SettingsFormat } from '../storage/index.ts';
import { createPopupState } from './popup-state.ts';
import { createProblemLog } from './problems.ts';
import { createRepairNoticeLog } from './repair-notice.ts';
import { createRouter, route } from './router.ts';
import { createSettingsStore } from './settings-store.ts';

export interface BackgroundDeps {
  readonly features: readonly FeatureDefinition[];
  readonly format: SettingsFormat;
  readonly store: LocalStore;
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
  // 그 탭의 최상위 문서에 탐침을 넣어 이 확장의 실행 틀이 도는지 본다(결정 0023).
  readonly probePage: (tabId: number) => Promise<PageProbe>;
}

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
    features: deps.features,
    record,
    noticeRepair: repairNotice.add,
  });
  const popupState = createPopupState({ store: deps.store, record });
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
          case 'ran':
            return ok({ page: probe.runtime ? 'ready' : 'reload' });
          case 'unavailable':
            return ok({ page: 'denied' });
          case 'failed':
            // 알려지지 않은 거절도 그 페이지에는 넣을 수 없는 것이다. 쓸 수 없다고 답하되 숨기지 않고 기록한다(quality 067).
            record({ featureId: null, kind: 'platform' });
            return ok({ page: 'denied' });
        }
      }),
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
