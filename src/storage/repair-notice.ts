import * as z from 'zod/mini';
import type { LocalStore } from '../platform/index.ts';
import { type AppError, appError } from '../shared/index.ts';
import { type Repair, nextRevision } from './write.ts';

// 설정 복구 알림(결정 0016). 서비스 워커는 손상된 설정을 기본값으로 고쳐 쓰기 전에 무엇을 바꾸는지 여기에 남기고,
// 팝업은 사용자가 확인할 때까지 보인다. 서비스 워커가 먼저 고쳐 쓰면 화면은 고친 값만 읽으므로,
// 이 기록이 없으면 사용자가 손상을 알 수 없다(COM-3 기대 동작 4, COM-3.4).

export const repairNoticeKey = 'repairNotice';

// 기본값으로 바꾼 범위: 설정 전체인지와, 기본값으로 바꾼 기능 id.
export interface RepairScope {
  readonly whole: boolean;
  readonly features: readonly string[];
}

export interface RepairNotice extends RepairScope {
  // 서비스 워커가 이 기록을 쓸 때마다 앞의 값보다 커진다. 읽는 쪽은 더 큰 기록만 받고,
  // 확인은 사용자가 본 기록에만 작용한다(그 뒤에 더해진 손상을 지우지 않는다).
  readonly stamp: number;
}

export const noRepair: RepairScope = { whole: false, features: [] };

const noticeSchema = z.object({
  stamp: z.int().check(z.minimum(1)),
  whole: z.boolean(),
  features: z.array(z.string()),
});

// 기록이 없거나 형식이 틀리면 null이다. 이 기록은 알림을 돕는 것이라, 틀렸으면 없는 것으로 보고
// 서비스 워커가 다음에 새로 쓴다(문제 기록과 같다). 고친 사실 자체는 문제 기록에도 남는다.
export function parseRepairNotice(raw: unknown): RepairNotice | null {
  const parsed = noticeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function isEmptyRepair(scope: RepairScope): boolean {
  return !scope.whole && scope.features.length === 0;
}

// 두 범위를 합친다. 기능 id는 처음 나온 순서대로 한 번씩만 둔다.
export function mergeRepairs(first: RepairScope, second: RepairScope): RepairScope {
  return {
    whole: first.whole || second.whole,
    features: [...new Set([...first.features, ...second.features])],
  };
}

// 서비스 워커가 고쳐 쓰기 전에 사용자에게 알릴 범위. 설정이 없음과 형식 이전은 손상이 아니므로 알리지 않는다.
export function repairScopeOf(repairs: readonly Repair[]): RepairScope {
  return {
    whole: repairs.some((repair) => repair.kind === 'corrupt'),
    features: repairs.flatMap((repair) => (repair.kind === 'corruptItems' ? repair.items : [])),
  };
}

// 앞 기록에 새로 고친 범위를 더한 기록. 고칠 범위가 비었으면 null(쓰지 않는다).
// 이미 기록된 기능이나 설정 전체를 다시 고쳐도 새 stamp를 준다. 범위가 같아도 새 손상이므로, 앞 기록에 대한
// 늦은 확인이 이 기록을 지우지 않아야 한다(결정 0016).
// stamp는 설정의 세대 번호와 같은 방식으로 정한다: 앞의 값보다 크고, 기록이 없어졌다 다시 생겨도 지금 시각 이상이다.
export function addRepair(
  previous: RepairNotice | null,
  added: RepairScope,
  now: number,
): RepairNotice | null {
  if (isEmptyRepair(added)) return null;
  const base = previous ?? { stamp: 0, ...noRepair };
  return { stamp: nextRevision(base.stamp, now), ...mergeRepairs(base, added) };
}

// 사용자가 stamp인 기록을 확인했다. 지금 기록이 그것이 아니면(그 뒤에 손상이 더해짐) 지우지 않는다. 지울 것이 없으면 null.
export function dismissRepair(
  previous: RepairNotice | null,
  stamp: number,
  now: number,
): RepairNotice | null {
  if (previous?.stamp !== stamp || isEmptyRepair(previous)) return null;
  return { stamp: nextRevision(previous.stamp, now), ...noRepair };
}

export interface RepairNoticeHandlers {
  readonly notice: (notice: RepairNotice) => void;
  readonly problem: (error: AppError) => void;
}

// 확장 화면이 복구 알림을 읽는다. 바뀜 알림을 먼저 듣고 읽는다. 읽기 결과와 바뀜 알림의 순서에 기대지 않고
// stamp가 더 큰 기록만 받는다. 그만둔 뒤에는 알리지 않는다(COM-7).
export function watchRepairNotice(
  store: Pick<LocalStore, 'get' | 'onChanged'>,
  handlers: RepairNoticeHandlers,
): () => void {
  let accepted = 0;
  let stopped = false;
  const receive = (raw: unknown) => {
    if (stopped) return;
    const notice = parseRepairNotice(raw);
    if (notice === null || notice.stamp <= accepted) return;
    accepted = notice.stamp;
    handlers.notice(notice);
  };
  const unsubscribe = store.onChanged(repairNoticeKey, receive);
  store.get(repairNoticeKey).then(receive, () => {
    if (!stopped) handlers.problem(appError('platform', '설정 복구 알림을 읽지 못했다.'));
  });
  return () => {
    stopped = true;
    unsubscribe();
  };
}
