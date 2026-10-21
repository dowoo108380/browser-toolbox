import { ownElement } from './owned.ts';

// 웹 페이지 위에 띄우는 확장의 화면 요소 틀(결정 0007).
// 닫힌 shadow root 안에 스타일과 함께 넣어 페이지 CSS와 서로 영향을 주지 않는다(quality 005, MED-3.5).
// 최상위 층(top layer)에 띄우면 페이지의 다른 최상위 층 요소(대화 상자, 전체 화면 요소)보다 위에 그려진다. 나중에 띄운 것이
// 위다(결정 0018). 띄우는 화면이 셋(배속 표시창, 작업 결과 알림, 캡처의 영역 고르기)이 되어 이 틀이 popover로 띄운다(결정 0018
// 고친 기록의 계획, 0048).

// 페이지에 넣는 화면 요소의 태그. 확장 고유의 접두어를 쓴다(quality 005).
export const hostTagName = 'browser-toolbox-ui';

interface IsolatedHost {
  readonly host: HTMLElement;
  readonly root: ShadowRoot;
  readonly remove: () => void;
}

interface IsolatedHostOptions {
  readonly name: string;
  readonly css: string;
  readonly parent: Element;
  // 있으면 popover(manual)로 최상위 층에 띄운다. source가 있으면 그 요소를 앵커로 삼는다(CSS 앵커 위치). host를 지우면 닫힌다.
  readonly topLayer?: { readonly source?: HTMLElement };
}

export function createIsolatedHost(document: Document, options: IsolatedHostOptions): IsolatedHost {
  const host = document.createElement(hostTagName);
  const remove = ownElement(host, options.name);
  // 페이지 CSS가 host 요소 자체에 걸 수 있는 것(예: 모든 요소 숨김)을 막는다.
  // 인라인 !important는 페이지 스타일시트의 !important보다 앞선다.
  host.style.setProperty('all', 'initial', 'important');
  host.style.setProperty('display', 'block', 'important');
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = options.css;
  root.append(style);
  options.parent.append(host);
  if (options.topLayer !== undefined) {
    host.setAttribute('popover', 'manual');
    const { source } = options.topLayer;
    host.showPopover(source === undefined ? undefined : { source });
  }
  return { host, root, remove };
}
