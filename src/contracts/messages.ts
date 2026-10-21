import * as v from './schema.ts';
import { type ErrorKind, errorKinds } from '../shared/index.ts';
import { pageBundles } from './events.ts';
import { categories } from './feature.ts';

// 구성 요소 사이의 요청은 여기서 한 번만 정의한다(결정 0006). 타입은 스키마에서 끌어낸다.
export interface RequestDefinition<Type extends string, Payload, Value> {
  readonly type: Type;
  readonly payload: v.Schema<Payload>;
  readonly value: v.Schema<Value>;
  // 'extension'이면 확장 화면만 보낼 수 있다. 콘텐츠 스크립트는 설정을 바꿀 수 없다(결정 0006).
  readonly senders: 'extension' | 'any';
}

function defineRequest<Type extends string, Payload, Value>(
  definition: RequestDefinition<Type, Payload, Value>,
): RequestDefinition<Type, Payload, Value> {
  return definition;
}

const errorSchema = v.object({
  kind: v.picklist(errorKinds),
  message: v.string(),
});

// 응답은 늘 결과 값이다. 예외를 메시지 너머로 던지지 않는다(결정 0006).
export function responseSchema<Value>(value: v.Schema<Value>) {
  return v.union([
    v.object({ ok: v.literal(true), value }),
    v.object({ ok: v.literal(false), error: errorSchema }),
  ]);
}

// 기능 하나의 설정을 바꾼다. 저장하면 저장한 값의 세대 번호로 답한다. unexpected가 아닌 실패로 답하면 저장하지 않은 것이다:
// 쓰기는 마지막 한 번이고(결정 0011) 그런 실패는 그 전이나 그 쓰기에서만 돌려준다. unexpected(처리기가 예상하지 못한 오류로
// 끝남)는 어디까지 했는지 모르므로 저장했을 수도 있다(팝업은 알 수 없음으로 본다, 결정 0036).
export const settingsUpdate = defineRequest({
  type: 'settings.update',
  // 바꿀 필드만 보낸다. 두 화면이 같은 기능의 다른 필드를 함께 바꿔도 둘 다 남는다(COM-3.6).
  payload: v.object({
    featureId: v.string(),
    patch: v.record(v.string(), v.unknown()),
  }),
  value: v.object({ revision: v.int() }),
  senders: 'extension',
});

export const storageEnsureReady = defineRequest({
  type: 'storage.ensureReady',
  payload: v.object({}),
  value: v.null(),
  senders: 'any',
});

// 사용자가 팝업에서 설정 복구 알림을 확인했다. 본 기록의 stamp를 보낸다. 서비스 워커는 지금 기록이 그것일 때만 지운다(결정 0016).
export const repairNoticeDismiss = defineRequest({
  type: 'repairNotice.dismiss',
  payload: v.object({ stamp: v.int() }),
  value: v.null(),
  senders: 'extension',
});

// 기능이 기대는 외부 화면 요소의 이름표(id)와 사람이 알아볼 이름(결정 0026). 사이트 모듈의 코드에 적힌 짧은 글이다.
// 콘텐츠 스크립트가 보내므로 길이를 검증한다(결정 0006).
const elementLabelLimit = 64;

export const elementRefSchema = v.object({
  id: v.pipe(v.string(), v.maxLength(elementLabelLimit)),
  name: v.pipe(v.string(), v.maxLength(elementLabelLimit)),
});

export type ElementRef = v.InferOutput<typeof elementRefSchema>;

export const problemReport = defineRequest({
  type: 'problem.report',
  payload: v.object({
    featureId: v.nullable(v.string()),
    kind: v.picklist(errorKinds),
    // 찾지 못했거나 기능이 건 변경이 작용하지 않은 외부 화면 요소(kind가 not-found나 not-applied일 때, COM-5 기대 동작 2,
    // 결정 0034).
    element: v.optional(elementRefSchema),
  }),
  value: v.null(),
  senders: 'any',
});

// 사용자가 팝업에서 범주를 골랐다. 서비스 워커가 남겨 두고, 다음에 팝업을 열 때 그 범주로 연다(COM-2 기대 동작 5, 결정 0023).
export const popupRemember = defineRequest({
  type: 'popup.remember',
  payload: v.object({ category: v.picklist(categories) }),
  value: v.null(),
  senders: 'extension',
});

// 기능이 외부 화면에 기대한 것이 어긋난 까닭(결정 0026, 0034): 기대는 요소를 찾지 못함, 찾은 요소에 건 변경이 작용하지 않음.
// 문제 기록의 오류 종류와 같은 이름이다.
const unmetReasons = ['not-found', 'not-applied'] as const satisfies readonly ErrorKind[];

