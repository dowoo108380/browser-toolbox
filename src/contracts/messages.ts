import * as z from 'zod/mini';
import { errorKinds } from '../shared/index.ts';
import { categories } from './feature.ts';

// 구성 요소 사이의 요청은 여기서 한 번만 정의한다(결정 0006). 타입은 스키마에서 끌어낸다.
export interface RequestDefinition<Type extends string, Payload, Value> {
  readonly type: Type;
  readonly payload: z.ZodMiniType<Payload>;
  readonly value: z.ZodMiniType<Value>;
  // 'extension'이면 확장 화면만 보낼 수 있다. 콘텐츠 스크립트는 설정을 바꿀 수 없다(결정 0006).
  readonly senders: 'extension' | 'any';
}

function defineRequest<Type extends string, Payload, Value>(
  definition: RequestDefinition<Type, Payload, Value>,
): RequestDefinition<Type, Payload, Value> {
  return definition;
}

const errorSchema = z.object({
  kind: z.enum(errorKinds),
  message: z.string(),
});

// 응답은 늘 결과 값이다. 예외를 메시지 너머로 던지지 않는다(결정 0006).
export function responseSchema<Value>(value: z.ZodMiniType<Value>) {
  return z.union([
    z.object({ ok: z.literal(true), value }),
    z.object({ ok: z.literal(false), error: errorSchema }),
  ]);
}

export const settingsUpdate = defineRequest({
  type: 'settings.update',
  // 바꿀 필드만 보낸다. 두 화면이 같은 기능의 다른 필드를 함께 바꿔도 둘 다 남는다(COM-3.6).
  payload: z.object({
    featureId: z.string(),
    patch: z.record(z.string(), z.unknown()),
  }),
  value: z.object({ revision: z.int() }),
  senders: 'extension',
});

export const storageEnsureReady = defineRequest({
  type: 'storage.ensureReady',
  payload: z.object({}),
  value: z.null(),
  senders: 'any',
});

// 사용자가 팝업에서 설정 복구 알림을 확인했다. 본 기록의 stamp를 보낸다. 서비스 워커는 지금 기록이 그것일 때만 지운다(결정 0016).
export const repairNoticeDismiss = defineRequest({
  type: 'repairNotice.dismiss',
  payload: z.object({ stamp: z.int() }),
  value: z.null(),
  senders: 'extension',
});

export const problemReport = defineRequest({
  type: 'problem.report',
  payload: z.object({
    featureId: z.nullable(z.string()),
    kind: z.enum(errorKinds),
  }),
  value: z.null(),
  senders: 'any',
});

// 사용자가 팝업에서 범주를 골랐다. 서비스 워커가 남겨 두고, 다음에 팝업을 열 때 그 범주로 연다(COM-2 기대 동작 5, 결정 0023).
export const popupRemember = defineRequest({
  type: 'popup.remember',
  payload: z.object({ category: z.enum(categories) }),
  value: z.null(),
  senders: 'extension',
});

// 지금 탭에서 페이지에 작용하는 기능을 쓸 수 있는지(결정 0023). ready: 이 확장의 실행 틀이 그 탭의 최상위 문서에서
// 돈다. reload: 넣을 수는 있는데 실행 틀이 없다(설치·갱신·다시 불러오기 전에 연 페이지, 새로 고치면 쓸 수 있다).
// denied: Chrome이 그 페이지에 넣기를 거절한다(확장이 접근할 수 없는 페이지).
const pageAccesses = ['ready', 'reload', 'denied'] as const;

export type PageAccess = (typeof pageAccesses)[number];

// 팝업이 자기 창의 지금 탭의 상태를 묻는다(COM-2 기대 동작 4, COM-7 기대 동작 2, 결정 0023).
export const tabStatus = defineRequest({
  type: 'tab.status',
  payload: z.object({ tabId: z.int() }),
  value: z.object({ page: z.enum(pageAccesses) }),
  senders: 'extension',
});

// 팝업이 자기 창의 지금 탭에서 실행 기능의 작업을 시작한다(COM-10, 결정 0024). 서비스 워커는 그 탭에 진행 중인 작업이
// 없을 때만 시작하고 작업 id로 답한다. 일은 응답과 따로 끝까지 하고, 진행과 결과는 작업 기록(storage.session)에 남긴다.
export const taskStart = defineRequest({
  type: 'task.start',
  payload: z.object({ featureId: z.string(), tabId: z.int() }),
  value: z.object({ taskId: z.string() }),
  senders: 'extension',
});

// 팝업이 그 탭의 끝난 작업(작업 id)을 보였다(COM-10 기대 동작 3, 결정 0012). 서비스 워커는 그 탭의 기록이 같은 작업이고
// 끝났을 때만 기록과 배지를 지운다. 늦게 닿아도 그 뒤에 시작한 작업을 지우지 않는다(COM-10.8).
export const taskSeen = defineRequest({
  type: 'task.seen',
  payload: z.object({ tabId: z.int(), taskId: z.string() }),
  value: z.null(),
  senders: 'extension',
});

export const requests = [
  settingsUpdate,
  storageEnsureReady,
  repairNoticeDismiss,
  problemReport,
  popupRemember,
  tabStatus,
  taskStart,
  taskSeen,
] as const;

// 서비스 워커가 콘텐츠 스크립트에 보내는 요청(chrome.tabs.sendMessage). 콘텐츠 스크립트는 이 확장의 서비스 워커가 보낸
// 것만 받는다(결정 0006).

// 작업이 끝났을 때 그 탭을 보는 팝업이 없고 그 탭이 창의 지금 탭이면, 최상위 프레임에 그 결과를 3초 보이라고 한다
// (COM-10 기대 동작 4, 결정 0024). 글은 서비스 워커가 만든다.
export const noticeTextLimit = 500;

export const taskNotice = defineRequest({
  type: 'task.notice',
  payload: z.object({ text: z.string().check(z.maxLength(noticeTextLimit)) }),
  value: z.null(),
  senders: 'extension',
});

// 팝업이 열려 있는 동안 서비스 워커에 여는 연결(chrome.runtime.connect)의 이름과 첫 메시지. 서비스 워커는 연결이 열린
// 동안 그 탭을 "팝업이 보는 탭"으로 안다(결정 0024).
export const popupPort = {
  name: 'popup',
  hello: z.object({ tabId: z.int() }),
} as const;
