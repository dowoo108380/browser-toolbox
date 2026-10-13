import { afterEach, describe, expect, it, vi } from 'vitest';
import { storageEnsureReady } from '../contracts/index.ts';
import { chromeRequester, isExtensionConnected } from './messaging.ts';

// chrome.runtime 메시지 경계(결정 0008의 끊김 판정). 진짜 chrome 대신 시험이 만든 객체를 전역에 둔다.
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
