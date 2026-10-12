import {
  type FeatureDefinition,
  problemReport,
  settingsUpdate,
  storageEnsureReady,
} from '../contracts/index.ts';
import type { LocalStore, Sender } from '../platform/index.ts';
import { ok } from '../shared/index.ts';
import type { SettingsFormat } from '../storage/index.ts';
import { createProblemLog } from './problems.ts';
import { createRouter, route } from './router.ts';
import { createSettingsStore } from './settings-store.ts';

export interface BackgroundDeps {
  readonly features: readonly FeatureDefinition[];
  readonly format: SettingsFormat;
  readonly store: LocalStore;
  readonly now: () => number;
  // 서비스 워커가 처음 실행될 때 바로 걸어야 하는 Chrome 이벤트를 건다.
  readonly listenRequests: (
    handle: (message: unknown, sender: Sender) => Promise<unknown>,
  ) => unknown;
  readonly onInstalled: (listener: () => void) => void;
  // 열린 탭의 옛 스크립트에게 물러나라고 알린다(결정 0008).
  readonly retireOldScripts: () => Promise<void>;
}

export function startBackground(deps: BackgroundDeps): void {
  const problems = createProblemLog({ store: deps.store, now: deps.now });
  const record = (problem: Parameters<typeof problems.record>[0]) => {
    // 기록을 못 남겨도 할 수 있는 일이 없다. 기록 실패는 기능에 영향이 없다.
    problems.record(problem).catch(() => undefined);
  };
  const settings = createSettingsStore({
    store: deps.store,
    now: deps.now,
    format: deps.format,
    features: deps.features,
    record,
  });
  const router = createRouter(
    [
      route(settingsUpdate, (payload) => settings.updateFeature(payload.featureId, payload.patch)),
      route(storageEnsureReady, () => settings.ensureReady()),
      route(problemReport, async (payload) => {
        await problems.record(payload);
        return ok(null);
      }),
    ],
    () => {
      record({ featureId: null, kind: 'unexpected' });
    },
  );
  deps.listenRequests(router);
  deps.onInstalled(() => {
    deps.retireOldScripts().catch(() => {
      record({ featureId: null, kind: 'platform' });
    });
  });
  // 서비스 워커가 시작할 때 설정을 준비한다(처음 설치, 손상, 옛 형식).
  settings.ensureReady().catch(() => {
    record({ featureId: null, kind: 'platform' });
  });
}
