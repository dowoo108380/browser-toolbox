import { type TaskServices, defineTaskPart } from '../../background/index.ts';
import { injectedApiKey, injectedScriptFile, v } from '../../contracts/index.ts';
import {
  type AppError,
  type Result,
  appError,
  err,
  isWebPage,
  ok,
  runMachine,
  withTimeout,
} from '../../shared/index.ts';
import type { TaskOutcome } from '../../storage/index.ts';
import { type PageMethod, answers, imageWaitMs, selectionLimitMs } from './api.ts';
import {
  type CaptureEffect,
  type CaptureEvent,
  type CaptureState,
  type Ending,
  type Failure,
  type Mode,
  type PageRef,
  type Shot,
  initialCapture,
  transition,
} from './core/capture.ts';
import { capturePath } from './core/filename.ts';
import {
  type Rect,
  type Size,
  maxAreaDevicePx,
  maxCopyDevicePx,
  maxSideDevicePx,
  placeOf,
} from './core/geometry.ts';
import { pageCapture } from './feature.ts';
import { strings } from './strings.ts';

// 캡처의 서비스 워커 쪽(PAGE-1, 결정 0046–0048). 작업 하나마다 캡처의 상태 기계(core/capture.ts)를 돌리고, 그 할 일을 한다:
// 페이지 쪽 스크립트(inject.ts) 넣기와 그 일 부르기, 디버거(관리를 함께 쓴다, 결정 0042)의 화면 높이 바꾸기와 찍기, 디버거 없는
// 보이는 화면 찍기, 조각 이어 붙이기(OffscreenCanvas), 저장과 복사(저장·클립보드 서비스, 결정 0047). 할 일의 결과는 그 차례
// 번호를 실은 사건으로 돌려 넣는다. 작업의 기록(작업 실행이 시작할 때 진행 중을 씀)이 이 캡처가 붙잡은 것보다 먼저 생기고 나중에
// 없어진다(결정 0038): 일은 붙잡은 것을 모두 되돌린 뒤에 끝난다. 서비스 워커가 그 사이에 멈추면 다음 시작이 interrupted로 치운다.

const user = pageCapture.id;
const apiKey = injectedApiKey(user);
const scriptFile = injectedScriptFile(user);

// 페이지 쪽 일을 기다리는 한도. 그 일들은 곧 끝난다(이미지 기다리기와 영역 고르기는 자기 한도에 여유를 더한다).
const callTimeoutMs = 5000;
const slack = 5000;

type Blobs = CaptureState<Blob, Blob>;
type Event = CaptureEvent<Blob, Blob>;
type Effect = CaptureEffect<Blob, Blob>;

const folderOf = (path: string) => path.slice(0, path.indexOf('/'));

// 디버거의 Page.getLayoutMetrics에서 쓰는 것: 페이지 확대(CSS 픽셀에서 DIP로의 비율, 양수).
const metricsSchema = v.object({
  cssVisualViewport: v.object({ zoom: v.pipe(v.number(), v.minValue(Number.MIN_VALUE)) }),
});

// 디버거가 준 PNG(base64)나 보이는 화면(data URL)을 Blob으로. 서비스 워커는 data URL을 fetch로 읽을 수 있다.
async function blobOf(dataUrl: string): Promise<Blob> {
  return (await fetch(dataUrl)).blob();
}

// 찍은 그림들을 결과 그림 하나로 잇는다(R-10: 조각으로 찍어 캔버스에 잇는다). 서비스 워커에도 OffscreenCanvas가 있다
// (2026-10-21 실험: 2400×50000을 0.8초에 잇고 0.2초에 PNG로 만들었다). 조각은 1 CSS 픽셀 겹치고 뒤 조각이 덮는다. 그림은
// 그것이 덮는 네모(placeOf)의 왼쪽 위에 놓는다. Chrome은 그림의 크기를 따로 반올림하므로 그림이 그 네모보다 1픽셀 작을 수
// 있다(그대로 놓으면 결과 그림의 끝에 빈 줄이 남는다). 작으면 네모까지 늘리고(점을 섞지 않아 한 줄을 되풀이할 뿐 흐려지지
// 않는다), 크면 그대로 놓는다(넘친 줄은 뒤 조각이 덮거나 결과 그림 밖이라 잘린다).
async function compose(
  target: Rect,
  dpr: number,
  size: Size,
  shots: readonly Shot<Blob>[],
): Promise<Blob> {
  const canvas = new OffscreenCanvas(size.width, size.height);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('캔버스를 만들지 못했다.');
  context.imageSmoothingEnabled = false;
  for (const shot of shots) {
    const bitmap = await createImageBitmap(shot.data);
    const at = placeOf(shot.rect, target, dpr);
    context.drawImage(
      bitmap,
      at.x,
      at.y,
      Math.max(bitmap.width, at.width),
      Math.max(bitmap.height, at.height),
    );
    bitmap.close();
  }
  return canvas.convertToBlob({ type: 'image/png' });
}

