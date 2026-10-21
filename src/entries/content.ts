import {
  type PageBundle,
  featureCommand,
  pageStatus,
  problemReport,
  tabStateChanged,
  tabStateGet,
  taskNotice,
} from '../contracts/index.ts';
import { type FeaturePagePart, startPageRuntime, subscribeTabState } from '../page/index.ts';
import {
  chromeLocalStore,
  chromeRequester,
  isExtensionConnected,
  listenExtensionRequest,
} from '../platform/index.ts';
import { ok } from '../shared/index.ts';
import {
  parseTabToggleHint,
  settingsFormat,
  startSettingsReader,
  tabToggleHintKey,
} from '../storage/index.ts';

// 콘텐츠 스크립트 묶음(content-common, content-<사이트>)의 진입점이 함께 쓰는 시작(아키텍처 2장, 결정 0029).
// 묶음마다 다른 것은 그 묶음의 페이지 쪽 일과 묶음 이름뿐이다. 기능 목록은 싣지 않는다. 설정 읽기는 그 묶음에 페이지
// 쪽 일이 있는 기능의 정의만 안다(결정 0027).
export function startContentScript(parts: readonly FeaturePagePart[], bundle: PageBundle): void {
  const request = chromeRequester();
  const store = chromeLocalStore();
  startPageRuntime({
    parts,
    bundle,
    context: { window, document },
    // iframe의 최상위 창은 이 창이 아니다(출처가 달라도 견줄 수 있다).
    topFrame: window.top === window,
    subscribe: (handlers) =>
      startSettingsReader(
        {
          store,
          request,
          format: settingsFormat,
          specs: parts.map((part) => part.feature),
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
    subscribeTab: (handlers) =>
      subscribeTabState(
        {
          hint: async () => parseTabToggleHint(await store.get(tabToggleHintKey)),
          ask: () => request(tabStateGet, {}),
          listen: (receive) =>
            listenExtensionRequest(tabStateChanged, (state) => {
              receive(state);
              return ok(null);
            }),
          restored: (handle) => {
            const onPageShow = (event: PageTransitionEvent) => {
              if (event.persisted) handle();
            };
            window.addEventListener('pageshow', onPageShow);
            return () => {
              window.removeEventListener('pageshow', onPageShow);
            };
          },
          featureIds: parts
            .filter((part) => part.toggledBy === 'tab')
            .map((part) => part.featureId),
        },
        handlers,
      ),
    sendCommand: (featureId, name, payload) =>
      request(featureCommand, { featureId, name, payload }),
    listenCommands: (handle) =>
      listenExtensionRequest(featureCommand, ({ featureId, name, payload }) =>
        handle(featureId, name, payload),
      ),
  });
}
