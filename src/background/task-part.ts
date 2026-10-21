import { type ActionFeature, actionOf } from '../contracts/index.ts';
import type { InjectedAnswer, TabInfo } from '../platform/index.ts';
import type { AppError, Result } from '../shared/index.ts';
import type { TaskOutcome } from '../storage/index.ts';
import type { DebuggerManager } from './debugger.ts';
import type { FileService } from './files.ts';
import type { Problem } from './problems.ts';

// 실행 기능의 서비스 워커 쪽 일(features/<기능>/background.ts)이 작업 실행에 내놓는 모양(결정 0024, 0046).

export interface TaskContext<A extends string = string> {
  // 작업을 시작한 탭.
  readonly tabId: number;
  // 그 기능의 작업 종류(ActionFeature의 actions의 id). 작업 실행이 그 기능의 종류인지 본 뒤 넘긴다.
  readonly action: A;
  // 제한 시간을 넘기거나 그 탭이 닫히면 멈춘다. 일은 이것을 보고 다음 일을 시작하지 않는다(quality 068).
  readonly signal: AbortSignal;
}

// 실행 기능이 쓰는 서비스 워커의 Chrome 경계와 공용 서비스(결정 0046). 진입점이 실제 것을, 시험이 가짜를 넣는다.
export interface TaskServices {
  readonly debuggers: DebuggerManager;
  readonly files: FileService;
  // 닫힌 탭이면 null이고, 묻지 못하면 던진다.
  readonly tabInfo: (tabId: number) => Promise<TabInfo | null>;
  // 누를 때 넣는 페이지 쪽 스크립트(아키텍처 2장)를 그 탭의 최상위 문서에 넣고, 그 일을 부른다(platform의 scripting).
  readonly injectScript: (tabId: number, file: string) => Promise<Result<null, AppError>>;
  readonly callInjected: (
    tabId: number,
    key: string,
    method: string,
    args: readonly unknown[],
  ) => Promise<Result<InjectedAnswer, AppError>>;
  // 창의 지금 탭의 보이는 화면(PNG data URL). 그 탭에 activeTab이 있어야 한다.
  readonly captureVisibleTab: (windowId: number) => Promise<Result<string, AppError>>;
  readonly now: () => number;
  readonly record: (problem: Problem) => void;
}

export interface TaskWork<A extends string = string> {
  // 작업 하나를 끝까지 하고 끝을 돌려준다. 예상할 수 있는 실패는 결과 값으로 돌려준다(quality 063). 던진 예외는 작업 실행이
  // 받아 unexpected로 끝낸다.
  readonly run: (context: TaskContext<A>) => Promise<TaskOutcome>;
  // 서비스 워커가 시작할 때, 앞 서비스 워커가 끝내지 못한 이 기능의 작업이 그 탭에 남겼을 수 있는 Chrome과 페이지의 상태를
  // 치운다(결정 0038, 0046). 작업 실행은 진행 중으로 남은 기록의 탭마다 이것을 부른 뒤에 그 기록을 실패로 끝낸다. 작업의 기록이
  // 그 상태보다 먼저 생기고(시작할 때 진행 중을 쓴 뒤 일을 시작) 나중에 없어지므로(일이 다 치운 뒤 끝을 씀), 기록만 보고 치울
  // 곳을 모두 찾는다. 남은 것이 없으면 할 일이 없다. 던지지 않는다.
  readonly interrupted: (tabId: number) => Promise<void>;
}

export interface TaskPart {
  readonly featureId: string;
  // 서비스 워커가 시작할 때 한 번 부른다. 기능은 여기서 서비스의 사건(디버거 끊김 등)을 듣는다.
  readonly start: (services: TaskServices) => TaskWork;
}

// 기능의 일은 자기 작업 종류(A)만 받는다. 작업 실행이 그 기능의 종류인지 본 뒤에 넘기므로 여기서 다시 고르지 못하는 일은
// 일어나면 안 된다.
export function defineTaskPart<A extends string>(
  definition: ActionFeature<A>,
  start: (services: TaskServices) => TaskWork<A>,
): TaskPart {
  return {
    featureId: definition.id,
    start: (services) => {
      const work = start(services);
      return {
        run: (context) => {
          const action = actionOf(definition, context.action);
          if (action === null)
            throw new Error(`${definition.id}에 작업 종류 ${context.action}이 없다.`);
          return work.run({ ...context, action: action.id });
        },
        interrupted: work.interrupted,
      };
    },
  };
}
