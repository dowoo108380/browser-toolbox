import { type RequestDefinition, requests, v } from '../contracts/index.ts';
import type { Sender } from '../platform/index.ts';
import { type AppError, type Result, appError, err } from '../shared/index.ts';

// 서비스 워커가 받는 모든 요청을 여기서 검증하고 처리기로 보낸다(결정 0006).

export interface Route {
  readonly type: string;
  readonly senders: 'extension' | 'any';
  readonly handle: (payload: unknown, sender: Sender) => Promise<Result<unknown, AppError>>;
}

export function route<Payload, Value>(
  definition: RequestDefinition<string, Payload, Value>,
  handle: (payload: Payload, sender: Sender) => Promise<Result<Value, AppError>>,
): Route {
  return {
    type: definition.type,
    senders: definition.senders,
    handle: async (payload, sender) => {
      const parsed = v.safeParse(definition.payload, payload);
      if (!parsed.success) return err(appError('invalid-input', '요청 내용이 맞지 않는다.'));
      return handle(parsed.output, sender);
    },
  };
}

const envelopeSchema = v.object({ type: v.string(), payload: v.unknown() });

export function createRouter(
  routes: readonly Route[],
  onUnexpected: (error: unknown) => void,
): (message: unknown, sender: Sender) => Promise<Result<unknown, AppError>> {
  // 정의된 요청마다 처리기가 꼭 하나 있어야 한다. 빠지면 결함이므로 시작할 때 드러낸다(quality 066).
  for (const definition of requests) {
    const count = routes.filter((candidate) => candidate.type === definition.type).length;
    if (count !== 1) throw new Error(`요청 ${definition.type}의 처리기가 ${String(count)}개다.`);
  }
  return async (message, sender) => {
    const envelope = v.safeParse(envelopeSchema, message);
    if (!envelope.success) return err(appError('invalid-input', '요청 형식이 맞지 않는다.'));
    const target = routes.find((candidate) => candidate.type === envelope.output.type);
    if (target === undefined) return err(appError('invalid-input', '모르는 요청이다.'));
    if (target.senders === 'extension' && sender.kind !== 'extension') {
      return err(appError('permission', '이 요청은 확장 화면만 보낼 수 있다.'));
    }
    try {
      const result = await target.handle(envelope.output.payload, sender);
      // 처리기가 돌려준 unexpected도 일어나면 안 되는 일이다. 던진 예외와 같이 기록한다(quality 066).
      if (!result.ok && result.error.kind === 'unexpected') onUnexpected(result.error);
      return result;
    } catch (error) {
      // 처리기에서 예상하지 못한 예외: 그 요청만 실패시키고 기록한다(quality 010, 066).
      onUnexpected(error);
      return err(appError('unexpected', '확장 안에서 예상하지 못한 오류가 났다.'));
    }
  };
}
