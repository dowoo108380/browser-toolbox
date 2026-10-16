import { render } from 'preact';
import {
  featuresWithSettings,
  popupRemember,
  repairNoticeDismiss,
  settingsUpdate,
  storageEnsureReady,
  tabStatus,
  taskSeen,
  taskStart,
} from '../contracts/index.ts';
import { features } from '../features/list.ts';
import {
  chromeLocalStore,
  chromeRequester,
  chromeSessionStore,
  currentTabId,
} from '../platform/index.ts';
import {
  readRememberedCategory,
  settingsFormat,
  startSettingsReader,
  watchRepairNotice,
  watchTask,
} from '../storage/index.ts';
import { PopupApp } from '../ui/index.ts';

const request = chromeRequester();
const store = chromeLocalStore();
const session = chromeSessionStore();

const root = document.getElementById('root');
if (root === null) throw new Error('팝업 문서에 #root가 없다.');

render(
  <PopupApp
    features={features}
    subscribe={(handlers) =>
      startSettingsReader(
        { store, request, format: settingsFormat, specs: featuresWithSettings(features) },
        handlers,
      )
    }
    watchRepairs={(handlers) => watchRepairNotice(store, handlers)}
    // 서비스 워커를 깨우는 데 storage.ensureReady를 쓴다. 설정이 준비되었으면 바로 응답한다(아키텍처 4장).
    wake={() => request(storageEnsureReady, {})}
    update={(featureId, patch) => request(settingsUpdate, { featureId, patch })}
    dismissRepair={(stamp) => request(repairNoticeDismiss, { stamp })}
    rememberedCategory={() => readRememberedCategory(store)}
    rememberCategory={(category) => request(popupRemember, { category })}
    currentTab={currentTabId}
    tabStatus={(tabId) => request(tabStatus, { tabId })}
    startTask={(featureId, tabId) => request(taskStart, { featureId, tabId })}
    watchTask={(tabId, handlers) => watchTask(session, tabId, handlers)}
    taskSeen={(tabId, taskId) => request(taskSeen, { tabId, taskId })}
  />,
  root,
);
