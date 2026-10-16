import type { ActionFeature } from '../contracts/index.ts';
import type { TaskOutcome } from '../storage/index.ts';

// 실행 기능의 서비스 워커 쪽 일(features/<기능>/background.ts)이 작업 실행에 내놓는 모양(결정 0024).

export interface TaskContext {
  // 작업을 시작한 탭.
  readonly tabId: number;
  // 제한 시간을 넘기거나 그 탭이 닫히면 멈춘다. 일은 이것을 보고 다음 일을 시작하지 않는다(quality 068).
  readonly signal: AbortSignal;
}

export interface TaskPart {
  readonly featureId: string;
  // 작업 하나를 끝까지 하고 끝을 돌려준다. 예상할 수 있는 실패는 결과 값으로 돌려준다(quality 063). 던진 예외는 작업
  // 실행이 받아 unexpected로 끝낸다.
  readonly run: (context: TaskContext) => Promise<TaskOutcome>;
}

export function defineTaskPart(
  definition: ActionFeature,
  run: (context: TaskContext) => Promise<TaskOutcome>,
): TaskPart {
  return { featureId: definition.id, run };
}
