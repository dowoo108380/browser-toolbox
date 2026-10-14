import { type Scope, createIsolatedHost } from '../../dom/index.ts';
import { definePagePart } from '../../page/index.ts';
import { formatRate } from './core/rate.ts';
import { mediaSpeed } from './feature.ts';

// 배속 표시창의 가장 작은 판(05단계 뼈대). 영상마다 지금 실제 배속을 영상 왼쪽 위에 보인다.
// 드래그, 보이기·숨기기, 전체 화면은 06단계 MED-3에서 더한다.
//
// 표시창은 페이지의 최상위 층(top layer)에 popover로 띄우고, 위치는 브라우저가 영상에 붙여 잡는다(CSS 앵커 위치, 결정 0018).
// 그래서 영상이 스크롤, 앞 내용의 추가·제거·크기 변경, 문서 안 이동, transform으로 옮겨져도 스크립트 없이 따라간다.

// 가로나 세로가 100px 미만인 영상에는 띄우지 않는다(MED-3 기대 동작 5). 화면 밖의 영상은 표시창도 함께 화면 밖에 있고,
// 스크롤 컨테이너에 가려진 영상은 position-visibility가 숨긴다.
const minimumVideoSize = 100;

// :host의 !important 선언은 shadow 안쪽의 것이라 host에 붙은 인라인 스타일(all: initial !important)과 페이지 CSS보다 앞선다.
// - position-anchor의 초기값은 Chrome 판마다 다르다(150은 none, 151부터 normal). auto라야 popover를 연 source(영상)가 앵커다.
// - position-visibility는 명세가 단수형(anchor-visible)으로 이름을 바꾸는 중이다. 지원하는 쪽이 쓰이게 둘 다 적는다.
// - host 상자가 영상 위의 클릭을 가로채지 않게 한다(누르기와 드래그는 MED-3에서 정한다).
const css = `
:host {
  position: fixed !important;
  position-anchor: auto !important;
  top: calc(anchor(top) + 8px) !important;
  left: calc(anchor(left) + 8px) !important;
  position-visibility: anchors-visible !important;
  position-visibility: anchor-visible !important;
  pointer-events: none !important;
}
.indicator {
  padding: 2px 6px;
  border-radius: 4px;
  background: rgb(0 0 0 / 0.75);
  color: #fff;
  font: 600 13px/1.4 system-ui, sans-serif;
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

export const page = definePagePart(mediaSpeed, (_settings, { document, scope }) => {
  const indicators = new Map<Element, Indicator>();

  // 크기가 바뀔 때만 보일지 정한다. display: none인 영상은 크기가 0이다.
  const resizeObserver = scope.resizeObserver((entries) => {
    for (const { target, contentRect } of entries) {
      const indicator = indicators.get(target);
      if (indicator === undefined) continue;
      indicator.label.hidden =
        contentRect.width < minimumVideoSize || contentRect.height < minimumVideoSize;
    }
  });

  const attach = (video: HTMLVideoElement) => {
    if (indicators.has(video)) return;
    const own = scope.child();
    const { host, root, remove } = createIsolatedHost(document, {
      name: 'media-speed-indicator',
      css,
      parent: document.documentElement,
    });
    own.defer(remove);
    const label = document.createElement('div');
    label.className = 'indicator';
    // 보일지는 크기 관찰이 정한다. 관찰을 시작하면 크기가 0이어도 첫 화면 그리기 전에 첫 알림이 오고, 그때까지는 숨겨 둔다.
    label.hidden = true;
    root.append(label);
    indicators.set(video, { scope: own, label });
    own.defer(() => indicators.delete(video));
    const showRate = () => {
      label.textContent = formatRate(video.playbackRate);
    };
    showRate();
    own.listen(video, 'ratechange', showRate);
    // 최상위 층에 띄우고 이 영상을 앵커로 삼는다. 영상에는 아무것도 적지 않는다. host를 지우면 popover도 닫힌다.
    host.setAttribute('popover', 'manual');
    host.showPopover({ source: video });
    resizeObserver.observe(video);
    own.defer(() => {
      resizeObserver.unobserve(video);
    });
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
});
