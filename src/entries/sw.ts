import { startBackground } from '../background/index.ts';
import {
  featureCommand,
  pageRuntimeKey,
  pageStatus,
  retireEventName,
  tabStateChanged,
  taskNotice,
} from '../contracts/index.ts';
import { claimAttribute, pageElementAttribute } from '../dom/index.ts';
import { features } from '../features/list.ts';
import {
  allTabInfos,
  attachDebugger,
  callInjected,
  captureVisibleTab,
  closeOffscreenDocument,
  chromeLocalStore,
  chromeSessionStore,
  detachDebugger,
  downloadFile,
  injectScriptFile,
  isTabActive,
  listenDebuggerLoss,
  listenInstalled,
  listenRequests,
  listenTabEvents,
  offscreenRequester,
  openOffscreenDocument,
  probePageRuntime,
  retireInAllFrames,
  sendDebuggerCommand,
  sendToAllFrames,
  sendToTab,
  setAutoDiscardable,
  setTabBadge,
  tabExists,
  tabInfo,
  watchPopups,
  watchTabActivity,
  windowInfo,
} from '../platform/index.ts';
import { settingsFormat } from '../storage/index.ts';
import { tabToggleParts, taskParts } from './generated/sw.ts';

// 서비스 워커. Chrome 이벤트는 처음 실행될 때 바로 걸어야 하므로 여기서 곧바로 시작한다.
startBackground({
  features,
  format: settingsFormat,
  store: chromeLocalStore(),
  session: chromeSessionStore(),
  taskParts,
  randomId: () => crypto.randomUUID(),
  tabExists,
  setTabBadge,
  listenTabEvents,
  watchPopups,
  isTabActive,
  notifyTab: async (tabId, text) => (await sendToTab(taskNotice, tabId, { text })).delivery,
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
  listenRequests,
  onInstalled: listenInstalled,
  retireOldScripts: (report) =>
    retireInAllFrames(
      { eventName: retireEventName, elementAttribute: pageElementAttribute, claimAttribute },
      report,
    ),
  probePage: (tabId) => probePageRuntime(tabId, pageRuntimeKey),
  askPage: (tabId, timeoutMs) => sendToTab(pageStatus, tabId, {}, timeoutMs),
  tabToggleParts,
  attachDebugger,
  detachDebugger,
  sendDebuggerCommand,
  listenDebuggerLoss,
  tabInfo,
  allTabInfos,
  setAutoDiscardable,
  windowInfo,
  watchTabActivity,
  pushTabState: (tabId, state) => sendToAllFrames(tabStateChanged, tabId, state),
  sendFeatureCommand: (tabId, message) => sendToTab(featureCommand, tabId, message),
  injectScript: injectScriptFile,
  callInjected,
  captureVisibleTab,
  openOffscreen: openOffscreenDocument,
  closeOffscreen: closeOffscreenDocument,
  offscreenRequest: offscreenRequester(),
  downloadFile,
});