// 상태 기계의 끝을 작업의 끝(짧은 결과, 실패 이유)으로. inFolder는 요청한 하위 폴더에 저장했는지다(Chrome이 저장할 곳을 물어
// 사용자가 다른 곳을 고르면 거짓, platform의 downloadFile).
function outcomeOf(ending: Ending, path: string, inFolder: boolean): TaskOutcome {
  if (ending.ok) {
    const parts = [
      inFolder ? strings.saved(folderOf(path), ending.name) : strings.savedElsewhere(ending.name),
    ];
    switch (ending.copy) {
      case 'copied':
        parts.push(strings.copied);
        break;
      case 'too-big':
        parts.push(strings.tooBigToCopy(ending.size, maxCopyDevicePx));
        break;
      case 'failed':
        parts.push(strings.copyFailed);
        break;
    }
    if (ending.partial !== null) parts.push(strings.partial[ending.partial]);
    return ok({ summary: parts.join(' ') });
  }
  return err(errorOf(ending.failure));
}

function errorOf(failure: Failure): AppError {
  switch (failure.kind) {
    case 'error':
      return failure.error;
    case 'too-large':
      return appError('limit', strings.tooLarge(failure.size, maxSideDevicePx, maxAreaDevicePx));
    case 'page-changed':
      return appError('unavailable', strings.pageChanged);
    case 'ended':
      return failure.reason === 'error'
        ? appError('unexpected', strings.ended.error)
        : appError('cancelled', strings.ended[failure.reason]);
    case 'lost':
      return failure.loss === 'cancelled'
        ? appError('cancelled', strings.debuggerCancelled)
        : appError('unavailable', strings.debuggerClosed);
    case 'aborted':
      return appError('cancelled', strings.aborted);
  }
}

