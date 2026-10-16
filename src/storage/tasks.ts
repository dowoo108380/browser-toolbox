import * as z from 'zod/mini';
import type { KeyValueStore } from '../platform/index.ts';
import { type AppError, type Result, appError, err, errorKinds, ok } from '../shared/index.ts';

// 탭마다 작업 하나의 기록(COM-10, 결정 0012, 0024). storage.session의 tasks 키 하나에 탭 id(문자열) → 그 탭의 작업으로
// 둔다. 쓰는 곳은 서비스 워커 하나다. storage.session은 확장을 다시 불러오거나 갱신하거나 브라우저를 다시 시작하면 비므로
// 이 모양은 판 사이에 이어지지 않는다(형식 버전이 없다).
// 기록을 바꾸는 함수는 기록을 받아 새 기록을 만드는 순수 함수다. 받은 기록을 고치지 않는다. watchTask는 확장 화면이 읽는 도우미다.

export const tasksKey = 'tasks';

// 단계마다 그 단계의 값만 둔다(quality 055). 취소는 실패의 한 종류(오류 종류 cancelled)다.
export type TaskRecord =
  | { readonly id: string; readonly featureId: string; readonly status: 'running' }
  | {
      readonly id: string;
      readonly featureId: string;
      readonly status: 'succeeded';
      // 짧은 결과(예: 저장한 파일 이름). 페이지 주소, 쿠키, 자막 본문은 넣지 않는다(COM-10 기대 동작 2).
      readonly summary: string | null;
    }
  | {
      readonly id: string;
      readonly featureId: string;
      readonly status: 'failed';
      readonly error: AppError;
    };

export type TaskRecords = Readonly<Record<string, TaskRecord>>;

// 작업의 일이 돌려준 끝.
export type TaskOutcome = Result<{ readonly summary: string | null }, AppError>;

const errorSchema = z.object({ kind: z.enum(errorKinds), message: z.string() });

const recordSchema: z.ZodMiniType<TaskRecord> = z.union([
  z.object({ id: z.string(), featureId: z.string(), status: z.literal('running') }),
  z.object({
    id: z.string(),
    featureId: z.string(),
    status: z.literal('succeeded'),
    summary: z.nullable(z.string()),
  }),
  z.object({
    id: z.string(),
    featureId: z.string(),
    status: z.literal('failed'),
    error: errorSchema,
  }),
]);

const recordsSchema: z.ZodMiniType<TaskRecords> = z.record(z.string(), recordSchema);

