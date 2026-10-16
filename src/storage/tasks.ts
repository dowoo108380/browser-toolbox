import * as z from 'zod/mini';
import { type AppError, type Result, err, errorKinds, ok } from '../shared/index.ts';

// 탭마다 작업 하나의 기록(COM-10, 결정 0012, 0024). storage.session의 tasks 키 하나에 탭 id(문자열) → 그 탭의 작업으로
// 둔다. 쓰는 곳은 서비스 워커 하나다. storage.session은 확장을 다시 불러오거나 갱신하거나 브라우저를 다시 시작하면 비므로
// 이 모양은 판 사이에 이어지지 않는다(형식 버전이 없다).
// 여기 함수는 기록을 받아 새 기록을 만드는 순수 함수다. 받은 기록을 고치지 않는다.

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
