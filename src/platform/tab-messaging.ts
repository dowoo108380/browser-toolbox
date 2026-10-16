import * as z from 'zod/mini';
import { type RequestDefinition, responseSchema } from '../contracts/index.ts';
import { type AppError, type Result, appError, err, withTimeout } from '../shared/index.ts';

// 서비스 워커가 탭의 콘텐츠 스크립트에 보내는 요청(chrome.tabs.sendMessage)과 콘텐츠 스크립트가 그것을 받는 쪽(결정 0006,
// 0024). 요청과 응답은 contracts의 정의로 검증한다.

const defaultTimeoutMs = 5000;

// 보낸 결과. delivered: 받는 쪽이 받아 형식에 맞게 답했다. unreachable: 받는 쪽이 없다(이 확장이 스크립트를 넣을 수 없는
// 페이지, 새로 고치기 전의 탭, 닫힌 탭. 결정 0024의 실험 3). timeout: 제한 시간 안에 답이 없다(페이지의 주 스레드가
// 붙잡힘 등). failed: 그 밖의 실패.
export type Delivery = 'delivered' | 'unreachable' | 'timeout' | 'failed';

// 받는 쪽이 없으면 Chrome이 이 문구로 거절한다. 닫힌 탭도 같다(결정 0024의 실험 3).
function isUnreachable(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Receiving end does not exist');
}

// 그 탭의 최상위 프레임에 보낸다.
export async function sendToTab<Payload, Value>(
  definition: RequestDefinition<string, Payload, Value>,
  tabId: number,
  payload: Payload,
  timeoutMs: number = defaultTimeoutMs,
): Promise<Delivery> {
  try {
    const response = await withTimeout(timeoutMs, (): Promise<unknown> =>
      chrome.tabs.sendMessage(tabId, { type: definition.type, payload }, { frameId: 0 }),
    );
    if (!response.done) return 'timeout';
    return responseSchema(definition.value).safeParse(response.value).success
      ? 'delivered'
      : 'failed';
  } catch (error) {
    return isUnreachable(error) ? 'unreachable' : 'failed';
  }
}

const envelopeSchema = z.object({ type: z.string(), payload: z.unknown() });

// 콘텐츠 스크립트가 이 확장의 서비스 워커(와 확장 화면)가 보낸 그 요청을 받는다. 탭에서 온 것(다른 콘텐츠 스크립트)과
// 다른 확장의 것은 받지 않는다. 다른 요청은 다른 듣기에 맡긴다. 답은 바로 돌려준다. 돌려준 함수로 듣기를 그만둔다.
export function listenExtensionRequest<Payload, Value>(
  definition: RequestDefinition<string, Payload, Value>,
  handle: (payload: Payload) => Result<Value, AppError>,
): () => void {
  const listener = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean => {
    if (sender.id !== chrome.runtime.id || sender.tab !== undefined) return false;
    const envelope = envelopeSchema.safeParse(message);
    if (!envelope.success || envelope.data.type !== definition.type) return false;
    const parsed = definition.payload.safeParse(envelope.data.payload);
    sendResponse(
      parsed.success
        ? handle(parsed.data)
        : err(appError('invalid-input', '요청 내용이 맞지 않는다.')),
    );
    return false;
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => {
    chrome.runtime.onMessage.removeListener(listener);
  };
}