export type UnmetReason = (typeof unmetReasons)[number];

// 실행 틀이 지금 외부 화면에 기대한 것이 어긋나 멈춘 기능과 그 까닭과 요소(결정 0026, 0034).
const unmetSchema = v.array(
  v.object({ featureId: v.string(), reason: v.picklist(unmetReasons), element: elementRefSchema }),
);

// 실행 틀을 담은 콘텐츠 스크립트 묶음(결정 0029). 서비스 워커가 탐침으로 읽은 실행 틀의 표식 값을 이것으로 검증한다.
export const pageBundleSchema = v.picklist(pageBundles);

// 그 탭의 최상위 문서에서 이 확장의 실행 틀이 도는지(결정 0023). ready: 돈다. 그 실행 틀의 묶음(사이트 전용 기능을 그
// 탭에서 쓸 수 있는지, 결정 0029)을 싣는다. reload: 넣을 수는 있는데 실행 틀이 없다(설치·갱신·다시 불러오기 전에 연 페이지,
// 새로 고치면 쓸 수 있다). denied: Chrome이 그 페이지에 넣기를 거절한다(확장이 접근할 수 없는 페이지).
const unusableRuntimeSchema = v.object({ page: v.picklist(['reload', 'denied']) });
const tabRuntimeSchema = v.union([
  v.object({ page: v.literal('ready'), bundle: pageBundleSchema }),
  unusableRuntimeSchema,
]);

export type TabRuntime = v.InferOutput<typeof tabRuntimeSchema>;

// 지금 탭에서 페이지에 작용하는 기능을 쓸 수 있는지(결정 0023): 그 탭의 실행 틀(위)에, 돌면 외부 화면에 기대한 것이 어긋난
// 기능(찾지 못함, 적용되지 않음, 결정 0026, 0034)을 함께 싣는다.
const tabStatusSchema = v.union([
  v.object({ page: v.literal('ready'), bundle: pageBundleSchema, unmet: unmetSchema }),
  unusableRuntimeSchema,
]);

export type TabStatus = v.InferOutput<typeof tabStatusSchema>;

// 팝업이 자기 창의 지금 탭의 상태를 묻는다(COM-2 기대 동작 4, COM-6 기대 동작 2, COM-7 기대 동작 2, 결정 0023, 0026).
export const tabStatus = defineRequest({
  type: 'tab.status',
  payload: v.object({ tabId: v.int() }),
  value: tabStatusSchema,
  senders: 'extension',
});

// 팝업이 자기 창의 탭들에서 실행 틀이 도는지 묻는다(탭마다 켜고 끄는 기능의 탭 목록, TAB-2 기대 동작 8, COM-7 기대 동작 2,
// 결정 0045). 서비스 워커는 그 가운데 웹 페이지이고 싣는 중이 아니며 쉬지 않는(버려지거나 얼려지지 않은) 탭에만 탐침을 넣고,
// 정한 시간 안에 답한 탭만 싣는다. 싣지 않은 탭은 모르는 것이다.
export const tabRuntimes = defineRequest({
  type: 'tab.runtimes',
  payload: v.object({ tabIds: v.array(v.int()) }),
  value: v.array(v.object({ tabId: v.int(), runtime: tabRuntimeSchema })),
  senders: 'extension',
});

// 팝업이 자기 창의 지금 탭에서 실행 기능의 작업(그 기능의 작업 종류 하나, 결정 0046)을 시작한다(COM-10, 결정 0024). 서비스
// 워커는 그 기능의 작업 종류이고 그 탭에 진행 중인 작업이 없을 때만 시작하고 작업 id로 답한다. 일은 응답과 따로 끝까지 하고,
// 진행과 결과는 작업 기록(storage.session)에 남긴다.
export const taskStart = defineRequest({
  type: 'task.start',
  payload: v.object({
    featureId: v.string(),
    action: v.pipe(v.string(), v.maxLength(64)),
    tabId: v.int(),
  }),
  value: v.object({ taskId: v.string() }),
  senders: 'extension',
});

// 팝업이 그 탭의 끝난 작업(작업 id)을 보였다(COM-10 기대 동작 3, 결정 0012). 서비스 워커는 그 탭의 기록이 같은 작업이고
// 끝났을 때만 기록과 배지를 지운다. 늦게 닿아도 그 뒤에 시작한 작업을 지우지 않는다(COM-10.8).
export const taskSeen = defineRequest({
  type: 'task.seen',
  payload: v.object({ tabId: v.int(), taskId: v.string() }),
  value: v.null(),
  senders: 'extension',
});

