import {
  type ActionFeature,
  type FeatureDefinition,
  actionOf,
  noticeTextLimit,
} from '../contracts/index.ts';
import type { Delivery, KeyValueStore, TabBadge } from '../platform/index.ts';
import {
  type AppError,
  type ErrorKind,
  type Result,
  appError,
  createSerialQueue,
  err,
  ok,
  withTimeout,
} from '../shared/index.ts';
import {
  type TaskOutcome,
  type TaskRecord,
  type TaskRecords,
  finishTask,
  parseTasks,
  recoveredTasks,
  seenTask,
  startTask,
  taskOf,
  taskText,
  tasksKey,
  withoutTab,
} from '../storage/index.ts';
import { partsByFeature } from './parts.ts';
import type { Problem } from './problems.ts';
import { strings } from './strings.ts';
import type { TaskPart, TaskServices, TaskWork } from './task-part.ts';

// 실행 기능의 작업을 탭마다 하나씩 끝까지 하고 그 기록을 쓴다(COM-10, 결정 0012, 0024). 작업 기록을 쓰는 곳은 이것 하나다.
// 기록의 읽고-고치고-쓰기는 들어온 순서대로 하나씩 한다. 일은 그 줄 밖에서 돌고, 끝나면 줄에 서서 결과를 쓴다.
// 배지와 탭 사건 듣기는 기록을 쓸 때마다 같은 줄에서 기록에 맞춘다(배지는 기록에서 계산한다, 0012). 배지는 기록과 다른
// Chrome API라 그 사이에 서비스 워커가 멈출 수 있다. 그래서 기록이 배지보다 먼저 생기고 나중에 없어지게 쓰고, 서비스 워커가
// 시작할 때 남은 기록마다 배지를 다시 단다(결정 0038).

export interface TaskRunnerDeps {
  readonly session: KeyValueStore;
  readonly features: readonly FeatureDefinition[];
  readonly parts: readonly TaskPart[];
  // 실행 기능의 일이 쓰는 서비스(결정 0046). 일마다 시작할 때 한 번 넘긴다.
  readonly services: TaskServices;
  // 작업 id. 서비스 워커는 crypto.randomUUID()를 쓴다(확장의 출처라 늘 보안 문맥이다).
  readonly randomId: () => string;
  // 그 탭이 열려 있는지. 닫힌 탭이면 거짓이고, 묻지 못하면(그 밖의 거절) 던진다.
  readonly tabExists: (tabId: number) => Promise<boolean>;
  // 그 탭의 확장 아이콘에 배지와 제목을 단다. null이면 지운다. 닫힌 탭이면 할 일이 없다.
  readonly badge: (tabId: number, badge: TabBadge | null) => Promise<void>;
  // 탭 닫힘과 이동을 들을지. 작업 기록이 있는 동안만 듣는다(결정 0024).
  readonly listenTabs: (on: boolean) => void;
  // 그 탭을 보는 팝업이 열려 있는지(팝업의 연결, 결정 0024).
  readonly popupViewing: (tabId: number) => boolean;
  // 그 탭이 창의 지금 탭인지. 닫힌 탭이면 거짓이고, 묻지 못하면 던진다.
  readonly isTabActive: (tabId: number) => Promise<boolean>;
  // 그 탭의 최상위 프레임에 결과를 짧게 보이라고 한다(task.notice).
  readonly notify: (tabId: number, text: string) => Promise<Delivery>;
  readonly record: (problem: Problem) => void;
}

export interface TaskRunner {
  // 그 탭에서 그 기능의 작업 종류(결정 0046)로 작업을 시작하고 작업 id로 답한다. 일은 응답과 따로 끝까지 한다.
  readonly start: (
    featureId: string,
    action: string,
    tabId: number,
  ) => Promise<Result<{ readonly taskId: string }, AppError>>;
  // 팝업이 그 탭의 끝난 작업을 보였다. 그 탭의 기록이 같은 작업이고 끝났을 때만 지운다(결정 0012).
  readonly seen: (tabId: number, taskId: string) => Promise<Result<null, AppError>>;
  // 탭이 닫혔다. 그 탭의 기록을 지우고 진행 중이던 일에 멈춤 신호를 보낸다(COM-10.6).
  readonly tabRemoved: (tabId: number) => Promise<void>;
  // 탭이 다른 문서로 이동했다. Chrome이 지운 배지와 제목을 기록대로 다시 단다(결정 0024의 실험 1).
  readonly tabNavigated: (tabId: number) => Promise<void>;
  // 서비스 워커가 시작할 때 앞 서비스 워커가 남긴 기록을 고친다: 닫힌 탭의 기록을 지우고, 진행 중이던 작업은 그 기능의 일이 그
  // 탭에 남긴 상태를 치운 뒤(interrupted, 결정 0038) 끝낸다.
  readonly recover: () => Promise<void>;
}

