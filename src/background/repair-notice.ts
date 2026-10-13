import type { LocalStore } from '../platform/index.ts';
import {
  type AppError,
  type Result,
  appError,
  createSerialQueue,
  err,
  ok,
} from '../shared/index.ts';
import {
  type RepairNotice,
  type RepairScope,
  addRepair,
  dismissRepair,
  parseRepairNotice,
  repairNoticeKey,
} from '../storage/index.ts';

// 설정 복구 알림을 쓰는 곳은 이것 하나다(결정 0016). 읽고-고치고-쓰기를 들어온 순서대로 하나씩 한다.

export interface RepairNoticeLog {
  // 고쳐 쓸 범위를 더한다. 설정 저장이 고쳐 쓰기 전에 부른다.
  readonly add: (scope: RepairScope) => Promise<Result<null, AppError>>;
  // 사용자가 stamp인 기록을 확인했다. 그 뒤에 더해진 손상이 있으면 지우지 않는다.
  readonly dismiss: (stamp: number) => Promise<Result<null, AppError>>;
}

export function createRepairNoticeLog(deps: {
  readonly store: LocalStore;
  readonly now: () => number;
}): RepairNoticeLog {
  const enqueue = createSerialQueue();

  const update = (
    change: (previous: RepairNotice | null) => RepairNotice | null,
    failure: string,
  ): Promise<Result<null, AppError>> =>
    enqueue(async () => {
      try {
        const next = change(parseRepairNotice(await deps.store.get(repairNoticeKey)));
        if (next !== null) await deps.store.set({ [repairNoticeKey]: next });
        return ok(null);
      } catch {
        return err(appError('platform', failure));
      }
    });

  return {
    add: (scope) =>
      update(
        (previous) => addRepair(previous, scope, deps.now()),
        '설정 복구 알림을 남기지 못했다.',
      ),
    dismiss: (stamp) =>
      update(
        (previous) => dismissRepair(previous, stamp, deps.now()),
        '설정 복구 알림을 지우지 못했다. 다시 확인을 누른다.',
      ),
  };
}