// 팝업이 그 탭들에서 탭마다 켜고 끄는 기능을 켜거나 끈다(TAB-2 기대 동작 1, 결정 0043). 서비스 워커는 탭마다 고른 것을
// storage.session에 쓰고(그 탭이 "모든 탭" 스위치와 같으면 고른 것을 지운다) 그 탭들의 Chrome 상태를 맞춘다.
export const tabToggleSet = defineRequest({
  type: 'tabToggle.set',
  payload: v.object({
    featureId: v.string(),
    tabIds: v.array(v.int()),
    on: v.boolean(),
  }),
  value: v.null(),
  senders: 'extension',
});

// 그 탭에서 켜진 탭마다 켜고 끄는 기능(기능 id의 목록). 콘텐츠 스크립트가 시작할 때 묻고(tabState.get), 바뀌면 서비스
// 워커가 그 탭의 모든 프레임에 알린다(tabState.changed, 결정 0043). 콘텐츠 스크립트는 storage.session을 읽지 않는다(결정 0005).
// 이 값은 서비스 워커만 보낸다.
const tabStateSchema = v.object({ on: v.array(v.string()) });

export type TabState = v.InferOutput<typeof tabStateSchema>;

// 콘텐츠 스크립트가 자기 탭의 상태를 묻는다. 보낸 곳의 탭으로 답한다.
export const tabStateGet = defineRequest({
  type: 'tabState.get',
  payload: v.object({}),
  value: tabStateSchema,
  senders: 'any',
});

// 기능별 명령의 봉투(결정 0043). 이름과 내용의 스키마는 그 기능의 명령(contracts/command.ts의 defineCommand)이 정하고, 받는
// 쪽이 그것으로 다시 검증한다. 콘텐츠 스크립트가 보내면 서비스 워커가 그 기능의 서비스 워커 쪽에 넘기고(보낸 탭과 프레임을
// 함께), 서비스 워커가 보내면 그 프레임의 실행 틀이 그 기능의 페이지 쪽에 넘긴다.
export const featureCommand = defineRequest({
  type: 'feature.command',
  payload: v.object({
    featureId: v.pipe(v.string(), v.maxLength(64)),
    name: v.pipe(v.string(), v.maxLength(64)),
    payload: v.unknown(),
  }),
  value: v.unknown(),
  senders: 'any',
});

export const requests = [
  settingsUpdate,
  storageEnsureReady,
  repairNoticeDismiss,
  problemReport,
  popupRemember,
  tabStatus,
  tabRuntimes,
  taskStart,
  taskSeen,
  tabToggleSet,
  tabStateGet,
  featureCommand,
] as const;

// 서비스 워커가 콘텐츠 스크립트에 보내는 요청(chrome.tabs.sendMessage). 콘텐츠 스크립트는 이 확장의 서비스 워커가 보낸
// 것만 받는다(결정 0006).

// 작업이 끝났을 때 그 탭을 보는 팝업이 없고 그 탭이 창의 지금 탭이면, 최상위 프레임에 그 결과를 3초 보이라고 한다
// (COM-10 기대 동작 4, 결정 0024). 글은 서비스 워커가 만든다.
export const noticeTextLimit = 500;

export const taskNotice = defineRequest({
  type: 'task.notice',
  payload: v.object({ text: v.pipe(v.string(), v.maxLength(noticeTextLimit)) }),
  value: v.null(),
  senders: 'extension',
});

// 서비스 워커가 실행 틀(최상위 프레임)에 지금 외부 화면에 기대한 것이 어긋난 기능을 묻는다. 팝업의 tab.status에 싣는다(결정
// 0026, 0034).
export const pageStatus = defineRequest({
  type: 'page.status',
  payload: v.object({}),
  value: v.object({ unmet: unmetSchema }),
  senders: 'extension',
});

export type PageStatus = v.InferOutput<typeof pageStatus.value>;

// 서비스 워커가 그 탭의 모든 프레임에 탭의 상태가 바뀌었다고 알린다(위 tabState.get). 받는 쪽이 없는 프레임(이 확장이 스크립트를
// 넣을 수 없는 페이지)은 그대로 둔다.
export const tabStateChanged = defineRequest({
  type: 'tabState.changed',
  payload: tabStateSchema,
  value: v.null(),
  senders: 'extension',
});

// 팝업이 열려 있는 동안 서비스 워커에 여는 연결(chrome.runtime.connect)의 이름과 첫 메시지. 서비스 워커는 연결이 열린
// 동안 그 탭을 "팝업이 보는 탭"으로 안다(결정 0024).
export const popupPort = {
  name: 'popup',
  hello: v.object({ tabId: v.int() }),
} as const;
