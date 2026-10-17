import { pageStatus, problemReport, taskNotice } from '../contracts/index.ts';
import { startPageRuntime } from '../page/index.ts';
import {
  chromeLocalStore,
  chromeRequester,
  isExtensionConnected,
  listenExtensionRequest,
} from '../platform/index.ts';
import { ok } from '../shared/index.ts';
import { settingsFormat, startSettingsReader } from '../storage/index.ts';
import { pageParts } from './generated/content-common.ts';

// 모든 http·https 페이지의 모든 프레임에 실리는 콘텐츠 스크립트(아키텍처 2장).
// 기능 목록은 싣지 않는다. 설정 읽기는 이 묶음에 페이지 쪽 일이 있는 기능의 정의만 안다(결정 0027).

const request = chromeRequester();

startPageRuntime({
  parts: pageParts,
  context: { window, document },
  // iframe의 최상위 창은 이 창이 아니다(출처가 달라도 견줄 수 있다).
  topFrame: window.top === window,
  subscribe: (handlers) =>
    startSettingsReader(
      {
        store: chromeLocalStore(),
        request,
        format: settingsFormat,
        specs: pageParts.map((part) => part.feature),
      },
      handlers,
    ),
  report: (problem) => request(problemReport, problem),
  isConnected: isExtensionConnected,
  listenNotices: (show) =>
    listenExtensionRequest(taskNotice, ({ text }) => {
      show(text);
      return ok(null);
    }),
  listenStatus: (answer) => listenExtensionRequest(pageStatus, () => ok(answer())),
});
