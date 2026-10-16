import { type FeatureDefinition, responseSchema } from '../../src/contracts/index.ts';
import { type TaskPart, startBackground } from '../../src/background/index.ts';
import type {
  KeyValueStore,
  PageProbe,
  Requester,
  Sender,
  TabBadge,
  TabEventHandlers,
  TabEvents,
} from '../../src/platform/index.ts';
import { createFakeStore } from '../../src/platform/fake.ts';
import { appError, err } from '../../src/shared/index.ts';
import { settingsFormat } from '../../src/storage/index.ts';

// 실제 모듈끼리 연결한 시험(tests/integration)이 실제 서비스 워커(startBackground)를 시작한다. 가짜는 Chrome 경계뿐이다:
// 저장소(받은 것), 메시지 통로(돌려주는 요청 함수), 시계(startTime에서 시작해 기다린 만큼만 간다), 탭(모든 탭이 있다),
// 작업 id(차례로 task-1, task-2, …). 설치 이벤트와 옛 스크립트 정리는 하지 않는다. 테스트에서만 가져온다.

export interface TestBackgroundOptions {
  readonly store: KeyValueStore;
  readonly features: readonly FeatureDefinition[];
  readonly startTime: number;
  // 요청이 서비스 워커에 닿는 때를 시험이 정한다(응답 순서를 바꾸는 시험). 없으면 바로 닿는다.
  readonly deliver?: (type: string, send: () => Promise<unknown>) => Promise<unknown>;
  // 탭의 탐침 결과(결정 0023). 없으면 모든 탭에서 실행 틀이 돈다.
  readonly probePage?: (tabId: number) => Promise<PageProbe>;
  // 작업 기록을 두는 세션 저장소와 실행 기능의 일(결정 0024). 없으면 빈 가짜 저장소와 일 없음이다.
  readonly session?: KeyValueStore;
  readonly taskParts?: readonly TaskPart[];
  // 확장 아이콘의 배지와 탭 사건(결정 0024). 없으면 배지는 버리고 탭 사건은 오지 않는다.
  readonly setTabBadge?: (tabId: number, badge: TabBadge | null) => Promise<void>;
  readonly listenTabEvents?: (handlers: TabEventHandlers) => TabEvents;
}

// 확장 화면과 콘텐츠 스크립트가 쓰는 요청 함수를 돌려준다. chromeRequester처럼 메시지를 구조화 복제로 건네고,
// 응답을 그 요청의 정의로 검증한다.
export function startTestBackground(options: TestBackgroundOptions): Requester {
  let handle: ((message: unknown, sender: Sender) => Promise<unknown>) | undefined;
  const clock = { time: options.startTime };
  let taskCount = 0;
  startBackground({
    features: options.features,
    format: settingsFormat,
    store: options.store,
    session: options.session ?? createFakeStore(),
    taskParts: options.taskParts ?? [],
    randomId: () => {
      taskCount += 1;
      return `task-${String(taskCount)}`;
    },
    tabExists: () => Promise.resolve(true),
    setTabBadge: options.setTabBadge ?? (() => Promise.resolve()),
    listenTabEvents: options.listenTabEvents ?? (() => ({ listen: () => undefined })),
    now: () => clock.time,
    sleep: (ms) => {
      clock.time += ms;
      return Promise.resolve();
    },
    listenRequests: (listener) => {
      handle = listener;
    },
    onInstalled: () => undefined,
    retireOldScripts: () => Promise.resolve(),
    probePage: options.probePage ?? (() => Promise.resolve({ status: 'ran', runtime: true })),
  });
  const deliver = options.deliver ?? ((_type, send) => send());
  return async (definition, payload) => {
    const send = async (): Promise<unknown> => {
      if (handle === undefined) throw new Error('서비스 워커가 요청을 듣지 않는다.');
      const message = structuredClone({ type: definition.type, payload });
      return structuredClone(await handle(message, { kind: 'extension' }));
    };
    const response = await deliver(definition.type, send);
    const parsed = responseSchema(definition.value).safeParse(response);
    return parsed.success
      ? parsed.data
      : err(appError('unexpected', '확장의 응답 형식이 맞지 않는다.'));
  };
}
