import { type RequestDefinition, responseSchema } from '../contracts/index.ts';
import { type AppError, type Result, appError, err } from '../shared/index.ts';

// chrome.runtime 메시지를 감싼다. 요청과 응답은 contracts의 정의로 검증한다(결정 0006).

const defaultTimeoutMs = 5000;

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

export function chromeRequester(timeoutMs: number = defaultTimeoutMs): Requester {
  return async (definition, payload) => {
    // 연결이 끊긴 옛 스크립트에서는 chrome.runtime 자체가 없어지기도 한다(결정 0008 고친 기록).
    // 그때 부르면 TypeError가 나므로 먼저 확인한다.
    if (!isExtensionConnected()) return disconnected();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
      }, timeoutMs);
    });
    try {
      const response: unknown = await Promise.race([
        chrome.runtime.sendMessage({ type: definition.type, payload }),
        timeout,
      ]);
      if (response === 'timeout') {
        return err(appError('timeout', '확장의 응답이 없다. 잠시 뒤 다시 한다.'));
      }
      const parsed = responseSchema(definition.value).safeParse(response);
      if (!parsed.success) {
        return err(appError('unexpected', '확장의 응답 형식이 맞지 않는다.'));
      }
      return parsed.data;
    } catch (error) {
      // 보내는 도중에 끊긴 경우도 끊김으로 본다.
      if (isDisconnected(error) || !isExtensionConnected()) return disconnected();
      return err(appError('platform', '확장에 요청을 보내지 못했다.'));
    } finally {
      clearTimeout(timer);
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
