import { type IsolatedHost, createIsolatedHost } from '../../dom/index.ts';
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
  readonly host: IsolatedHost;
  readonly label: HTMLElement;
  readonly onRateChange: () => void;
}

export const page = definePagePart(mediaSpeed, (_settings, { window, document }) => {
  const indicators = new Map<HTMLVideoElement, Indicator>();
  let frame: number | null = null;

  const place = (video: HTMLVideoElement, indicator: Indicator) => {
    const rect = video.getBoundingClientRect();
    const visible =
      video.isConnected &&
      rect.width >= minimumVideoSize &&
      rect.height >= minimumVideoSize &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth;
    indicator.label.hidden = !visible;
    indicator.label.style.left = `${String(rect.left + offset)}px`;
    indicator.label.style.top = `${String(rect.top + offset)}px`;
  };

  const placeAll = () => {
    frame = null;
    for (const [video, indicator] of indicators) place(video, indicator);
  };

  // 스크롤과 크기 변경은 한 프레임에 한 번만 다시 놓는다.
  const schedule = () => {
    frame ??= window.requestAnimationFrame(placeAll);
  };

  const attach = (video: HTMLVideoElement) => {
    if (indicators.has(video)) return;
    const host = createIsolatedHost(document, {
      name: 'media-speed-indicator',
      css,
      parent: document.documentElement,
    });
    const label = document.createElement('div');
    label.className = 'indicator';
    host.root.append(label);
    const onRateChange = () => {
      label.textContent = formatRate(video.playbackRate);
    };
    onRateChange();
    video.addEventListener('ratechange', onRateChange);
    const indicator = { host, label, onRateChange };
    indicators.set(video, indicator);
    resizeObserver.observe(video);
    place(video, indicator);
  };

  const detach = (video: HTMLVideoElement) => {
    const indicator = indicators.get(video);
    if (indicator === undefined) return;
    video.removeEventListener('ratechange', indicator.onRateChange);
    resizeObserver.unobserve(video);
    indicator.host.remove();
    indicators.delete(video);
  };

  const videosIn = (node: Node): HTMLVideoElement[] => {
    if (node instanceof HTMLVideoElement) return [node];
    if (node instanceof Element) return [...node.querySelectorAll('video')];
    return [];
  };

  const resizeObserver = new ResizeObserver(schedule);
  // 바뀐 부분만 본다. 문서 전체를 되풀이해 훑지 않는다(quality 078).
  const mutationObserver = new MutationObserver((records) => {
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
  window.addEventListener('scroll', schedule, { capture: true, passive: true });
  window.addEventListener('resize', schedule, { passive: true });

  return () => {
    mutationObserver.disconnect();
    resizeObserver.disconnect();
    window.removeEventListener('scroll', schedule, { capture: true });
    window.removeEventListener('resize', schedule);
    if (frame !== null) window.cancelAnimationFrame(frame);
    for (const video of [...indicators.keys()]) detach(video);
  };
});
