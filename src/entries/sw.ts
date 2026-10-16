import { startBackground } from '../background/index.ts';
import { pageRuntimeKey, retireEventName } from '../contracts/index.ts';
import { claimAttribute, pageElementAttribute } from '../dom/index.ts';
import { features } from '../features/list.ts';
import {
  chromeLocalStore,
  chromeSessionStore,
  listenInstalled,
  listenRequests,
  listenTabEvents,
  probePageRuntime,
  retireInAllFrames,
  setTabBadge,
  tabExists,
} from '../platform/index.ts';
import { settingsFormat } from '../storage/index.ts';
import { taskParts } from './generated/sw.ts';

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
});
