import { popupPort } from '../contracts/index.ts';
import { isExtensionConnected } from './messaging.ts';

// 팝업이 열려 있는 동안 서비스 워커에 여는 연결(결정 0024). 서비스 워커는 연결이 열린 동안 그 탭을 "팝업이 보는 탭"으로
// 알고, 작업이 끝났을 때 페이지 위 알림을 보낼지 정한다. 팝업이 닫히면 연결이 끊긴다(결정 0024의 실험 4).

export interface PopupAnnouncement {
  // 연결이 끊겼으면(서비스 워커가 다시 시작함) 다시 잇는다. 팝업은 깨울 때마다 부른다.
  readonly renew: () => void;
  readonly close: () => void;
}

// 팝업 쪽: 그 탭을 본다고 알린다. 확장과 연결이 끊긴 뒤에는 아무것도 하지 않는다.
export function announcePopup(tabId: number): PopupAnnouncement {
  let port: chrome.runtime.Port | null = null;
  const renew = () => {
    if (port !== null || !isExtensionConnected()) return;
    const opened = chrome.runtime.connect(chrome.runtime.id, { name: popupPort.name });
    // 끊기면(서비스 워커가 멈춤) 다음 renew에 다시 잇는다.
    opened.onDisconnect.addListener(() => {
      if (port === opened) port = null;
    });
    opened.postMessage({ tabId });
    port = opened;
  };
  renew();
  return {
    renew,
    close: () => {
      port?.disconnect();
      port = null;
    },
  };
}

export interface PopupWatch {
  // 그 탭을 보는 팝업이 열려 있는지.
  readonly viewing: (tabId: number) => boolean;
}

// 서비스 워커 쪽: 팝업의 연결을 듣는다. 처음 실행될 때 불러야 깨어나는 중에 온 연결도 받는다. 이 확장의 화면이 연 그 이름의
// 연결만 받고, 첫 메시지(탭 id)가 맞을 때부터 그 탭을 본다고 안다. 서비스 워커가 멈추면 연결이 모두 끊기고 팝업이 다시 잇는다.
export function watchPopups(): PopupWatch {
  const viewers = new Map<chrome.runtime.Port, number>();
  const extensionOrigin = new URL(chrome.runtime.getURL('')).origin;
  chrome.runtime.onConnect.addListener((port) => {
    const fromPopup =
      port.name === popupPort.name &&
      port.sender?.id === chrome.runtime.id &&
      port.sender.origin === extensionOrigin;
    if (!fromPopup) {
      port.disconnect();
      return;
    }
    port.onMessage.addListener((message: unknown) => {
      const hello = popupPort.hello.safeParse(message);
      if (hello.success) viewers.set(port, hello.data.tabId);
    });
    port.onDisconnect.addListener(() => {
      viewers.delete(port);
    });
  });
  return { viewing: (tabId) => [...viewers.values()].includes(tabId) };
}
