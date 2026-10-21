import { type Scope, createIsolatedHost } from '../../dom/index.ts';
import { definePagePart } from '../../page/index.ts';
import { formatRate } from './core/rate.ts';
import { mediaSpeed } from './feature.ts';

// 배속 표시창의 가장 작은 판(05단계 뼈대). 영상마다 지금 실제 배속을 영상 왼쪽 위에 보인다.
// 영상은 문서와 열린 shadow root 안에서 찾는다(결정 0019).
// 드래그, 보이기·숨기기, 전체 화면은 06단계 MED-3에서 더한다.
//
// 표시창은 페이지의 최상위 층(top layer)에 popover로 띄우고, 자리와 크기는 브라우저가 영상에 붙여 잡는다(CSS 앵커 위치, 결정 0018).
// host는 영상이 화면에 그려진 상자(transform을 반영한 경계 상자)와 같은 자리, 같은 크기이고, 표시창은 그 왼쪽 위에 있다.
// 그래서 영상이 스크롤, 앞 내용의 추가·제거·크기 변경, 문서 안 이동, transform으로 옮겨지거나 커지고 줄어도 스크립트 없이 따라간다.
//
// 보일지도 CSS가 정한다. 스크립트가 다시 볼 때를 고르지 않으므로 transform만 바뀌는 경우도 빠지지 않는다.
// - 화면에 그려진 가로나 세로가 100px 미만이면 숨긴다(MED-3 기대 동작 5): host를 크기 컨테이너로 삼은 컨테이너 쿼리.
//   영상이 display: none이면 앵커가 없어 host가 0×0이므로 숨는다.
// - 스크롤 컨테이너에 가려졌거나 visibility: hidden인 영상: position-visibility.
// - 화면 밖의 영상: 표시창도 함께 화면 밖에 있다.
//
// :host의 !important 선언은 shadow 안쪽의 것이라 host에 붙은 인라인 스타일(all: initial !important)과 페이지 CSS보다 앞선다.
// - position-anchor의 초기값은 Chrome 판마다 다르다(150은 none, 151부터 normal). auto라야 popover를 연 source(영상)가 앵커다.
// - anchor()와 anchor-size()는 Chrome 144부터 transform을 반영한 경계 상자로 정해진다.
// - position-visibility는 명세가 단수형(anchor-visible)으로 이름을 바꾸는 중이다. 지원하는 쪽이 쓰이게 둘 다 적는다.
// - host 상자는 영상을 덮지만 클릭을 가로채지 않는다(누르기와 드래그는 MED-3에서 정한다).
const css = `
:host {
  position: fixed !important;
  position-anchor: auto !important;
  top: anchor(top) !important;
  left: anchor(left) !important;
  width: anchor-size(width, 0px) !important;
  height: anchor-size(height, 0px) !important;
  container-type: size !important;
  position-visibility: anchors-visible !important;
  position-visibility: anchor-visible !important;
  pointer-events: none !important;
}
.indicator {
  position: absolute;
  top: 8px;
  left: 8px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgb(0 0 0 / 0.75);
  color: #fff;
  font: 600 13px/1.4 system-ui, sans-serif;
}
@container (width < 100px) or (height < 100px) {
  .indicator {
    display: none;
  }
}
`;

export const page = definePagePart(mediaSpeed, (_settings, { document, scope }) => {
  // 영상마다 그 표시창에 속한 자원(화면 요소, 배속 바뀜 듣기). 영상이 사라지면 닫는다(quality 083).
  const indicators = new Map<HTMLVideoElement, Scope>();

  const attach = (video: HTMLVideoElement) => {
    if (indicators.has(video)) return;
    const own = scope.child();
    // 최상위 층에 띄우고 이 영상을 앵커로 삼는다. 영상에는 아무것도 적지 않는다. host를 지우면 popover도 닫힌다.
    const { root, remove } = createIsolatedHost(document, {
      name: 'media-speed-indicator',
      css,
      parent: document.documentElement,
      topLayer: { source: video },
    });
    own.defer(remove);
    const label = document.createElement('div');
    label.className = 'indicator';
    root.append(label);
    indicators.set(video, own);
    own.defer(() => indicators.delete(video));
    const showRate = () => {
      label.textContent = formatRate(video.playbackRate);
    };
    showRate();
    own.listen(video, 'ratechange', showRate);
  };

  // 영상은 문서 트리에도, 사용자 정의 요소 등의 열린 shadow root 안(겹친 것 포함)에도 있다(결정 0019).
  // 관찰 하나로 문서와 찾은 열린 shadow root를 모두 본다. 관찰은 그 트리 안의 바뀜만 알리고 안쪽 shadow root의 바뀜은
  // 알리지 않으므로, 훑다가 만난 열린 shadow root도 관찰한다. 바뀐 부분만 본다. 문서 전체를 되풀이해 훑지 않는다(quality 078).
  const mutationObserver = scope.mutationObserver((records) => {
    let removed = false;
    for (const record of records) {
      if (record.removedNodes.length > 0) removed = true;
      for (const node of record.addedNodes) if (node instanceof Element) visit(node);
    }
    // 사라진 영상은 표시창이 있는 영상 가운데서 찾는다. 지워진 부분(그 안의 shadow root까지)은 훑지 않는다.
    // 문서에서 떼어 낸 요소의 shadow root 안 영상도 문서에서 빠졌으므로 함께 닫힌다.
    if (!removed) return;
    for (const [video, own] of indicators) if (!video.isConnected) own.close();
  });

  // tree와 그 아래, 그 안의 열린 shadow root 안까지 훑어 문서에 붙어 있는 영상에 띄우고, 만난 열린 shadow root를 관찰한다.
  // 닫힌 shadow root에는 들어가지 않는다(결정 0019). 문서에서 떼어 낸 요소의 root는 관찰을 풀지 않는다(관찰은 대상을
  // 붙잡지 않는다). 그 요소가 다시 붙으면 더해진 요소로 다시 훑는다.
  function visit(tree: Document | Element) {
    const pending: (Document | Element | ShadowRoot)[] = [tree];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      const walker = document.createTreeWalker(next, NodeFilter.SHOW_ELEMENT);
      for (let node: Node | null = walker.currentNode; node !== null; node = walker.nextNode()) {
        if (node instanceof HTMLVideoElement && node.isConnected) attach(node);
        const root = node instanceof Element ? node.shadowRoot : null;
        if (root !== null) {
          mutationObserver.observe(root, { childList: true, subtree: true });
          pending.push(root);
        }
      }
    }
  }

  visit(document);
  mutationObserver.observe(document, { childList: true, subtree: true });
});
