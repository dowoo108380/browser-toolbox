// 웹 페이지 위에 띄우는 확장의 화면 요소 틀(결정 0007).
// 닫힌 shadow root 안에 스타일과 함께 넣어 페이지 CSS와 서로 영향을 주지 않는다(quality 005, MED-3.5).

// 페이지에 넣는 요소의 태그와 표식. 확장 고유의 접두어를 쓴다(quality 005).
export const hostTagName = 'browser-toolbox-ui';
// 확장이 페이지에 넣은 모든 요소에 붙인다. 새 판이 옛 판의 요소를 찾을 때 쓴다(결정 0008).
export const pageElementAttribute = 'data-browser-toolbox';
// 물러남 이벤트를 받은 살아 있는 실행 틀이 자기 요소에 그 이벤트의 토큰을 적는다(결정 0008).
export const claimAttribute = 'data-browser-toolbox-claim';

export interface IsolatedHost {
  readonly host: HTMLElement;
  readonly root: ShadowRoot;
  readonly remove: () => void;
}

// 이 세계(이 콘텐츠 스크립트 묶음)가 만든 요소. 스크립트가 실린 세계마다 따로 있다.
const ownedHosts = new Set<HTMLElement>();

export function createIsolatedHost(
  document: Document,
  options: { readonly name: string; readonly css: string; readonly parent: Element },
): IsolatedHost {
  const host = document.createElement(hostTagName);
  host.setAttribute(pageElementAttribute, options.name);
  // 페이지 CSS가 host 요소 자체에 걸 수 있는 것(예: 모든 요소 숨김)을 막는다.
  // 인라인 !important는 페이지 스타일시트의 !important보다 앞선다.
  host.style.setProperty('all', 'initial', 'important');
  host.style.setProperty('display', 'block', 'important');
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = options.css;
  root.append(style);
  options.parent.append(host);
  ownedHosts.add(host);
  return {
    host,
    root,
    remove: () => {
      ownedHosts.delete(host);
      host.remove();
    },
  };
}

// 이 세계가 만든 요소에 토큰을 적는다. 새 판이 이 토큰이 없는 요소를 지운다(결정 0008).
export function claimOwnedHosts(token: string): void {
  for (const host of ownedHosts) host.setAttribute(claimAttribute, token);
}
