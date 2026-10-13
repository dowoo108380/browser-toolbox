import * as z from 'zod/mini';
import { errorKinds } from '../shared/index.ts';

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

export const requests = [
  settingsUpdate,
  storageEnsureReady,
  repairNoticeDismiss,
  problemReport,
] as const;
