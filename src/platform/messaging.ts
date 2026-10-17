import { type RequestDefinition, responseSchema, v } from '../contracts/index.ts';
import { type AppError, type Result, appError, err, withTimeout } from '../shared/index.ts';

// chrome.runtime 메시지를 감싼다. 요청과 응답은 contracts의 정의로 검증한다(결정 0006).

const defaultTimeoutMs = 5000;

// 확장을 다시 불러오거나 업데이트하면 오가던 요청은 거절되거나("message channel closed before a response" 등)
// 응답 없이(undefined) 끝나는데, 그 순간 옛 스크립트는 아직 연결된 것으로 보이고 몇 ms 뒤에야 끊긴 것으로 바뀐다
// (이슈 2. 2026-10-14 실험, Chromium 156: 같은 판 다시 불러오기, 버전을 올린 업데이트, chrome.runtime.reload() 모두
// 거절 뒤 5–8ms였고 브라우저 8개를 함께 띄운 부하에서도 같았다. 응답 없이 끝난 것은 확장 전체 시험의 부하에서
// 다시 불러온 뒤 17–18ms에 봤다). 그래서 요청이 그렇게 실패하면 이만큼 기다린 뒤 연결을 다시 확인한다.
export const disconnectSettleMs = 500;

export type Requester = <Payload, Value>(
  definition: RequestDefinition<string, Payload, Value>,
  payload: Payload,
) => Promise<Result<Value, AppError>>;

// 확장과 연결이 끊긴 옛 스크립트에서 확장 API를 부르면 이 문구의 오류가 난다(R-04).
function isDisconnected(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Extension context invalidated');
}

const disconnected = () =>
  err(appError('disconnected', '확장이 다시 로드되었다. 이 페이지를 새로 고친다.'));

// 실패한 요청의 결과. 그 사이 확장과 연결이 끊겼으면 무엇이 실패했든 끊김이다. 실행 틀은 끊김을 받으면 문제를
// 알리지 않고 물러난다(결정 0008의 셋째 방법).
const failure = (error: AppError) => (isExtensionConnected() ? err(error) : disconnected());

// 거절이나 응답 없이 끝남은 다시 불러오는 순간에도 오므로(disconnectSettleMs) 끊긴 것으로 바뀔 틈을 둔 뒤 판단한다.
// 실패의 모양(거절 문구, 응답 값)으로 가리지 않는다. 연결된 채면 실제 실패다(서비스 워커만 멈춘 경우 등).
async function failureAfterSettle(error: AppError) {
  if (!isExtensionConnected()) return disconnected();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, disconnectSettleMs);
  });
  return failure(error);
}

export function chromeRequester(timeoutMs: number = defaultTimeoutMs): Requester {
  return async (definition, payload) => {
    // 연결이 끊긴 옛 스크립트에서는 chrome.runtime 자체가 없어지기도 한다(결정 0008 고친 기록).
    // 그때 부르면 TypeError가 나므로 먼저 확인한다.
    if (!isExtensionConnected()) return disconnected();
    try {
      const response = await withTimeout(timeoutMs, (): Promise<unknown> =>
        chrome.runtime.sendMessage({ type: definition.type, payload }),
      );
      // 기다리는 사이에 끊긴 옛 스크립트에는 응답이 오지 않는다(위 실험). 이미 오래 기다렸으므로 바로 판단한다.
      if (!response.done) {
        return failure(appError('timeout', '확장의 응답이 없다. 잠시 뒤 다시 한다.'));
      }
      const parsed = v.safeParse(responseSchema(definition.value), response.value);
      if (parsed.success) return parsed.output;
      return await failureAfterSettle(appError('unexpected', '확장의 응답 형식이 맞지 않는다.'));
    } catch (error) {
      if (isDisconnected(error)) return disconnected();
      return failureAfterSettle(appError('platform', '확장에 요청을 보내지 못했다.'));
    }
  };
}

export type Sender =
  | { readonly kind: 'extension' }
  | { readonly kind: 'content'; readonly tabId: number; readonly frameId: number };

// 보낸 곳을 확인한다. 이 확장이 아니면 null이다. 외부 웹사이트와 다른 확장의 메시지는 받지 않는다(결정 0006).
function senderOf(sender: chrome.runtime.MessageSender): Sender | null {
  if (sender.id !== chrome.runtime.id) return null;
  const extensionOrigin = new URL(chrome.runtime.getURL('')).origin;
  if (sender.origin === extensionOrigin) return { kind: 'extension' };
  if (sender.tab?.id !== undefined && sender.frameId !== undefined) {
    return { kind: 'content', tabId: sender.tab.id, frameId: sender.frameId };
  }
  return null;
}

// 요청을 받는다. handle이 돌려준 값을 그대로 응답한다.
export function listenRequests(
  handle: (message: unknown, sender: Sender) => Promise<unknown>,
): () => void {
  const listener = (
    message: unknown,
    rawSender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean => {
    const sender = senderOf(rawSender);
    if (sender === null) return false;
    void handle(message, sender).then(sendResponse);
    // 응답을 비동기로 보낸다는 뜻이다.
    return true;
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => {
    chrome.runtime.onMessage.removeListener(listener);
  };
}

// 옛 스크립트가 확장과 연결이 끊겼는지(결정 0008).
export function isExtensionConnected(): boolean {
  // chrome-types는 늘 있다고 적지만, 연결이 끊긴 옛 스크립트에서는 chrome.runtime.id가 없어지고(R-04)
  // chrome.runtime 자체가 없어지기도 한다(05단계 확인). 그래서 하나씩 확인한다.
  const chromeObject: unknown = Reflect.get(globalThis, 'chrome');
  if (typeof chromeObject !== 'object' || chromeObject === null) return false;
  const runtime: unknown = Reflect.get(chromeObject, 'runtime');
  if (typeof runtime !== 'object' || runtime === null) return false;
  return typeof Reflect.get(runtime, 'id') === 'string';
}