// 탭 하나의 캡처 하나.
function capture(
  services: TaskServices,
  tabId: number,
  windowId: number,
  mode: Mode,
  path: string,
  signal: AbortSignal,
  lost: Map<number, (loss: 'cancelled' | 'closed') => void>,
): Promise<TaskOutcome> {
  return new Promise((resolve) => {
    // 저장한 파일이 요청한 하위 폴더에 있는지(결과의 문구가 다르다).
    let inFolder = true;
    // 페이지 쪽 일을 부르고 답을 검증한다. 답한 문서도 준다.
    const call = async <S>(
      method: PageMethod,
      args: readonly unknown[],
      schema: v.Schema<S>,
      timeoutMs = callTimeoutMs,
    ): Promise<Result<{ readonly page: PageRef; readonly value: S }, AppError>> => {
      const answered = await withTimeout(timeoutMs, () =>
        services.callInjected(tabId, apiKey, method, args),
      );
      if (!answered.done) return err(appError('timeout', strings.pageSlow));
      if (!answered.value.ok) {
        // 넣은 스크립트가 없는 문서이거나 문서가 사라졌다: 그 사이에 페이지를 옮겼다(platform의 callInjected).
        return answered.value.error.kind === 'unavailable'
          ? err(appError('unavailable', strings.pageChanged))
          : answered.value;
      }
      const { documentId, href, value } = answered.value.value;
      const parsed = v.safeParse(schema, value);
      if (!parsed.success) return err(appError('unexpected', strings.answerShape));
      return ok({ page: { documentId, href }, value: parsed.output });
    };
    const send = (method: string, params: Readonly<Record<string, unknown>> = {}) =>
      services.debuggers.send(tabId, method, params);
    const shotSchema = v.object({ data: v.string() });
    // 페이지 확대(CSS 픽셀 하나가 DIP 몇 개인지, R-10). 디버거 명령의 길이(화면 높이, 찍을 영역)는 CSS 픽셀이
    // 아니라 DIP이고, 찍은 그림은 그 DIP에 화면 배율을 곱한 크기다(CSS 픽셀로 보면 devicePixelRatio = 화면 배율 × 확대).
    // 2026-10-21 실험(화면 배율 1.25, 확대 125%): 영역 100×400을 주면 125×500 그림에 80×320 CSS 픽셀이 담겼고, 화면 높이 2000을
    // 주면 1600 CSS 픽셀이었다. 그래서 페이지가 잰 CSS 길이에 확대를 곱해 보낸다. 할 일마다 묻는다(명령과 같은 때의 값이다).
    const zoomOf = async (): Promise<Result<number, AppError>> => {
      const metrics = await send('Page.getLayoutMetrics');
      if (!metrics.ok) return metrics;
      const parsed = v.safeParse(metricsSchema, metrics.value);
      return parsed.success
        ? ok(parsed.output.cssVisualViewport.zoom)
        : err(appError('unexpected', strings.metricsShape));
    };

    // 할 일 하나를 하고 그 결과를 사건으로 넣는다. 일이 던지면(일어나면 안 됨) 그 차례의 실패로 넣는다.
    const later = (step: number, work: () => Promise<Result<Event, AppError>>) => {
      work()
        .catch(() => err(appError('unexpected', strings.unexpected)))
        .then((result) => {
          machine.dispatch(
            result.ok ? result.value : { type: 'failed', step, error: result.error },
          );
        })
        // 사건의 할 일이 던지는 것도 일어나면 안 된다. 기다리는 쪽이 없으므로 기록한다(quality 067).
        .catch(() => {
          services.record({ featureId: user, kind: 'unexpected' });
        });
    };

    const stop = () => {
      machine.dispatch({ type: 'abort' });
    };

    const perform = (effect: Effect): void => {
      switch (effect.type) {
        case 'inject': {
          const { step } = effect;
          later(step, async () => {
            const injected = await services.injectScript(tabId, scriptFile);
            return injected.ok ? ok({ type: 'injected', step }) : injected;
          });
          return;
        }
        case 'select': {
          const { step } = effect;
          later(step, async () => {
            const chosen = await call('select', [], answers.select, selectionLimitMs + slack);
            return chosen.ok
              ? ok({ type: 'picked', step, page: chosen.value.page, picked: chosen.value.value })
              : chosen;
          });
          return;
        }
        case 'attach': {
          const { step } = effect;
          later(step, async () => {
            const acquired = await services.debuggers.acquire(tabId, user);
            return acquired.ok ? ok({ type: 'attached', step }) : acquired;
          });
          return;
        }
        case 'prepare': {
          const { step } = effect;
          later(step, async () => {
            const prepared = await call('prepare', [], answers.prepare);
            return prepared.ok
              ? ok({
                  type: 'prepared',
                  step,
                  page: prepared.value.page,
                  plan: prepared.value.value,
                })
              : prepared;
          });
          return;
        }
        case 'expand': {
          const { step, height } = effect;
          later(step, async () => {
            const zoom = await zoomOf();
            if (!zoom.ok) return zoom;
            // 너비와 배율은 그대로 두고(0은 바꾸지 않음) 높이만 바꾼다. 페이지는 화면이 그만큼(CSS 픽셀) 높은 것으로 배치한다.
            const expanded = await send('Emulation.setDeviceMetricsOverride', {
              width: 0,
              height: Math.ceil(height * zoom.value),
              deviceScaleFactor: 0,
              mobile: false,
            });
            return expanded.ok ? ok({ type: 'expanded', step }) : expanded;
          });
          return;
        }
        case 'settle': {
          const { step } = effect;
          later(step, async () => {
            const settled = await call('settle', [], answers.done);
            return settled.ok ? ok({ type: 'settled', step }) : settled;
          });
          return;
        }
        case 'shrink': {
          const { step } = effect;
          later(step, async () => {
            const shrunk = await send('Emulation.clearDeviceMetricsOverride');
            return shrunk.ok ? ok({ type: 'shrunk', step }) : shrunk;
          });
          return;
        }
        case 'waitImages': {
          const { step, rect } = effect;
          later(step, async () => {
            const waited = await call(
              'waitImages',
              [rect, imageWaitMs],
              answers.waited,
              imageWaitMs + slack,
            );
            return waited.ok ? ok({ type: 'waited', step }) : waited;
          });
          return;
        }
        case 'measure': {
          const { step, what } = effect;
          later(step, async () => {
            const measured = await call('measure', [what], answers.measure);
            return measured.ok
              ? ok({ type: 'measured', step, measure: measured.value.value })
              : measured;
          });
          return;
        }
        case 'position': {
          const { step, point } = effect;
          later(step, async () => {
            const positioned = await call('position', [point], answers.done);
            return positioned.ok ? ok({ type: 'positioned', step }) : positioned;
          });
          return;
        }
        case 'shoot': {
          const { step, clip, beyond } = effect;
          later(step, async () => {
            const zoom = await zoomOf();
            if (!zoom.ok) return zoom;
            const dip = (css: number) => css * zoom.value;
            const shot = await send('Page.captureScreenshot', {
              format: 'png',
              fromSurface: true,
              captureBeyondViewport: beyond,
              clip: {
                x: dip(clip.x),
                y: dip(clip.y),
                width: dip(clip.width),
                height: dip(clip.height),
                scale: 1,
              },
            });
            if (!shot.ok) return shot;
            const parsed = v.safeParse(shotSchema, shot.value);
            if (!parsed.success) return err(appError('unexpected', strings.shotShape));
            const data = await blobOf(`data:image/png;base64,${parsed.output.data}`);
            return ok({ type: 'shot', step, data });
          });
          return;
        }
        case 'shootVisible': {
          const { step } = effect;
          later(step, async () => {
            // 창의 보이는 화면은 그 창의 활성 탭이다. 그 사이에 다른 탭으로 갔으면 찍지 않는다.
            const tab = await services.tabInfo(tabId);
            if (tab?.active !== true) return err(appError('unavailable', strings.pageChanged));
            const shot = await services.captureVisibleTab(windowId);
            if (!shot.ok) return shot;
            return ok({ type: 'shot', step, data: await blobOf(shot.value) });
          });
          return;
        }
        case 'restore': {
          const { step } = effect;
          later(step, async () => {
            const restored = await call('restore', [], answers.done);
            return restored.ok ? ok({ type: 'restored', step }) : restored;
          });
          return;
        }
        case 'verify': {
          const { step } = effect;
          later(step, async () => {
            const now = await call('ping', [], answers.done);
            return now.ok ? ok({ type: 'verified', step, page: now.value.page }) : now;
          });
          return;
        }
        case 'compose': {
          const { step, target, dpr, shots } = effect;
          later(step, async () => {
            const size = {
              width: Math.round(target.width * dpr),
              height: Math.round(target.height * dpr),
            };
            try {
              const image = await compose(target, dpr, size, shots);
              return ok({ type: 'composed', step, image, size });
            } catch {
              return err(appError('platform', strings.composeFailed));
            }
          });
          return;
        }
        case 'save': {
          const { step, image } = effect;
          later(step, async () => {
            const saved = await services.files.save(image, path);
            if (!saved.ok) return saved;
            inFolder = saved.value.inFolder;
            return ok({ type: 'saved', step, name: saved.value.name });
          });
          return;
        }
        case 'copy': {
          const { step, image } = effect;
          later(step, async () => {
            const copied = await services.files.copyImage(image, path.slice(path.indexOf('/') + 1));
            // 복사하지 못해도 저장은 했다. 결과에 알리고, 까닭은 기록한다(quality 067).
            if (!copied.ok) services.record({ featureId: user, kind: copied.error.kind });
            return ok({ type: 'copied', step, copied: copied.ok });
          });
          return;
        }
        case 'release':
          services.debuggers.release(tabId, user);
          return;
        case 'finish':
          lost.delete(tabId);
          signal.removeEventListener('abort', stop);
          resolve(outcomeOf(effect.ending, path, inFolder));
          return;
      }
    };

    const machine = runMachine<Blobs, Event, Effect>(initialCapture, transition, perform);
    lost.set(tabId, (loss) => {
      machine.dispatch({ type: 'lost', loss });
    });
    signal.addEventListener('abort', stop, { once: true });
    machine.dispatch({ type: 'start', mode });
    if (signal.aborted) stop();
  });
}

