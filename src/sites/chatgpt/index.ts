import type { NamedElement, Scope } from '../../dom/index.ts';

// chatgpt.com의 화면 지식(결정 0004, 0031). 선택자, 화면마다 있어야 할 요소, 사이트 안 이동 신호는 여기에만 둔다.
// 2026-10-18에 로그인하지 않은 화면(영어)의 새 대화(/)와 대화(/uc/<id>)에서 본 구조다. 클래스 이름은 뜻 없는 원자 클래스이고
// aria-label은 화면 언어의 문구라 쓰지 않는다. 남은 단서는 요소 종류와 data- 속성이다(R-13). 로그인한 화면은 수동
// 절차(tests/manual/chatgpt-width.md)로 본다.

// 이름 붙은 요소에, 그 요소를 찾고 스타일을 걸 선택자를 더한 것. 선택자에 맞는 요소가 하나라도 있으면 찾은 것이다.
export interface SiteElement extends NamedElement {
  readonly selector: string;
}

function siteElement(id: string, name: string, selector: string): SiteElement {
  return { id, name, selector, find: (document) => document.querySelector(selector) };
}

// 대화 화면에서 메시지(li[data-message-role])를 담는 목록. 로그인하지 않은 화면에서는 최대 너비가 없어 창 가득 퍼진다.
export const thread = siteElement(
  'chatgpt.thread',
  'ChatGPT 대화 열',
  'ol[data-conversation-transcript]',
);

// 작성란(form)을 담고 그 최대 너비(768px)와 가운데 자리를 정하는 상자. 새 대화 화면과 대화 화면에 있다.
export const composer = siteElement(
  'chatgpt.composer',
  'ChatGPT 작성란',
  '[data-composer-positioner]',
);

// 대화 화면의 주소. /uc/<id>는 로그인하지 않은 화면에서 봤다. /c/<id>(로그인한 화면)와 그 앞에 /g/<이름>/이 붙은 것(GPT와
// 프로젝트의 대화)은 이 세션에서 보지 않았다(추측, 수동 절차로 확인한다).
const conversationPath = /^\/(?:g\/[^/]+\/)?u?c\/[^/]+\/?$/;

// 그 화면에 늘 있어야 하는 요소. 새 대화 화면은 작성란, 대화 화면은 대화 열과 작성란이다. 있어야 할지 모르는 화면(GPT 목록
// 등)은 없다. 그런 화면에서 찾지 못함을 알리지 않기 위해서다.
export function expectedElements(location: Pick<Location, 'pathname'>): readonly SiteElement[] {
  if (location.pathname === '/') return [composer];
  if (conversationPath.test(location.pathname)) return [thread, composer];
  return [];
}

// 페이지 안 이동(대화 바꿈, 새 대화. 주소가 바뀐다)을 알린다. chatgpt.com은 문서를 다시 싣지 않고 주소를 바꾸므로
// Navigation API의 currententrychange를 그 범위로 듣는다.
export function watchNavigation(scope: Scope, window: Window, onNavigate: () => void): void {
  scope.listen(window.navigation, 'currententrychange', onNavigate);
}
