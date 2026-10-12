import { type Scope, createIsolatedHost } from '../../dom/index.ts';
import { definePagePart } from '../../page/index.ts';
import { formatRate } from './core/rate.ts';
import { mediaSpeed } from './feature.ts';

// 배속 표시창의 가장 작은 판(05단계 뼈대). 영상마다 지금 실제 배속을 영상 왼쪽 위에 보인다.
// 드래그, 보이기·숨기기, 전체 화면은 06단계 MED-3에서 더한다.

// 화면에 보이지 않거나 가로·세로가 100px 미만인 영상에는 띄우지 않는다(MED-3 기대 동작 5).
const minimumVideoSize = 100;
const offset = 8;

const css = `
.indicator {
  position: fixed;
  z-index: 2147483647;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgb(0 0 0 / 0.75);
  color: #fff;
  font: 600 13px/1.4 system-ui, sans-serif;
  pointer-events: none;
}
.indicator[hidden] {
  display: none;
}
`;

interface Indicator {
  // 이 영상의 표시창에 속한 자원(화면 요소, 배속 바뀜 듣기, 크기 관찰). 영상이 사라지면 닫는다(quality 083).
  readonly scope: Scope;
  readonly label: HTMLElement;
}

export const page = definePagePart(mediaSpeed, (_settings, { window, document, scope }) => {
  const indicators = new Map<HTMLVideoElement, Indicator>();
  let cancelFrame: (() => void) | null = null;

  const place = (video: HTMLVideoElement, label: HTMLElement) => {
    const rect = video.getBoundingClientRect();
    const visible =
      video.isConnected &&
      rect.width >= minimumVideoSize &&
      rect.height >= minimumVideoSize &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth;
    label.hidden = !visible;
    label.style.left = `${String(rect.left + offset)}px`;
    label.style.top = `${String(rect.top + offset)}px`;
  };

  const placeAll = () => {
    cancelFrame = null;
    for (const [video, indicator] of indicators) place(video, indicator.label);
  };

  // 스크롤과 크기 변경은 한 프레임에 한 번만 다시 놓는다.
  const schedule = () => {
    cancelFrame ??= scope.animationFrame(placeAll);
  };

  const resizeObserver = scope.resizeObserver(schedule);

  const attach = (video: HTMLVideoElement) => {
    if (indicators.has(video)) return;
    const own = scope.child();
    const host = createIsolatedHost(document, {
      name: 'media-speed-indicator',
      css,
      parent: document.documentElement,
    });
    own.defer(host.remove);
    const label = document.createElement('div');
    label.className = 'indicator';
    host.root.append(label);
    indicators.set(video, { scope: own, label });
    own.defer(() => indicators.delete(video));
    const showRate = () => {
      label.textContent = formatRate(video.playbackRate);
    };
    showRate();
    own.listen(video, 'ratechange', showRate);
    resizeObserver.observe(video);
    own.defer(() => {
      resizeObserver.unobserve(video);
    });
    place(video, label);
  };

  const detach = (video: HTMLVideoElement) => {
    indicators.get(video)?.scope.close();
  };

  const videosIn = (node: Node): HTMLVideoElement[] => {
    if (node instanceof HTMLVideoElement) return [node];
    if (node instanceof Element) return [...node.querySelectorAll('video')];
    return [];
  };

  // 바뀐 부분만 본다. 문서 전체를 되풀이해 훑지 않는다(quality 078).
  const mutationObserver = scope.mutationObserver((records) => {
    for (const record of records) {
      for (const node of record.removedNodes) {
        for (const video of videosIn(node)) if (!video.isConnected) detach(video);
      }
      for (const node of record.addedNodes) {
        for (const video of videosIn(node)) if (video.isConnected) attach(video);
      }
    }
  });

  for (const video of document.querySelectorAll('video')) attach(video);
  mutationObserver.observe(document, { childList: true, subtree: true });
  scope.listen(window, 'scroll', schedule, { capture: true, passive: true });
  scope.listen(window, 'resize', schedule, { passive: true });
});
