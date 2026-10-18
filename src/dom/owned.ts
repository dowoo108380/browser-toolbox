// 확장이 웹 페이지에 넣은 요소의 표식과, 이 세계(이 콘텐츠 스크립트 묶음)가 넣은 요소의 목록(결정 0008).
// 새 판은 물러남 이벤트의 토큰이 적히지 않은 표식 요소를 옛 세계가 남긴 것으로 보고 지운다.

// 확장이 페이지에 넣은 모든 요소에 붙인다. 값은 그 요소의 이름이다.
export const pageElementAttribute = 'data-browser-toolbox';
// 물러남 이벤트를 받은 살아 있는 실행 틀이 자기 요소에 그 이벤트의 토큰을 적는다.
export const claimAttribute = 'data-browser-toolbox-claim';

// 스크립트가 실린 세계마다 따로 있다.
const owned = new Set<Element>();

// 페이지에 넣기 전의 요소에 표식을 달고 이 세계의 요소로 둔다. 돌려준 함수는 목록에서 빼고 페이지에서 지운다.
export function ownElement(element: Element, name: string): () => void {
  element.setAttribute(pageElementAttribute, name);
  owned.add(element);
  return () => {
    owned.delete(element);
    element.remove();
  };
}

// 이 세계가 넣은 요소에 토큰을 적는다. 새 판이 이 토큰이 없는 요소를 지운다.
export function claimOwnedElements(token: string): void {
  for (const element of owned) element.setAttribute(claimAttribute, token);
}
