import { vi } from 'vitest';
import {
  type FeatureDefinition,
  type PageStatus,
  responseSchema,
  v,
} from '../../src/contracts/index.ts';
import {
  type BackgroundDeps,
  type TabTogglePart,
  type TaskPart,
  startBackground,
} from '../../src/background/index.ts';
import {
  tabToggleParts as productTabToggleParts,
  taskParts as productTaskParts,
} from '../../src/entries/generated/sw.ts';
import type {
  Delivery,
  KeyValueStore,
  PageProbe,
  Requester,
  Sender,
  TabBadge,
  TabEventHandlers,
  TabEvents,
  TabResponse,
} from '../../src/platform/index.ts';
import { createFakeStore } from '../../src/platform/fake.ts';
import { appError, err, ok } from '../../src/shared/index.ts';
import { settingsFormat } from '../../src/storage/index.ts';
import { type FakeBrowser, createFakeBrowser } from './fake-browser.ts';

// 실제 모듈끼리 연결한 시험(tests/integration)이 실제 서비스 워커(startBackground)를 시작한다. 가짜는 Chrome 경계뿐이다:
// 저장소(받은 것), 메시지 통로(돌려주는 요청 함수, 또는 실제 요청 도우미가 부르는 chrome.runtime), 시계(startTime에서 시작해
// 기다린 만큼만 간다), 탭(받지 않으면 모든 탭이 있다), 작업 id(차례로 task-1, task-2, …). 설치 이벤트와 옛 스크립트 정리는
// 하지 않는다. 테스트에서만 가져온다.

export interface TestBackgroundOptions {
  readonly store: KeyValueStore;
  readonly features: readonly FeatureDefinition[];
  readonly startTime: number;
  // 요청이 서비스 워커에 닿는 때를 시험이 정한다(응답 순서를 바꾸는 시험). 없으면 바로 닿는다.
  readonly deliver?: (type: string, send: () => Promise<unknown>) => Promise<unknown>;
  // 탭의 탐침 결과(결정 0023). 없으면 모든 탭에서 실행 틀이 돈다.
  readonly probePage?: (tabId: number) => Promise<PageProbe>;
  // 실행 틀에 지금 상태를 물은 답(결정 0026). 없으면 찾지 못한 기능이 없다고 답한다.
  readonly askPage?: (tabId: number, timeoutMs: number) => Promise<TabResponse<PageStatus>>;
  // 작업 기록을 두는 세션 저장소와 실행 기능의 일(결정 0024). 없으면 빈 가짜 저장소와, 제품의 일 가운데 features에 든 기능의
  // 것이다.
  readonly session?: KeyValueStore;
  readonly taskParts?: readonly TaskPart[];
  // 탭이 열려 있는지. 없으면 모든 탭이 있다.
  readonly tabExists?: (tabId: number) => Promise<boolean>;
  // 확장 아이콘의 배지와 탭 사건(결정 0024). 없으면 배지는 버리고 탭 사건은 오지 않는다.
  readonly setTabBadge?: (tabId: number, badge: TabBadge | null) => Promise<void>;
  readonly listenTabEvents?: (handlers: TabEventHandlers) => TabEvents;
  // 팝업이 그 탭을 보는지, 그 탭이 창의 지금 탭인지, 페이지 위 알림을 보낸 결과. 없으면 보는 팝업이 없고, 지금 탭이며,
  // 받는 쪽이 없다.
  readonly popupViewing?: (tabId: number) => boolean;
  readonly isTabActive?: (tabId: number) => Promise<boolean>;
  readonly notifyTab?: (tabId: number, text: string) => Promise<Delivery>;
  // 탭, 창, 디버거의 가짜 Chrome(결정 0041–0043). 없으면 탭이 없는 새 가짜다.
  readonly browser?: FakeBrowser;
  // 탭마다 켜고 끄는 기능의 일. 없으면 제품의 일 가운데 features에 든 기능의 것이다.
  readonly tabToggleParts?: readonly TabTogglePart[];
  // 캡처가 쓰는 페이지 쪽 스크립트, 보이는 화면 찍기, 저장·클립보드의 가짜(결정 0046, 0047). 없으면 모두 거절한다.
  readonly capture?: CaptureDeps;
}

export type CaptureDeps = Pick<
  BackgroundDeps,
  | 'injectScript'
  | 'callInjected'
  | 'captureVisibleTab'
  | 'openOffscreen'
  | 'closeOffscreen'
  | 'offscreenRequest'
  | 'downloadFile'
>;

const refused = () => Promise.resolve(err(appError('platform', '시험에서 쓰지 않는다.')));

