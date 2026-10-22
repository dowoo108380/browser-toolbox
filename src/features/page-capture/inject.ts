import { injectedApiKey, retireEventName } from '../../contracts/index.ts';
import { type Scope, createIsolatedHost, createScope } from '../../dom/index.ts';
import { isExtensionConnected } from '../../platform/index.ts';
import { type PageApi, selectionLimitMs } from './api.ts';
import {
  type Measure,
  type Measured,
  type Picked,
  type Plan,
  sameAddress,
} from './core/capture.ts';
import type { Point, Rect } from './core/geometry.ts';
import { rectBetween, scrollStep, tooSmall } from './core/selection.ts';
import { pageCapture } from './feature.ts';
import { strings } from './strings.ts';

// 캡처의 페이지 쪽(PAGE-1, 결정 0046, 0048). 누를 때 서비스 워커가 그 탭의 최상위 문서의 확장의 격리된 세계에 넣고(entries/
// inject-page-capture.ts), 그 세계의 전역에 일(api.ts의 PageApi)을 둔다. 서비스 워커가 그 일을 차례로 불러 찍을 대상을 정하고
// 디버거로 찍는다. 한 문서에 여러 번 넣어도 일은 처음 것 하나다. 페이지에 바꾼 것(스크롤, 상자의 스크롤, 고르는 화면)은 restore가
// 되돌린다. 확장을 다시 불러오면(연결이 끊김) 고르는 화면을 스스로 지운다(결정 0008의 물러남).

// 화면 대부분: 보이는 넓이의 절반 넘게(기대 동작 4, 제안).
const majorityShare = 0.5;

// 화면을 두 번 그리기를 기다리는 한도. 숨은 문서는 그리지 않으므로(Chrome이 화면 그리기 예약을 부르지 않는다) 이만큼 지나면 끝낸다.
const settleLimitMs = 300;

// 이미지를 다시 보는 간격.
const imagePollMs = 100;

// 주소를 다시 보는 간격. 페이지가 주소를 돌려놓는 것은 화면을 한 번 그릴 때쯤이다(api.ts의 addressWaitMs).
const addressPollMs = 50;

const css = `
:host {
  position: fixed !important;
  inset: 0 !important;
  width: auto !important;
  height: auto !important;
  max-width: none !important;
  max-height: none !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  background: transparent !important;
  overflow: hidden !important;
  cursor: crosshair !important;
  user-select: none !important;
  touch-action: none !important;
}
.surface {
  position: absolute;
  inset: 0;
}
.box {
  position: absolute;
  display: none;
  box-sizing: border-box;
  border: 2px solid #1a73e8;
  background: rgb(26 115 232 / 0.15);
  pointer-events: none;
}
.hint {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  padding: 6px 12px;
  border-radius: 6px;
  background: rgb(0 0 0 / 0.85);
  color: #fff;
  font: 14px/1.4 system-ui, sans-serif;
  pointer-events: none;
  white-space: nowrap;
}
`;

// 기억한 스크롤과 고른 상자(prepare, position). restore가 되돌린다.
interface Saved {
  readonly scroll: Point;
  readonly box: { readonly element: Element; readonly top: number } | null;
}

const scrollPoint = (): Point => ({ x: window.scrollX, y: window.scrollY });

const scrollTo = (point: Point) => {
  window.scrollTo({ left: point.x, top: point.y, behavior: 'instant' });
};

const rootOf = () => document.scrollingElement ?? document.documentElement;

const viewportSize = () => ({ width: window.innerWidth, height: window.innerHeight });

// 요소의 문서 좌표의 네모.
function rectOf(element: Element): Rect {
  const box = element.getBoundingClientRect();
  return {
    x: box.x + window.scrollX,
    y: box.y + window.scrollY,
    width: box.width,
    height: box.height,
  };
}

function documentRect(): Rect {
  const root = rootOf();
  return {
    x: 0,
    y: 0,
    width: Math.max(root.scrollWidth, root.clientWidth),
    height: Math.max(root.scrollHeight, root.clientHeight),
  };
}