// 문제 기록에 남기지 않는 실패. 고장이 아니라 상황(쓸 수 없는 페이지 등)이나 사용자의 일을 알리는 종류다(결정 0024).
const situationalKinds: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
  'unavailable',
  'invalid-input',
  'cancelled',
]);

// 끝났고 아직 보지 않은 작업의 배지. 바탕색은 흰 글자와의 명도 대비가 4.5:1을 넘는다.
const marks = {
  succeeded: { text: '✓', color: '#1a7f37' },
  failed: { text: '!', color: '#c62828' },
} as const;

// 탭 사건을 들어야 하는지. 작업 기록(진행 중이거나 아직 보지 않은 결과)이 있는 동안만 듣는다(결정 0024).
const hasTasks = (records: TaskRecords) => Object.keys(records).length > 0;

// 앞 서비스 워커가 끝내지 못한 작업의 상태를 치우는 한도(탭마다). 페이지가 주 스레드를 붙잡고 있으면 페이지에 넣는 함수가 끝나지
// 않을 수 있다(R-27). 넘기면 그 상태는 그대로 두고 기록을 끝낸다.
const interruptTimeoutMs = 5000;

// 실행 기능마다 일이 꼭 하나 있어야 한다(parts.ts). 일은 서비스를 받아 시작한다.
function worksByFeature(
  features: readonly FeatureDefinition[],
  parts: readonly TaskPart[],
  services: TaskServices,
): ReadonlyMap<string, { readonly feature: ActionFeature; readonly work: TaskWork }> {
  const matched = partsByFeature(
    features.filter((feature) => feature.kind === 'action'),
    parts,
    {
      orphan: (featureId) => `작업의 일 ${featureId}에 맞는 실행 기능이 없다.`,
      count: (featureId, count) => `실행 기능 ${featureId}의 일이 ${String(count)}개다.`,
    },
  );
  return new Map(
    [...matched].map(([featureId, { feature, part }]) => [
      featureId,
      { feature, work: part.start(services) },
    ]),
  );
}