// 캡처를 쓰지 않는 시험의 기본값: 오프스크린 문서는 열리고 닫히며(서비스 워커가 시작할 때 닫는다), 나머지는 거절한다.
const unusedCapture: CaptureDeps = {
  injectScript: refused,
  callInjected: refused,
  captureVisibleTab: refused,
  openOffscreen: () => Promise.resolve(ok(null)),
  closeOffscreen: () => Promise.resolve(ok(null)),
  offscreenRequest: refused,
  downloadFile: refused,
};

// 확장 화면과 콘텐츠 스크립트가 쓰는 요청 함수를 돌려준다. chromeRequester처럼 메시지를 구조화 복제로 건네고,
// 응답을 그 요청의 정의로 검증한다. 서비스 워커가 실패로 답한 것만 answered다.
export function startTestBackground(options: TestBackgroundOptions): Requester {
  return startTestBackgroundFrom(options)({ kind: 'extension' });
}

// 보낸 곳을 정해 요청 함수를 만든다. 콘텐츠 스크립트가 보내는 요청(tabState.get, feature.command)을 시험하는 데 쓴다.
export function startTestBackgroundFrom(
  options: TestBackgroundOptions,
): (sender: Sender) => Requester {
  const send = startBackgroundWith(options);
  return (sender) => async (definition, payload) => {
    const response = await send({ type: definition.type, payload }, sender);
    const parsed = v.safeParse(responseSchema(definition.value), response);
    if (!parsed.success) {
      return err({ ...appError('unexpected', '확장의 응답 형식이 맞지 않는다.'), answered: false });
    }
    return parsed.output.ok ? parsed.output : err({ ...parsed.output.error, answered: true });
  };
}

const testExtensionId = 'abcdefghijklmnopabcdefghijklmnop';

// 실제 요청 도우미(chromeRequester)가 시험의 서비스 워커에 닿게 chrome.runtime(id, sendMessage)을 바꿔 끼운다
// (vi.stubGlobal. 시험이 끝나면 vi.unstubAllGlobals로 되돌린다). 요청 도우미의 제한 시간과 응답 검증까지 실제 코드로 본다.
export function startTestBackgroundOnRuntime(options: TestBackgroundOptions): void {
  const send = startBackgroundWith(options);
  vi.stubGlobal('chrome', { runtime: { id: testExtensionId, sendMessage: send } });
}

// 서비스 워커를 시작하고, 메시지를 그 서비스 워커에 건네는 함수를 돌려준다. 메시지와 응답은 구조화 복제로 건네고, 닿는
// 때는 options.deliver가 정한다.
function startBackgroundWith(
  options: TestBackgroundOptions,
): (message: unknown, sender?: Sender) => Promise<unknown> {
  let handle: ((message: unknown, sender: Sender) => Promise<unknown>) | undefined;
  const clock = { time: options.startTime };
  let taskCount = 0;
  startBackground({
    features: options.features,
    format: settingsFormat,
    store: options.store,
    session: options.session ?? createFakeStore(),
    taskParts:
      options.taskParts ??
      productTaskParts.filter((part) =>
        options.features.some((feature) => feature.id === part.featureId),
      ),
    randomId: () => {
      taskCount += 1;
      return `task-${String(taskCount)}`;
    },
    tabExists: options.tabExists ?? (() => Promise.resolve(true)),
    setTabBadge: options.setTabBadge ?? (() => Promise.resolve()),
    listenTabEvents: options.listenTabEvents ?? (() => ({ listen: () => undefined })),
    watchPopups: () => ({ viewing: options.popupViewing ?? (() => false) }),
    isTabActive: options.isTabActive ?? (() => Promise.resolve(true)),
    notifyTab: options.notifyTab ?? (() => Promise.resolve('unreachable' as const)),
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
    probePage: options.probePage ?? (() => Promise.resolve({ status: 'ran', marker: 'common' })),
    askPage:
      options.askPage ??
      (() => Promise.resolve({ delivery: 'delivered', value: { unmet: [] } } as const)),
    tabToggleParts:
      options.tabToggleParts ??
      productTabToggleParts.filter((part) =>
        options.features.some((feature) => feature.id === part.featureId),
      ),
    ...(options.browser ?? createFakeBrowser()).deps,
    ...(options.capture ?? unusedCapture),
  });
  const deliver = options.deliver ?? ((_type, send) => send());
  return (message, sender = { kind: 'extension' }) => {
    const send = async (): Promise<unknown> => {
      if (handle === undefined) throw new Error('서비스 워커가 요청을 듣지 않는다.');
      return structuredClone(await handle(structuredClone(message), sender));
    };
    const type: unknown = Reflect.get(Object(message), 'type');
    return deliver(typeof type === 'string' ? type : '', send);
  };
}
