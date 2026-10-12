// 웹 페이지 위에 띄우는 확장의 화면 요소 틀(결정 0007).
// 닫힌 shadow root 안에 스타일과 함께 넣어 페이지 CSS와 서로 영향을 주지 않는다(quality 005, MED-3.5).

// 페이지에 넣는 요소의 태그와 표식. 확장 고유의 접두어를 쓴다(quality 005).
export const hostTagName = 'browser-toolbox-ui';
const hostNameAttribute = 'data-browser-toolbox';

export interface IsolatedHost {
  readonly host: HTMLElement;
  readonly root: ShadowRoot;
  readonly remove: () => void;
}

export function createIsolatedHost(
  document: Document,
  options: { readonly name: string; readonly css: string; readonly parent: Element },
): IsolatedHost {
  const host = document.createElement(hostTagName);
  host.setAttribute(hostNameAttribute, options.name);
  // 페이지 CSS가 host 요소 자체에 걸 수 있는 것(예: 모든 요소 숨김)을 막는다.
  // 인라인 !important는 페이지 스타일시트의 !important보다 앞선다.
  host.style.setProperty('all', 'initial', 'important');
  host.style.setProperty('display', 'block', 'important');
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = options.css;
  root.append(style);
  options.parent.append(host);
  return {
    host,
    root,
    remove: () => {
      host.remove();
    },
  };
}