export function createTaskRunner(deps: TaskRunnerDeps): TaskRunner {
  const actions = worksByFeature(deps.features, deps.parts, deps.services);
  const enqueue = createSerialQueue();
  // 이 서비스 워커에서 도는 일. 작업 id → 그 탭과 멈춤 단추. 탭이 닫히면 멈춘다.
  const running = new Map<string, { readonly tabId: number; readonly stop: AbortController }>();

  // 작업의 이름은 그 작업 종류의 이름이다(결정 0046). 모르는 기능이나 종류면 기능 이름, 그것도 없으면 id다.
  const nameOf = (task: Pick<TaskRecord, 'featureId' | 'action'>) => {
    const action = actions.get(task.featureId);
    return (
      (action === undefined ? null : actionOf(action.feature, task.action)?.name) ??
      deps.features.find((feature) => feature.id === task.featureId)?.name ??
      task.featureId
    );
  };

  const badgeOf = (task: TaskRecord | null): TabBadge | null => {
    if (task === null || task.status === 'running') return null;
    return {
      ...marks[task.status],
      title: strings.badgeTitle[task.status](nameOf(task)),
    };
  };

  // 그 탭에 그 기록의 배지를 단다. 달지 못하면 거짓이다.
  const applyBadge = async (tabId: number, task: TaskRecord | null): Promise<boolean> => {
    try {
      await deps.badge(tabId, badgeOf(task));
      return true;
    } catch {
      return false;
    }
  };

  // 기록이 있는 탭의 배지를 그 기록에 맞춘다. 달지 못해도 기록은 맞다. 숨기지 않고 기록한다(quality 067). 빠진 배지는 그
  // 탭이 이동할 때나 다음 서비스 워커가 시작할 때 다시 단다.
  const showBadge = async (tabId: number, task: TaskRecord) => {
    const shown = await applyBadge(tabId, task);
    if (!shown) deps.record({ featureId: task.featureId, kind: 'platform' });
  };

  // 읽은 기록의 모양이 틀리면 결함이다(쓰는 곳이 여기 하나다). 기록하고 빈 기록에서 다시 시작한다(결정 0024).
  const load = async (): Promise<Result<TaskRecords, AppError>> => {
    let raw: unknown;
    try {
      raw = await deps.session.get(tasksKey);
    } catch {
      return err(appError('platform', strings.readFailed));
    }
    const records = parseTasks(raw);
    if (records !== null) return ok(records);
    deps.record({ featureId: null, kind: 'unexpected' });
    return ok({});
  };

  // 그 탭들 가운데 기록이 있는 탭의 배지를 기록에 맞춘다.
  const showBadges = async (records: TaskRecords, tabIds: readonly number[]) => {
    for (const tabId of tabIds) {
      const task = taskOf(records, tabId);
      if (task !== null) await showBadge(tabId, task);
    }
  };

  // 기록을 쓰고, 그 탭들(열린 탭)의 배지와 탭 사건 듣기를 새 기록에 맞춘다. 기록이 배지보다 먼저 생기고 나중에 없어지게
  // 한다(결정 0038): 기록을 지우는 탭은 배지를 먼저 지우고, 지우지 못하면 기록도 지우지 않는다. 기록이 남는 탭은 쓴 뒤에
  // 배지를 맞춘다. 그래서 그 사이에 서비스 워커가 멈춰도 기록이 없는 탭에는 배지가 남지 않고, 기록과 어긋난 배지는 다음
  // 시작이 맞춘다(recover). 배지를 지운 뒤 기록을 쓰지 못하면 그 결과는 배지 없이 기록에 남는다(팝업은 다음에 열 때 다시
  // 보이고, 다음 시작이 배지를 다시 단다).
  const commit = async (
    records: TaskRecords,
    tabIds: readonly number[],
  ): Promise<Result<null, AppError>> => {
    for (const tabId of tabIds) {
      if (taskOf(records, tabId) === null && !(await applyBadge(tabId, null))) {
        return err(appError('platform', strings.badgeFailed));
      }
    }
    try {
      await deps.session.set({ [tasksKey]: records });
    } catch {
      return err(appError('platform', strings.writeFailed));
    }
    deps.listenTabs(hasTasks(records));
    await showBadges(records, tabIds);
    return ok(null);
  };

  // 일을 제한 시간 안에서 한다. 탭이 닫혀도 멈춘다. 던진 예외도 끝으로 바꾼다. 늦게 온 결과는 withTimeout이 버린다.
  const runPart = async (
    feature: ActionFeature,
    work: TaskWork,
    tabId: number,
    action: string,
    stop: AbortSignal,
  ): Promise<TaskOutcome> => {
    const timed = await withTimeout(feature.task.timeoutMs, async (timeout) => {
      try {
        return await work.run({ tabId, action, signal: AbortSignal.any([timeout, stop]) });
      } catch {
        return err(appError('unexpected', strings.unexpected));
      }
    });
    if (timed.done) return timed.value;
    return err(appError('timeout', strings.timeout(Math.ceil(feature.task.timeoutMs / 1000))));
  };

  // 끝을 쓴다. 그 탭의 기록이 이 작업일 때만 쓰고, 그때만 실패를 문제로 남긴다. 탭을 닫아 생긴 실패를 고장으로 남기지 않는다.
  // 끝을 쓰지 못하면 기록은 진행 중으로 남는다. 서비스 워커가 다시 시작할 때 고친다(recover).
  // 쓴 끝(그 탭의 새 기록)을 돌려준다. 쓰지 않았으면 null이다.
  const finish = (featureId: string, tabId: number, id: string, outcome: TaskOutcome) =>
    enqueue(async (): Promise<TaskRecord | null> => {
      const loaded = await load();
      if (!loaded.ok) {
        deps.record({ featureId, kind: 'platform' });
        return null;
      }
      const next = finishTask(loaded.value, tabId, id, outcome);
      if (next === null) return null;
      const committed = await commit(next, [tabId]);
      if (!committed.ok) {
        deps.record({ featureId, kind: 'platform' });
        return null;
      }
      if (!outcome.ok && !situationalKinds.has(outcome.error.kind)) {
        deps.record({ featureId, kind: outcome.error.kind });
      }
      return taskOf(next, tabId);
    });

  // 팝업이 닫힌 동안 끝났고 그 탭이 창의 지금 탭이면 페이지 위에 알린다(COM-10 기대 동작 4). 줄 밖에서 한다. 페이지가
  // 붙잡혀 답이 늦어도 다른 일이 기다리지 않는다. 받는 쪽이 없는 탭은 배지만 쓰는 경우라 기록하지 않는다.
  const announce = async (tabId: number, task: TaskRecord) => {
    if (task.status === 'running' || deps.popupViewing(tabId)) return;
    const active = await deps.isTabActive(tabId).catch(() => null);
    if (active === null) {
      // 알릴지 정하지 못했다. 배지는 이미 달았으므로 알리지 않고 까닭을 남긴다(quality 067).
      deps.record({ featureId: task.featureId, kind: 'platform' });
      return;
    }
    if (!active) return;
    const text = taskText(task, nameOf(task));
    const delivery = await deps.notify(tabId, text.slice(0, noticeTextLimit));
    if (delivery === 'timeout' || delivery === 'failed') {
      deps.record({
        featureId: task.featureId,
        kind: delivery === 'timeout' ? 'timeout' : 'platform',
      });
    }
  };

  // 탭이 열려 있고 그 탭에 진행 중인 작업이 없으면 진행 중을 쓰고 일을 시작한다. 줄 안에서 읽은 기록으로 부른다.
  const begin = async (
    { feature, work }: { readonly feature: ActionFeature; readonly work: TaskWork },
    action: string,
    tabId: number,
    records: TaskRecords,
  ): Promise<Result<{ readonly taskId: string }, AppError>> => {
    // 탭을 묻지 못하면 시작하지 않는다. 그 이유는 팝업이 보인다.
    const open = await deps.tabExists(tabId).catch(() => null);
    if (open === null) return err(appError('platform', strings.tabUnknown));
    if (!open) return err(appError('unavailable', strings.noTab));
    const id = deps.randomId();
    const started = startTask(records, tabId, { id, featureId: feature.id, action });
    if (!started.ok) return err(appError('unavailable', strings.running(nameOf(started.error))));
    // 이전 결과의 배지는 새 작업의 기록으로 지워진다(진행 중에는 배지가 없다).
    const committed = await commit(started.value, [tabId]);
    if (!committed.ok) return committed;
    // 일은 줄 밖에서 돈다. 그동안 다른 탭의 시작과 확인이 기다리지 않는다.
    const stop = new AbortController();
    running.set(id, { tabId, stop });
    // 이 사슬의 끝을 기다리는 쪽이 없으므로, 끝을 쓰고 알리다 난 예상하지 못한 예외는 여기서 기록한다(quality 067).
    void runPart(feature, work, tabId, action, stop.signal)
      .then((outcome) => {
        running.delete(id);
        return finish(feature.id, tabId, id, outcome);
      })
      .then((ended) => (ended === null ? undefined : announce(tabId, ended)))
      .catch(() => {
        deps.record({ featureId: feature.id, kind: 'unexpected' });
      });
    return ok({ taskId: id });
  };

  return {
    start: (featureId, actionId, tabId) =>
      enqueue(async () => {
        const action = actions.get(featureId);
        if (action === undefined) return err(appError('invalid-input', strings.notAction));
        if (actionOf(action.feature, actionId) === null) {
          return err(appError('invalid-input', strings.unknownAction));
        }
        const loaded = await load();
        if (!loaded.ok) return loaded;
        // 탭이 있는지 보기 전부터 탭 사건을 듣는다. 기록이 없는 동안은 듣지 않으므로, 첫 기록을 쓴 뒤에야 들으면 그 사이에
        // 닫힌 탭을 놓쳐 닫힌 탭에서 멈춤 신호 없이 일을 하고 그 기록이 남는다(COM-10.6). 그 사이에 들은 닫힘은 이 줄 뒤에
        // 서서 이 작업을 멈추고 기록을 지운다(tabRemoved). 시작하지 않았으면 읽은 기록에 맞춰 되돌린다.
        deps.listenTabs(true);
        const begun = await begin(action, actionId, tabId, loaded.value);
        if (!begun.ok) deps.listenTabs(hasTasks(loaded.value));
        return begun;
      }),

    // 팝업은 확인의 실패를 보이지 않으므로(지우지 못한 결과는 다음에 열 때 다시 보인다) 여기서 기록한다(quality 067).
    seen: (tabId, taskId) =>
      enqueue(async () => {
        const loaded = await load();
        if (!loaded.ok) {
          deps.record({ featureId: null, kind: 'platform' });
          return loaded;
        }
        const next = seenTask(loaded.value, tabId, taskId);
        if (next === null) return ok(null);
        const committed = await commit(next, [tabId]);
        if (!committed.ok) deps.record({ featureId: null, kind: 'platform' });
        return committed;
      }),

    tabRemoved: (tabId) =>
      enqueue(async () => {
        for (const task of running.values()) if (task.tabId === tabId) task.stop.abort();
        const loaded = await load();
        if (!loaded.ok) {
          deps.record({ featureId: null, kind: 'platform' });
          return;
        }
        if (taskOf(loaded.value, tabId) === null) return;
        // 닫힌 탭에는 배지를 달 수 없고 Chrome이 지운다.
        const committed = await commit(withoutTab(loaded.value, tabId), []);
        if (!committed.ok) deps.record({ featureId: null, kind: 'platform' });
      }),

    tabNavigated: (tabId) =>
      enqueue(async () => {
        const loaded = await load();
        if (!loaded.ok) {
          // 배지를 다시 달지 못한다. 이 사건을 기다리는 쪽이 없으므로 까닭을 남긴다(quality 067).
          deps.record({ featureId: null, kind: 'platform' });
          return;
        }
        const task = taskOf(loaded.value, tabId);
        if (task !== null && task.status !== 'running') await showBadge(tabId, task);
      }),

    recover: () =>
      enqueue(async () => {
        const loaded = await load();
        if (!loaded.ok) {
          // 읽지 못하면 탭 사건을 그대로 듣는다(처음에 듣고 있다). 기록이 있을 수 있기 때문이다.
          deps.record({ featureId: null, kind: 'platform' });
          return;
        }
        const tabIds = Object.keys(loaded.value).map(Number);
        const open = new Set<number>();
        for (const tabId of tabIds) {
          const exists = await deps.tabExists(tabId).catch(() => null);
          if (exists === null) {
            // 탭을 묻지 못하면 열린 탭의 기록을 지울 수 있으므로 고치지 않는다. 읽지 못한 것과 같이 다음 시작에 고친다.
            deps.record({ featureId: null, kind: 'platform' });
            return;
          }
          if (exists) open.add(tabId);
        }
        // 진행 중으로 남은 작업은 그 기능의 일이 그 탭에 남긴 상태를 먼저 치운다(기록이 상태보다 나중에 없어진다, 결정 0038).
        for (const [key, task] of Object.entries(loaded.value)) {
          const tabId = Number(key);
          if (task.status !== 'running' || !open.has(tabId)) continue;
          const work = actions.get(task.featureId)?.work;
          if (work === undefined) continue;
          const cleaned = await withTimeout(interruptTimeoutMs, () =>
            work.interrupted(tabId).catch(() => {
              deps.record({ featureId: task.featureId, kind: 'unexpected' });
            }),
          );
          if (!cleaned.done) deps.record({ featureId: task.featureId, kind: 'timeout' });
        }
        const { records, interrupted } = recoveredTasks(
          loaded.value,
          (tabId) => open.has(tabId),
          appError('unexpected', strings.interrupted),
        );
        // 남은 기록의 탭마다 배지를 다시 단다(끝낸 작업은 실패 배지). 앞 서비스 워커가 기록을 쓴 뒤 배지를 바꾸기 전에
        // 멈췄으면 배지가 빠지거나 낡았다. 기록이 없는 탭에는 배지가 남지 않으므로(commit) 기록이 있는 탭만 보면 되고, 모든
        // 탭을 묻지 않는다(결정 0038). 닫힌 탭은 Chrome이 배지를 지웠다.
        const openTabs = [...open];
        // 고칠 것이 없으면 쓰지 않는다(서비스 워커는 자주 다시 시작한다).
        if (interrupted.length === 0 && open.size === tabIds.length) {
          deps.listenTabs(hasTasks(records));
          await showBadges(records, openTabs);
          return;
        }
        const committed = await commit(records, openTabs);
        if (!committed.ok) {
          deps.record({ featureId: null, kind: 'platform' });
          return;
        }
        for (const task of interrupted)
          deps.record({ featureId: task.featureId, kind: 'unexpected' });
      }),
  };
}
