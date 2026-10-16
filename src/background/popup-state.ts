import type { Category } from '../contracts/index.ts';
import type { LocalStore } from '../platform/index.ts';
import { type AppError, type Result, appError, err, ok } from '../shared/index.ts';
import { popupStateKey, popupStateOf } from '../storage/index.ts';
import type { Problem } from './problems.ts';

// 팝업이 고른 범주를 남긴다(결정 0023). 값 하나를 통째로 쓰므로 마지막에 쓴 것이 남는다.

export interface PopupState {
  readonly remember: (category: Category) => Promise<Result<null, AppError>>;
}

export function createPopupState(deps: {
  readonly store: LocalStore;
  readonly record: (problem: Problem) => void;
}): PopupState {
  return {
    remember: async (category) => {
      try {
        await deps.store.set({ [popupStateKey]: popupStateOf(category) });
        return ok(null);
      } catch {
        // 팝업은 이 실패를 보이지 않으므로(편의 값) 여기서 기록한다(quality 067).
        deps.record({ featureId: null, kind: 'platform' });
        return err(appError('platform', '마지막으로 고른 범주를 남기지 못했다.'));
      }
    },
  };
}