// 읽은 값. 없으면 빈 기록이고, 모양이 틀리면 null이다(쓰는 곳이 하나라 틀린 값은 결함이다).
export function parseTasks(raw: unknown): TaskRecords | null {
  if (raw === undefined) return {};
  const parsed = recordsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const keyOf = (tabId: number) => String(tabId);

// 그 탭의 작업. 없으면 null이다.
export function taskOf(records: TaskRecords, tabId: number): TaskRecord | null {
  return records[keyOf(tabId)] ?? null;
}

// 그 탭에서 작업을 시작한 기록. 진행 중인 작업이 있으면 시작하지 않고 그 작업을 돌려준다(결정 0012). 끝난 이전 결과는
// 새 작업으로 바뀐다. 작업은 팝업에서만 시작하고 팝업은 열 때 결과를 보이므로 이미 보인 것이다.
export function startTask(
  records: TaskRecords,
  tabId: number,
  task: { readonly id: string; readonly featureId: string },
): Result<TaskRecords, TaskRecord> {
  const current = taskOf(records, tabId);
  if (current?.status === 'running') return err(current);
  return ok({ ...records, [keyOf(tabId)]: { ...task, status: 'running' } });
}

// 작업 id인 작업이 끝난 기록. 그 탭의 기록이 그 작업의 진행 중이 아니면(탭을 닫음, 새 작업이 시작됨) null이다.
// 늦게 온 결과가 다른 작업의 기록을 바꾸지 않는다.
export function finishTask(
  records: TaskRecords,
  tabId: number,
  id: string,
  outcome: TaskOutcome,
): TaskRecords | null {
  const current = taskOf(records, tabId);
  if (current?.status !== 'running' || current.id !== id) return null;
  const { featureId } = current;
  const finished: TaskRecord = outcome.ok
    ? { id, featureId, status: 'succeeded', summary: outcome.value.summary }
    : { id, featureId, status: 'failed', error: outcome.error };
  return { ...records, [keyOf(tabId)]: finished };
}

// 그 탭의 기록을 지운 것(탭이 닫힘).
export function withoutTab(records: TaskRecords, tabId: number): TaskRecords {
  return Object.fromEntries(Object.entries(records).filter(([key]) => key !== keyOf(tabId)));
}

// 서비스 워커가 다시 시작할 때 고친 기록(결정 0024). 열려 있지 않은 탭의 기록은 지운다(닫힘을 놓친 경우). 진행 중이던
// 작업은 앞 서비스 워커의 메모리에만 있던 일이라 이어 할 수 없으므로 error로 끝낸다. 그대로 두면 그 탭에서 다시는 작업을
// 시작할 수 없다. 그렇게 끝낸 작업을 함께 돌려준다.
export function recoveredTasks(
  records: TaskRecords,
  isOpen: (tabId: number) => boolean,
  error: AppError,
): { readonly records: TaskRecords; readonly interrupted: readonly TaskRecord[] } {
  const interrupted: TaskRecord[] = [];
  const entries = Object.entries(records)
    .filter(([key]) => isOpen(Number(key)))
    .map(([key, task]): [string, TaskRecord] => {
      if (task.status !== 'running') return [key, task];
      const failed: TaskRecord = {
        id: task.id,
        featureId: task.featureId,
        status: 'failed',
        error,
      };
      interrupted.push(failed);
      return [key, failed];
    });
  return { records: Object.fromEntries(entries), interrupted };
}

// 사용자가 팝업에서 작업 id인 결과를 보았다. 그 탭의 기록이 같은 작업이고 끝났을 때만 지운다. id가 다르거나(늦게 닿은
// 확인) 진행 중이면 null이다. 그래서 확인은 자기가 본 결과에만 작용한다(결정 0012, COM-10.8).
export function seenTask(records: TaskRecords, tabId: number, id: string): TaskRecords | null {
  const current = taskOf(records, tabId);
  if (current?.id !== id || current.status === 'running') return null;
  return withoutTab(records, tabId);
}

export interface TaskWatchHandlers {
  // 그 탭의 작업. 없으면 null이다.
  readonly task: (record: TaskRecord | null) => void;
  readonly problem: (error: AppError) => void;
}

// 확장 화면이 그 탭의 작업 기록을 읽는다. 바뀜 알림을 먼저 듣고 읽는다. 알림이 읽기 결과보다 먼저 오면 읽기 결과(더 옛
// 값일 수 있다)는 버린다. 모양이 틀린 기록은 작업이 없는 것으로 보인다(쓰는 서비스 워커가 기록한다). 그만둔 뒤에는
// 알리지 않는다(COM-7): 바뀜 듣기를 그만두고, 그 뒤에 끝난 읽기는 버린다.
export function watchTask(
  store: Pick<KeyValueStore, 'get' | 'onChanged'>,
  tabId: number,
  handlers: TaskWatchHandlers,
): () => void {
  let stopped = false;
  let changed = false;
  const receive = (raw: unknown) => {
    const records = parseTasks(raw);
    handlers.task(records === null ? null : taskOf(records, tabId));
  };
  const unsubscribe = store.onChanged(tasksKey, (raw) => {
    changed = true;
    receive(raw);
  });
  store.get(tasksKey).then(
    (raw) => {
      if (!stopped && !changed) receive(raw);
    },
    () => {
      if (!stopped) handlers.problem(appError('platform', '작업 기록을 읽지 못했다.'));
    },
  );
  return () => {
    stopped = true;
    unsubscribe();
  };
}
