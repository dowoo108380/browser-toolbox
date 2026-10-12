import { startBackground } from '../background/index.ts';
import { retireEventName } from '../contracts/index.ts';
import { features } from '../features/list.ts';
import {
  chromeLocalStore,
  dispatchEventInAllFrames,
  listenInstalled,
  listenRequests,
} from '../platform/index.ts';
import { settingsFormat } from '../storage/index.ts';

// 서비스 워커. Chrome 이벤트는 처음 실행될 때 바로 걸어야 하므로 여기서 곧바로 시작한다.
startBackground({
  features,
  format: settingsFormat,
  store: chromeLocalStore(),
  now: () => Date.now(),
  listenRequests,
  onInstalled: listenInstalled,
  retireOldScripts: () => dispatchEventInAllFrames(retireEventName),
});