const clipsOverflow = (element: Element | null) => {
  if (element === null) return false;
  const value = getComputedStyle(element).overflowY;
  return value === 'hidden' || value === 'clip';
};

// 문서가 화면을 넘치는지.
function documentOverflows(): boolean {
  const root = rootOf();
  return root.scrollHeight > root.clientHeight + 1 || root.scrollWidth > root.clientWidth + 1;
}

// 사용자가 문서 자체를 스크롤할 수 있는지. 넘친 것이 있어도 html이나 body가 넘친 것을 감추면 아니다(앱 화면의 흔한 모양).
function documentScrolls(): boolean {
  return (
    documentOverflows() && !clipsOverflow(document.documentElement) && !clipsOverflow(document.body)
  );
}

// 사용자가 세로로 스크롤할 수 있는 상자(문서 자체는 뺀다).
function scrollsVertically(element: Element): boolean {
  if (element === document.documentElement || element === document.body) return false;
  const value = getComputedStyle(element).overflowY;
  const scrollable = value === 'auto' || value === 'scroll' || value === 'overlay';
  return scrollable && element.scrollHeight > element.clientHeight + 1;
}

// 요소의 보이는 넓이(화면과 겹친 부분).
function visibleArea(element: Element): number {
  const box = element.getBoundingClientRect();
  const width = Math.min(box.right, window.innerWidth) - Math.max(box.left, 0);
  const height = Math.min(box.bottom, window.innerHeight) - Math.max(box.top, 0);
  return Math.max(0, width) * Math.max(0, height);
}

// 요소에서 바깥쪽으로(열린 shadow root를 넘어) 올라간다.
function* ancestorsOf(element: Element): Generator<Element> {
  let current: Element | null = element;
  while (current !== null) {
    yield current;
    const parent: Element | null = current.parentElement;
    const root = current.getRootNode();
    current = parent ?? (root instanceof ShadowRoot ? root.host : null);
  }
}

// 화면 대부분을 차지하는 스크롤 상자(기대 동작 4). 화면을 3×3으로 나눈 칸의 가운데에 있는 요소와 그 조상에서 찾는다. 보이는
// 넓이가 화면의 절반을 넘는 상자는 반드시 화면 가운데를 덮으므로 빠뜨리지 않고, 문서 전체를 훑지 않는다(quality 078). 사이트마다
// 따로 보지 않는다. 스크롤되는 상자가 있었는지도 함께 준다.
function findBox(): { readonly box: Element | null; readonly any: boolean } {
  const { innerWidth: width, innerHeight: height } = window;
  const seen = new Set<Element>();
  let best: Element | null = null;
  let bestArea = 0;
  for (const column of [1, 3, 5]) {
    for (const row of [1, 3, 5]) {
      for (const hit of document.elementsFromPoint((width * column) / 6, (height * row) / 6)) {
        for (const element of ancestorsOf(hit)) {
          if (seen.has(element)) break;
          seen.add(element);
          if (!scrollsVertically(element)) continue;
          const area = visibleArea(element);
          if (area > bestArea) {
            best = element;
            bestArea = area;
          }
        }
      }
    }
  }
  const qualifies = best !== null && bestArea > width * height * majorityShare;
  return { box: qualifies ? best : null, any: best !== null };
}

// 화면에 그려지고 주소가 있는데 아직 다 불러오지 않은 이미지가 rect(없으면 어디든)와 겹치는지.
function pendingImages(rect: Rect | null): number {
  let count = 0;
  for (const image of document.images) {
    const source =
      image.currentSrc !== '' || image.getAttribute('src') !== null || image.srcset !== '';
    if (image.complete || !source || !image.checkVisibility()) continue;
    if (rect !== null) {
      const box = rectOf(image);
      const apart =
        box.x + box.width < rect.x ||
        box.y + box.height < rect.y ||
        box.x > rect.x + rect.width ||
        box.y > rect.y + rect.height;
      if (apart) continue;
    }
    count += 1;
  }
  return count;
}

