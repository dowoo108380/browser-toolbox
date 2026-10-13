import { afterEach, describe, expect, it, vi } from 'vitest';
import { storageEnsureReady } from '../contracts/index.ts';
import { chromeRequester, isExtensionConnected, listenRequests } from './messaging.ts';

// chrome.runtime 메시지 경계(결정 0006, 0008). 진짜 chrome 대신 시험이 만든 객체를 전역에 둔다.
// 확장 주소의 출처 계산(URL)이 Node와 Chromium에서 달라 Chromium에서 돈다.

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';

// 시험이 보낸 곳을 일부 필드만으로 만들어 넘기므로 매개변수 타입을 넓게 둔다.
type Listener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean;

function fakeChrome(sendMessage: (message: unknown) => Promise<unknown>) {
  const listeners: Listener[] = [];
  const runtime = {
    id: extensionId,
    sendMessage: vi.fn(sendMessage),
    getURL: (path: string) => `chrome-extension://${extensionId}/${path}`,
    onMessage: {
      addListener: (listener: Listener) => listeners.push(listener),
      removeListener: () => undefined,
    },
  };
  vi.stubGlobal('chrome', { runtime });
  return { runtime, listeners };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('요청 보내기(chromeRequester)', () => {
  it('응답을 그 요청의 정의로 검증해 결과 값으로 돌려준다', async () => {
    fakeChrome(() => Promise.resolve({ ok: true, value: null }));
    expect(await chromeRequester()(storageEnsureReady, {})).toEqual({ ok: true, value: null });
  });

  it('응답 형식이 틀리면 unexpected다', async () => {
    fakeChrome(() => Promise.resolve({ ok: true, value: 3 }));
    const result = await chromeRequester()(storageEnsureReady, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('unexpected');
  });

  it('결정 0006 응답이 제한 시간(기본 5초) 안에 없으면 timeout이다', async () => {
    vi.useFakeTimers();
    fakeChrome(() => new Promise(() => undefined));
    const pending = chromeRequester()(storageEnsureReady, {});
    await vi.advanceTimersByTimeAsync(4999);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('timeout');
  });

  it('보내다 예외가 나면 결과 값(platform)으로 돌려주고 던지지 않는다', async () => {
    fakeChrome(() => Promise.reject(new Error('Could not establish connection.')));
    const result = await chromeRequester()(storageEnsureReady, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('platform');
  });

  it('결정 0008 "Extension context invalidated" 오류는 disconnected다', async () => {
    fakeChrome(() => Promise.reject(new Error('Extension context invalidated.')));
    const result = await chromeRequester()(storageEnsureReady, {});
    if (!result.ok) expect(result.error.kind).toBe('disconnected');
    expect(result.ok).toBe(false);
  });

  it('결정 0008 chrome.runtime 자체가 없어진 옛 스크립트에서는 보내지 않고 disconnected다', async () => {
    vi.stubGlobal('chrome', {});
    const result = await chromeRequester()(storageEnsureReady, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('disconnected');
  });

  it('결정 0008 chrome.runtime.id가 없어진 옛 스크립트에서도 disconnected다', async () => {
    const { runtime } = fakeChrome(() => Promise.resolve({ ok: true, value: null }));
    Reflect.deleteProperty(runtime, 'id');
    const result = await chromeRequester()(storageEnsureReady, {});
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    if (!result.ok) expect(result.error.kind).toBe('disconnected');
    expect(result.ok).toBe(false);
  });

  it('결정 0008 보내는 도중에 연결이 끊기면(오류 문구와 상관없이) disconnected다', async () => {
    const { runtime } = fakeChrome(() => {
      Reflect.deleteProperty(runtime, 'id');
      return Promise.reject(new TypeError('Cannot read properties of undefined'));
    });
    const result = await chromeRequester()(storageEnsureReady, {});
    if (!result.ok) expect(result.error.kind).toBe('disconnected');
    expect(result.ok).toBe(false);
  });
});

describe('결정 0008 연결 확인(isExtensionConnected)', () => {
  it.each([
    ['chrome이 없음', undefined],
    ['chrome.runtime이 없음', {}],
    ['chrome.runtime.id가 없음', { runtime: {} }],
  ])('%s이면 끊긴 것이다(예외를 던지지 않는다)', (_name, value) => {
    vi.stubGlobal('chrome', value);
    expect(isExtensionConnected()).toBe(false);
  });

  it('chrome.runtime.id가 있으면 연결된 것이다', () => {
    fakeChrome(() => Promise.resolve(null));
    expect(isExtensionConnected()).toBe(true);
  });
});

describe('결정 0006 요청 받기(listenRequests): 보낸 곳 확인', () => {
  function receive(sender: Record<string, unknown>) {
    const { listeners } = fakeChrome(() => Promise.resolve(null));
    const handle = vi.fn(() => Promise.resolve({ ok: true, value: null }));
    listenRequests(handle);
    const listener = listeners[0];
    if (listener === undefined) throw new Error('듣기가 걸리지 않았다.');
    const answered = listener({ type: 'x', payload: {} }, sender, () => undefined);
    return { handle, answered };
  }

  it('이 확장의 화면(확장 출처)이 보낸 요청은 extension으로 받는다', () => {
    const { handle, answered } = receive({
      id: extensionId,
      origin: `chrome-extension://${extensionId}`,
    });
    expect(answered).toBe(true);
    expect(handle).toHaveBeenCalledWith({ type: 'x', payload: {} }, { kind: 'extension' });
  });

  it('이 확장의 콘텐츠 스크립트가 보낸 요청은 탭과 프레임을 붙여 받는다', () => {
    const { handle } = receive({
      id: extensionId,
      origin: 'https://example.com',
      tab: { id: 7 },
      frameId: 2,
    });
    expect(handle).toHaveBeenCalledWith(expect.anything(), {
      kind: 'content',
      tabId: 7,
      frameId: 2,
    });
  });

  it.each([
    ['다른 확장', { id: 'otherextensionidotherextensionid', origin: 'chrome-extension://other' }],
    ['탭 정보가 없는 웹 출처', { id: extensionId, origin: 'https://example.com' }],
  ])('%s의 요청은 받지 않는다', (_name, sender) => {
    const { handle, answered } = receive(sender);
    expect(answered).toBe(false);
    expect(handle).not.toHaveBeenCalled();
  });
});
