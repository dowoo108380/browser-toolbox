import type { ActionFeature, FeatureDefinition } from '../contracts/index.ts';
import type { KeyValueStore } from '../platform/index.ts';
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
  type TaskRecords,
  finishTask,
  parseTasks,
  seenTask,
  startTask,
  tasksKey,
} from '../storage/index.ts';
import type { Problem } from './problems.ts';
import { strings } from './strings.ts';
import type { TaskPart } from './task-part.ts';

// 실행 기능의 작업을 탭마다 하나씩 끝까지 하고 그 기록을 쓴다(COM-10, 결정 0012, 0024). 작업 기록을 쓰는 곳은 이것 하나다.
// 기록의 읽고-고치고-쓰기는 들어온 순서대로 하나씩 한다. 일은 그 줄 밖에서 돌고, 끝나면 줄에 서서 결과를 쓴다.

export interface TaskRunnerDeps {
  readonly session: KeyValueStore;
  readonly features: readonly FeatureDefinition[];
  readonly parts: readonly TaskPart[];
  // 작업 id. 서비스 워커는 crypto.randomUUID()를 쓴다(확장의 출처라 늘 보안 문맥이다).
  readonly randomId: () => string;
  readonly tabExists: (tabId: number) => Promise<boolean>;
  readonly record: (problem: Problem) => void;
}

export interface TaskRunner {
  // 그 탭에서 작업을 시작하고 작업 id로 답한다. 일은 응답과 따로 끝까지 한다.
  readonly start: (
    featureId: string,
    tabId: number,
  ) => Promise<Result<{ readonly taskId: string }, AppError>>;
  // 팝업이 그 탭의 끝난 작업을 보였다. 그 탭의 기록이 같은 작업이고 끝났을 때만 지운다(결정 0012).
  readonly seen: (tabId: number, taskId: string) => Promise<Result<null, AppError>>;
}

// 문제 기록에 남기지 않는 실패. 고장이 아니라 상황(쓸 수 없는 페이지 등)이나 사용자의 일을 알리는 종류다(결정 0024).
const situationalKinds: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
  'unavailable',
  'invalid-input',
  'cancelled',
]);

// 실행 기능마다 일이 꼭 하나 있어야 한다. 빠지거나 겹치면 결함이므로 시작할 때 드러낸다(quality 066).
function partsByFeature(
  features: readonly FeatureDefinition[],
  parts: readonly TaskPart[],
): ReadonlyMap<string, { readonly feature: ActionFeature; readonly part: TaskPart }> {
  const actions = features.filter((feature) => feature.kind === 'action');
  for (const part of parts) {
    if (!actions.some((feature) => feature.id === part.featureId)) {
      throw new Error(`작업의 일 ${part.featureId}에 맞는 실행 기능이 없다.`);
    }
  }
  return new Map(
    actions.map((feature) => {
      const matched = parts.filter((part) => part.featureId === feature.id);
      const [part] = matched;
      if (part === undefined || matched.length > 1) {
        throw new Error(`실행 기능 ${feature.id}의 일이 ${String(matched.length)}개다.`);
      }
      return [feature.id, { feature, part }];
    }),
  );
}

export function createTaskRunner(deps: TaskRunnerDeps): TaskRunner {
  const actions = partsByFeature(deps.features, deps.parts);
  const enqueue = createSerialQueue();

  const nameOf = (featureId: string) =>
    deps.features.find((feature) => feature.id === featureId)?.name ?? featureId;

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

  const save = async (records: TaskRecords): Promise<Result<null, AppError>> => {
    try {
      await deps.session.set({ [tasksKey]: records });
      return ok(null);
    } catch {
      return err(appError('platform', strings.writeFailed));
    }
  };

  // 일을 제한 시간 안에서 한다. 던진 예외도 끝으로 바꾼다. 늦게 온 결과는 withTimeout이 버린다.
  const runPart = async (
    feature: ActionFeature,
    part: TaskPart,
    tabId: number,
  ): Promise<TaskOutcome> => {
    const timed = await withTimeout(feature.task.timeoutMs, async (signal) => {
      try {
        return await part.run({ tabId, signal });
      } catch {
        return err(appError('unexpected', strings.unexpected));
      }
    });
    if (timed.done) return timed.value;
    return err(appError('timeout', strings.timeout(Math.ceil(feature.task.timeoutMs / 1000))));
  };

  // 끝을 쓴다. 그 탭의 기록이 이 작업일 때만 쓰고, 그때만 실패를 문제로 남긴다. 탭을 닫아 생긴 실패를 고장으로 남기지 않는다.
  // 끝을 쓰지 못하면 기록은 진행 중으로 남는다. 서비스 워커가 다시 시작할 때 고친다(결정 0024).
  const finish = (featureId: string, tabId: number, id: string, outcome: TaskOutcome) =>
    enqueue(async () => {
      const loaded = await load();
      if (!loaded.ok) {
        deps.record({ featureId, kind: 'platform' });
        return;
      }
      const next = finishTask(loaded.value, tabId, id, outcome);
      if (next === null) return;
      const saved = await save(next);
      if (!saved.ok) {
        deps.record({ featureId, kind: 'platform' });
        return;
      }
      if (!outcome.ok && !situationalKinds.has(outcome.error.kind)) {
        deps.record({ featureId, kind: outcome.error.kind });
      }
    });

  return {
    start: (featureId, tabId) =>
      enqueue(async () => {
        const action = actions.get(featureId);
        if (action === undefined) return err(appError('invalid-input', strings.notAction));
        if (!(await deps.tabExists(tabId))) return err(appError('unavailable', strings.noTab));
        const loaded = await load();
        if (!loaded.ok) return loaded;
        const id = deps.randomId();
        const started = startTask(loaded.value, tabId, { id, featureId });
        if (!started.ok) {
          return err(appError('unavailable', strings.running(nameOf(started.error.featureId))));
        }
        const saved = await save(started.value);
        if (!saved.ok) return saved;
        // 일은 줄 밖에서 돈다. 그동안 다른 탭의 시작과 확인이 기다리지 않는다.
        void runPart(action.feature, action.part, tabId).then((outcome) =>
          finish(featureId, tabId, id, outcome),
        );
        return ok({ taskId: id });
      }),

    seen: (tabId, taskId) =>
      enqueue(async () => {
        const loaded = await load();
        if (!loaded.ok) return loaded;
        const next = seenTask(loaded.value, tabId, taskId);
        return next === null ? ok(null) : save(next);
      }),
  };
}