// 일 하나의 자원 범위. 확장과의 연결이 끊기면(다시 불러옴) 콜백을 부르지 않는다. 범위의 예외는 onError로 받는다.
function scopeFor(onError: (error: unknown) => void): Scope {
  return createScope({ window, onError, isLive: isExtensionConnected });
}

// 정한 수만큼 화면을 그리거나, 한도가 지나면 끝난다. 기다리기만 하고 페이지를 바꾸지 않으므로 확장과의 연결이 끊긴 뒤에도 끝난다
// (고르기를 끝낸 뒤 답하기 전에 기다린다).
function frames(count: number): Promise<null> {
  return new Promise((resolve) => {
    const scope = createScope({
      window,
      onError: () => {
        scope.close();
        resolve(null);
      },
      isLive: () => true,
    });
    const done = () => {
      scope.close();
      resolve(null);
    };
    scope.timeout(settleLimitMs, done);
    const next = (left: number) => {
      if (left === 0) {
        done();
        return;
      }
      scope.animationFrame(() => {
        next(left - 1);
      });
    };
    next(count);
  });
}

// 영역을 고르는 화면(기대 동작 5). 닫힌 shadow root 안에 두고(페이지 스타일과 서로 영향을 주지 않는다) 최상위 층에 띄운다(페이지의
// 대화 상자나 전체 화면 요소보다 위). 끄는 동안 화면 가장자리에 가까우면 문서를 저절로 스크롤한다. 안쪽 상자는 스크롤하지 않는다.
// 사용자의 입력(신뢰된 이벤트)만 받는다. 웹 페이지가 만든 이벤트로 영역을 고르거나 끝내지 못하게 하기 위해서다(quality 081).
// cancel은 고르기를 끝까지 하지 않고 그 까닭으로 끝낸다(되돌리기, 물러남).
function startSelection(resolve: (picked: Picked) => void): { readonly cancel: () => void } {
  let ended = false;
  const scope = scopeFor(() => {
    end({ kind: 'ended', reason: 'error' });
  });
  const { root, remove } = createIsolatedHost(document, {
    name: 'page-capture-selection',
    css,
    parent: document.documentElement,
    topLayer: {},
  });
  scope.defer(remove);
  const surface = document.createElement('div');
  surface.className = 'surface';
  const box = document.createElement('div');
  box.className = 'box';
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.setAttribute('role', 'status');
  hint.textContent = strings.hint;
  root.append(surface, box, hint);

  // 끄는 중이면 시작한 점과 그때의 스크롤, 지금 포인터의 화면 좌표.
  let drag: { readonly start: Point; readonly startScroll: Point; pointer: Point } | null = null;
  let scrolling = false;

  function end(picked: Picked) {
    if (ended) return;
    ended = true;
    scope.close();
    // 고르기를 끝낸 것(취소)은 찍지 않으므로 곧 답한다. 떠나는 문서(pagehide)는 화면을 그리지 않아 기다리면 답하지 못하고, 뒤로·앞으로
    // 캐시에 드는 문서는 멈춘 채 남아 서비스 워커가 고르기의 한도(2분)까지 기다렸다(2026-10-22 실험).
    if (picked.kind === 'ended') {
      resolve(picked);
      return;
    }
    // 고른 영역은 고르는 화면이 찍히지 않게 지운 뒤 화면을 두 번 그리고 답한다.
    void frames(2).then(() => {
      resolve(picked);
    });
  }

  const current = (): Point | null =>
    drag === null
      ? null
      : { x: drag.pointer.x + window.scrollX, y: drag.pointer.y + window.scrollY };

  const draw = () => {
    const at = current();
    if (drag === null || at === null) {
      box.style.display = 'none';
      return;
    }
    const rect = rectBetween(drag.start, at);
    box.style.display = 'block';
    box.style.left = `${String(rect.x - window.scrollX)}px`;
    box.style.top = `${String(rect.y - window.scrollY)}px`;
    box.style.width = `${String(rect.width)}px`;
    box.style.height = `${String(rect.height)}px`;
  };

  // 끄는 동안 포인터가 가장자리에 있으면 화면을 그릴 때마다 문서를 조금씩 스크롤한다.
  const autoScroll = () => {
    if (scrolling || drag === null) return;
    const step = scrollStep(drag.pointer, viewportSize());
    if (step.x === 0 && step.y === 0) return;
    scrolling = true;
    scope.animationFrame(() => {
      scrolling = false;
      if (drag === null) return;
      const next = scrollStep(drag.pointer, viewportSize());
      window.scrollBy({ left: next.x, top: next.y, behavior: 'instant' });
      draw();
      autoScroll();
    });
  };

  scope.listen(surface, 'pointerdown', (event) => {
    if (!event.isTrusted || !(event instanceof PointerEvent) || event.button !== 0) return;
    event.preventDefault();
    surface.setPointerCapture(event.pointerId);
    const pointer = { x: event.clientX, y: event.clientY };
    drag = {
      start: { x: pointer.x + window.scrollX, y: pointer.y + window.scrollY },
      startScroll: scrollPoint(),
      pointer,
    };
    hint.textContent = strings.hint;
    draw();
  });
  scope.listen(surface, 'pointermove', (event) => {
    if (drag === null || !event.isTrusted || !(event instanceof PointerEvent)) return;
    drag.pointer = { x: event.clientX, y: event.clientY };
    draw();
    autoScroll();
  });
  scope.listen(surface, 'pointerup', (event) => {
    if (drag === null || !event.isTrusted || !(event instanceof PointerEvent)) return;
    if (event.button !== 0) return;
    drag.pointer = { x: event.clientX, y: event.clientY };
    const at = current();
    const { start, startScroll } = drag;
    drag = null;
    if (at === null) return;
    const rect = rectBetween(start, at);
    if (tooSmall(rect)) {
      // 다시 고르게 한다(기대 동작 5).
      hint.textContent = strings.hintTooSmall;
      draw();
      return;
    }
    end({
      kind: 'picked',
      rect,
      view: { ...scrollPoint(), ...viewportSize() },
      start: startScroll,
      dpr: window.devicePixelRatio,
    });
  });
  scope.listen(surface, 'contextmenu', (event) => {
    if (!event.isTrusted) return;
    event.preventDefault();
    end({ kind: 'ended', reason: 'right-click' });
  });
  scope.listen(
    window,
    'keydown',
    (event) => {
      if (!event.isTrusted || !(event instanceof KeyboardEvent) || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      end({ kind: 'ended', reason: 'escape' });
    },
    { capture: true },
  );
  scope.listen(window, 'scroll', draw, { passive: true });
  scope.listen(window, 'pagehide', (event) => {
    if (event.isTrusted) end({ kind: 'ended', reason: 'left' });
  });
  // 확장을 다시 불러오면 새 판이 물러남 이벤트를 보낸다. 연결이 끊겼을 때만 따른다(결정 0008: 웹 페이지가 흉내 낼 수 있다).
  // 범위는 끊긴 뒤 콜백을 부르지 않으므로 연결의 확인은 범위 밖에서 한다.
  const retire = () => {
    if (!isExtensionConnected()) end({ kind: 'ended', reason: 'error' });
  };
  // eslint-disable-next-line no-restricted-syntax -- 연결이 끊긴 뒤에도 불려야 해서 범위로 감싸지 않는다(위). 범위가 닫히면 그만둔다.
  document.addEventListener(retireEventName, retire);
  scope.defer(() => {
    document.removeEventListener(retireEventName, retire);
  });
  scope.timeout(selectionLimitMs, () => {
    end({ kind: 'ended', reason: 'timeout' });
  });
  return {
    cancel: () => {
      end({ kind: 'ended', reason: 'error' });
    },
  };
}

function createPageApi(): PageApi {
  let saved: Saved | null = null;
  let chosen: Element | null = null;
  let selection: { readonly cancel: () => void } | null = null;

  const remember = (box: Element | null) => {
    saved ??= {
      scroll: scrollPoint(),
      box: box === null ? null : { element: box, top: box.scrollTop },
    };
  };

  const measure = (what: Measured): Measure => {
    const dpr = window.devicePixelRatio;
    const viewport = viewportSize();
    switch (what) {
      case 'document':
        return { rect: documentRect(), overflow: 0, viewport, dpr };
      case 'box': {
        if (chosen?.isConnected !== true) throw new Error('고른 스크롤 상자가 문서에 없다.');
        return {
          rect: rectOf(chosen),
          overflow: chosen.scrollHeight - chosen.clientHeight,
          viewport,
          dpr,
        };
      }
      case 'viewport': {
        // 페이지를 확대하면 보이는 화면이 CSS 픽셀로 소수인데 clientHeight는 정수로 반올림해 화면보다 클 수 있다(그 줄은 화면
        // 밖이라 페이지 바탕색으로 찍혔다, 2026-10-21 시험). visualViewport는 소수 그대로다(스크롤 막대는 뺀다).
        const view = window.visualViewport;
        const root = rootOf();
        const rect =
          view === null
            ? { ...scrollPoint(), width: root.clientWidth, height: root.clientHeight }
            : { x: view.pageLeft, y: view.pageTop, width: view.width, height: view.height };
        return { rect, overflow: 0, viewport, dpr };
      }
    }
  };

  return {
    select: () =>
      new Promise((resolve) => {
        selection?.cancel();
        const started = startSelection((picked) => {
          if (selection === started) selection = null;
          resolve(picked);
        });
        selection = started;
      }),
    prepare: (): Plan => {
      const dpr = window.devicePixelRatio;
      const viewport = viewportSize();
      if (documentScrolls()) {
        remember(null);
        scrollTo({ x: 0, y: 0 });
        return { target: 'document', rect: documentRect(), viewport, dpr };
      }
      const found = findBox();
      if (found.box !== null) {
        chosen = found.box;
        remember(found.box);
        const { rect, overflow } = measure('box');
        return { target: 'box', rect, overflow, viewport, dpr };
      }
      // 스크롤되는 상자가 있는데 화면 대부분이 아니거나 문서가 넘친 것을 감추면 보이는 화면을 찍는다. 아무것도 스크롤되지
      // 않고 넘치지도 않으면 문서가 화면에 다 있다.
      if (found.any || documentOverflows()) return { target: 'viewport' };
      return { target: 'document', rect: documentRect(), viewport, dpr };
    },
    settle: () => frames(2),
    waitImages: (rect, limitMs) =>
      new Promise((resolve) => {
        const started = performance.now();
        const scope = scopeFor(() => {
          scope.close();
          resolve({ pending: pendingImages(rect) });
        });
        const check = () => {
          const pending = pendingImages(rect);
          if (pending === 0 || performance.now() - started >= limitMs) {
            scope.close();
            resolve({ pending });
            return;
          }
          scope.timeout(imagePollMs, check);
        };
        check();
      }),
    measure,
    position: (point) => {
      remember(null);
      scrollTo(point);
      return null;
    },
    restore: () => {
      selection?.cancel();
      selection = null;
      const restoring = saved;
      saved = null;
      chosen = null;
      if (restoring === null) return null;
      if (restoring.box?.element.isConnected === true) {
        restoring.box.element.scrollTop = restoring.box.top;
      }
      scrollTo(restoring.scroll);
      return null;
    },
    ping: () => null,
    awaitAddress: (href, limitMs) =>
      new Promise((resolve) => {
        const started = performance.now();
        const scope = scopeFor(() => {
          scope.close();
          resolve(null);
        });
        const check = () => {
          if (sameAddress(href, location.href) || performance.now() - started >= limitMs) {
            scope.close();
            resolve(null);
            return;
          }
          scope.timeout(addressPollMs, check);
        };
        check();
      }),
  };
}

// 이 세계의 전역에 일을 둔다. 이미 있으면(같은 문서에 다시 넣음) 그 일을 그대로 쓴다. 기억한 것을 잃지 않기 위해서다.
export function installPageApi(): void {
  const key = Symbol.for(injectedApiKey(pageCapture.id));
  if (Reflect.get(globalThis, key) === undefined) Reflect.set(globalThis, key, createPageApi());
}