export const task = defineTaskPart(pageCapture, (services) => {
  // 진행 중인 캡처의 디버거 끊김을 그 캡처에 넘긴다(탭마다 캡처는 하나다, COM-10 기대 동작 6).
  const lost = new Map<number, (loss: 'cancelled' | 'closed') => void>();
  services.debuggers.onLost(user, (tabId, loss) => {
    lost.get(tabId)?.(loss);
  });
  return {
    run: async ({ tabId, action, signal }) => {
      const tab = await services.tabInfo(tabId);
      if (tab === null) return err(appError('unavailable', strings.tabGone));
      const url = tab.url === undefined ? null : URL.parse(tab.url);
      if (url === null || !isWebPage(tab.url)) {
        return err(appError('unavailable', strings.webPageOnly));
      }
      const path = capturePath(action, services.now(), url.hostname);
      return capture(services, tabId, tab.windowId, action, path, signal, lost);
    },
    // 앞 서비스 워커의 캡처가 남겼을 수 있는 것을 치운다(결정 0038, 0048). 늘린 화면 높이는 그 연결을 다른 쪽(활성 상태 유지)이
    // 이미 다시 쓰면 이 명령이 되돌리고, 아무도 쓰지 않으면 남은 연결을 떼어 Chrome이 함께 없앤다(2026-10-21 실험: 서비스 워커가
    // 멈춘 뒤에도 연결과 늘린 높이가 남았고, 다음 서비스 워커가 떼자 높이가 돌아왔다). 페이지 쪽은 바꾼 스크롤과
    // 고르는 화면을 되돌린다(그 문서가 그대로면). 되돌릴 것이 없으면 아무 일이 없다.
    interrupted: async (tabId) => {
      await services.debuggers.send(tabId, 'Emulation.clearDeviceMetricsOverride', {});
      services.debuggers.discard(tabId);
      await withTimeout(callTimeoutMs, () => services.callInjected(tabId, apiKey, 'restore', []));
    },
  };
});
