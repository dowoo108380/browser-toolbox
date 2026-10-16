import { afterEach, describe, expect, it, vi } from 'vitest';
import { pageStatus, popupPort, taskNotice } from '../contracts/index.ts';
import { appError, err, ok } from '../shared/index.ts';
import { announcePopup, watchPopups } from './popup-port.ts';
import { listenExtensionRequest, sendToTab } from './tab-messaging.ts';

// 탭에 보내기와 받기, 팝업의 연결(결정 0006, 0024)의 Chrome 경계. 진짜 chrome 대신 시험이 만든 객체를 전역에 둔다.
// 오류 문구는 Chromium 156에서 실제로 받은 것이다(결정 0024의 실험 3). 확장 주소의 출처 계산(URL)이 Node와 Chromium에서
// 달라 Chromium에서 돈다.

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const extensionOrigin = `chrome-extension://${extensionId}`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('탭에 보내기(sendToTab)', () => {
  function fakeTabs(sendMessage: (...args: unknown[]) => Promise<unknown>) {
    const send = vi.fn(sendMessage);
    vi.stubGlobal('chrome', { tabs: { sendMessage: send } });
    return send;
  }

  it('그 탭의 최상위 프레임에 보내고, 형식에 맞는 성공 답이면 delivered와 그 값이다', async () => {
    const send = fakeTabs(() => Promise.resolve(ok(null)));
    expect(await sendToTab(taskNotice, 4, { text: '끝났다.' })).toEqual({
      delivery: 'delivered',
      value: null,
    });
    expect(send).toHaveBeenCalledWith(
      4,
      { type: 'task.notice', payload: { text: '끝났다.' } },
      { frameId: 0 },
    );
  });

  it('받는 쪽이 없는 탭(넣을 수 없는 페이지, 새로 고치기 전, 닫힌 탭)은 unreachable이다', async () => {
    fakeTabs(() =>
      Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')),
    );
    expect(await sendToTab(taskNotice, 4, { text: '끝났다.' })).toEqual({
      delivery: 'unreachable',
    });
  });

  it('그 밖의 거절, 형식이 틀린 답, 받는 쪽이 실패로 한 답은 failed다', async () => {
    const failed = { delivery: 'failed' };
    fakeTabs(() => Promise.reject(new Error('Something else')));
    expect(await sendToTab(taskNotice, 4, { text: '끝났다.' })).toEqual(failed);
    fakeTabs(() => Promise.resolve(undefined));
    expect(await sendToTab(taskNotice, 4, { text: '끝났다.' })).toEqual(failed);
    fakeTabs(() => Promise.resolve(err(appError('invalid-input', '요청 내용이 맞지 않는다.'))));
    expect(await sendToTab(taskNotice, 4, { text: '끝났다.' })).toEqual(failed);
  });

  it('결정 0026 받는 쪽이 답한 값을 그 요청의 정의로 검증해 돌려준다', async () => {
    const notFound = [
      { featureId: 'gpt', element: { id: 'chatgpt.thread', name: 'ChatGPT 대화 열' } },
    ];
    fakeTabs(() => Promise.resolve(ok({ notFound })));
    expect(await sendToTab(pageStatus, 4, {}, 1000)).toEqual({
      delivery: 'delivered',
      value: { notFound },
    });
    fakeTabs(() => Promise.resolve(ok({ notFound: [{ featureId: 'gpt' }] })));
    expect(await sendToTab(pageStatus, 4, {}, 1000)).toEqual({ delivery: 'failed' });
  });

  it('제한 시간(기본 5초) 안에 답이 없으면 timeout이다', async () => {
    vi.useFakeTimers();
    fakeTabs(() => new Promise(() => undefined));
    const pending = sendToTab(taskNotice, 4, { text: '끝났다.' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toEqual({ delivery: 'timeout' });
  });
});

describe('콘텐츠 스크립트가 받기(listenExtensionRequest)', () => {
  type Listener = (
    message: unknown,
    sender: unknown,
    sendResponse: (response: unknown) => void,
  ) => boolean;

  function fakeRuntime() {
    const listeners = new Set<Listener>();
    vi.stubGlobal('chrome', {
      runtime: {
        id: extensionId,
        onMessage: {
          addListener: (listener: Listener) => listeners.add(listener),
          removeListener: (listener: Listener) => listeners.delete(listener),
        },
      },
    });
    const deliver = (message: unknown, sender: unknown) => {
      const responses: unknown[] = [];
      for (const listener of listeners) listener(message, sender, (value) => responses.push(value));
      return responses;
    };
    return { listeners, deliver };
  }

  const fromWorker = { id: extensionId, url: `${extensionOrigin}/sw.js` };
  const notice = { type: 'task.notice', payload: { text: '끝났다.' } };

  it('이 확장의 서비스 워커가 보낸 그 요청을 받아 처리하고 답한다', () => {
    const { deliver } = fakeRuntime();
    const received: string[] = [];
    listenExtensionRequest(taskNotice, ({ text }) => {
      received.push(text);
      return ok(null);
    });
    expect(deliver(notice, fromWorker)).toEqual([ok(null)]);
    expect(received).toEqual(['끝났다.']);
  });

  it('탭에서 온 것, 다른 확장의 것, 다른 요청은 받지 않는다. 내용이 틀리면 invalid-input으로 답한다', () => {
    const { deliver } = fakeRuntime();
    const received: string[] = [];
    listenExtensionRequest(taskNotice, ({ text }) => {
      received.push(text);
      return ok(null);
    });
    expect(deliver(notice, { ...fromWorker, tab: { id: 1 } })).toEqual([]);
    expect(deliver(notice, { id: 'other' })).toEqual([]);
    expect(deliver({ type: 'settings.update', payload: {} }, fromWorker)).toEqual([]);
    expect(deliver({ type: 'task.notice', payload: { text: 3 } }, fromWorker)).toEqual([
      err(appError('invalid-input', '요청 내용이 맞지 않는다.')),
    ]);
    expect(received).toEqual([]);
  });

  it('돌려준 함수로 듣기를 그만둔다', () => {
    const { listeners } = fakeRuntime();
    const stop = listenExtensionRequest(taskNotice, () => ok(null));
    expect(listeners.size).toBe(1);
    stop();
    expect(listeners.size).toBe(0);
  });
});

// 시험의 연결(port). 메시지와 끊김을 시험이 보낸다.
function fakePort(name: string, sender: unknown) {
  const posted: unknown[] = [];
  const messageListeners: ((message: unknown) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];
  const port = {
    name,
    sender,
    posted,
    disconnected: 0,
    postMessage: (message: unknown) => port.posted.push(message),
    disconnect: () => {
      port.disconnected += 1;
    },
    onMessage: {
      addListener: (listener: (message: unknown) => void) => messageListeners.push(listener),
    },
    onDisconnect: { addListener: (listener: () => void) => disconnectListeners.push(listener) },
    message: (message: unknown) => {
      for (const listener of messageListeners) listener(message);
    },
    drop: () => {
      for (const listener of disconnectListeners) listener();
    },
  };
  return port;
}

describe('팝업의 연결(결정 0024)', () => {
  it('팝업 쪽: 열 때 이 확장에 그 이름으로 연결해 보는 탭을 보내고, close로 닫는다', () => {
    const ports: ReturnType<typeof fakePort>[] = [];
    const connect = vi.fn((_id: string, info: { name: string }) => {
      const port = fakePort(info.name, undefined);
      ports.push(port);
      return port;
    });
    vi.stubGlobal('chrome', { runtime: { id: extensionId, connect } });
    const announcement = announcePopup(7);
    expect(connect).toHaveBeenCalledWith(extensionId, { name: popupPort.name });
    expect(ports[0]?.posted).toEqual([{ tabId: 7 }]);
    // 이어져 있으면 renew는 다시 잇지 않는다.
    announcement.renew();
    expect(connect).toHaveBeenCalledTimes(1);
    announcement.close();
    expect(ports[0]?.disconnected).toBe(1);
  });

  it('팝업 쪽: 연결이 끊기면(서비스 워커가 멈춤) renew가 다시 잇는다. 확장과 연결이 끊긴 뒤에는 잇지 않는다', () => {
    const ports: ReturnType<typeof fakePort>[] = [];
    const runtime: {
      id: string | undefined;
      connect: (id: string, info: { name: string }) => ReturnType<typeof fakePort>;
    } = {
      id: extensionId,
      connect: (_id: string, info: { name: string }) => {
        const port = fakePort(info.name, undefined);
        ports.push(port);
        return port;
      },
    };
    vi.stubGlobal('chrome', { runtime });
    const announcement = announcePopup(7);
    ports[0]?.drop();
    announcement.renew();
    expect(ports).toHaveLength(2);
    expect(ports[1]?.posted).toEqual([{ tabId: 7 }]);
    ports[1]?.drop();
    runtime.id = undefined;
    announcement.renew();
    expect(ports).toHaveLength(2);
  });

  it('서비스 워커 쪽: 이 확장의 화면이 연 연결의 첫 메시지로 그 탭을 본다고 알고, 끊기면 잊는다', () => {
    let onConnect: ((port: ReturnType<typeof fakePort>) => void) | undefined;
    vi.stubGlobal('chrome', {
      runtime: {
        id: extensionId,
        getURL: (path: string) => `${extensionOrigin}/${path}`,
        onConnect: { addListener: (listener: typeof onConnect) => (onConnect = listener) },
      },
    });
    const popups = watchPopups();
    const popup = fakePort('popup', { id: extensionId, origin: extensionOrigin });
    onConnect?.(popup);
    expect(popups.viewing(7)).toBe(false);
    popup.message({ tabId: 7 });
    expect(popups.viewing(7)).toBe(true);
    expect(popups.viewing(8)).toBe(false);
    popup.drop();
    expect(popups.viewing(7)).toBe(false);
  });

  it('서비스 워커 쪽: 다른 이름, 다른 확장, 확장 출처가 아닌 곳(콘텐츠 스크립트)의 연결은 끊고, 틀린 첫 메시지는 무시한다', () => {
    let onConnect: ((port: ReturnType<typeof fakePort>) => void) | undefined;
    vi.stubGlobal('chrome', {
      runtime: {
        id: extensionId,
        getURL: (path: string) => `${extensionOrigin}/${path}`,
        onConnect: { addListener: (listener: typeof onConnect) => (onConnect = listener) },
      },
    });
    const popups = watchPopups();
    const strangers = [
      fakePort('other', { id: extensionId, origin: extensionOrigin }),
      fakePort('popup', { id: 'another', origin: 'chrome-extension://another' }),
      fakePort('popup', { id: extensionId, origin: 'http://a.test', tab: { id: 7 } }),
    ];
    for (const port of strangers) {
      onConnect?.(port);
      port.message({ tabId: 7 });
      expect(port.disconnected).toBe(1);
    }
    const popup = fakePort('popup', { id: extensionId, origin: extensionOrigin });
    onConnect?.(popup);
    popup.message({ tabId: 'x' });
    expect(popups.viewing(7)).toBe(false);
  });
});
