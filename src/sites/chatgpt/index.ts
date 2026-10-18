import type { NamedElement, Scope } from '../../dom/index.ts';

// chatgpt.com의 화면 지식(결정 0004, 0031, 0032, 0034). 요소를 찾는 단서와 화면에 보이는 것, 너비를 바꾸는 규칙, 화면마다
// 있어야 할 요소, 사이트 안 이동 신호는 여기에만 둔다. 2026-10-18에 본 두 화면의 구조다: 로그인하지 않은 화면(영어, 새 대화 /와
// 대화 /uc/<id>)과 로그인한 화면(사용자의 Chrome, 새 채팅 /, 대화 /c/<id>, 프로젝트 안의 대화 /g/<이름>/c/<id>). 클래스 이름은
// 뜻 없는 원자 클래스이고 aria-label은 화면 언어의 문구라 쓰지 않는다. 남은 단서는 요소 종류와 data- 속성이다(R-13).

// 로그인하지 않은 화면: 메시지(li[data-message-role])를 담는 대화 기록 목록(최대 너비 없이 창 가득)과, 작성란(form)을 담고
// 그 최대 너비(768px)와 가운데 자리를 정하는 상자.
const signedOutThread = 'ol[data-conversation-transcript]';
const signedOutComposer = '[data-composer-positioner]';

// 로그인한 화면: 메시지 차례([data-turn-key])를 모두 담는 대화 열과 ChatGPT 작성 양식. 둘 다 바깥 상자가 사이트의 CSS 변수
// --thread-content-max-width(48rem)로 최대 너비를 정한다(결정 0032).
const signedInThread = '[data-thread-find-target]';
const signedInComposer = 'form[data-chatgpt-composer]';

// 대화 열과 작성란. 찾기(find)에 더해 화면에 보이는 것(shown)을 낸다.
interface ChatgptElement extends NamedElement {
  // 화면에 보이는 그 요소. 앞 화면이 숨긴 채 남긴 것(그려진 너비가 0)은 뺀다. 없으면 null이다. 그려진 크기를 읽어 문서의
  // 배치를 계산하게 하므로, 찾기와 달리 문서가 바뀔 때마다 부르지 않는다(결정 0034).
  readonly shown: (document: Document) => Element | null;
}

// 두 화면의 단서 가운데 하나라도 맞는 요소가 있으면 찾은 것이다. 숨긴 채 남은 앞 화면의 것도 찾은 것으로 본다.
function namedElement(id: string, name: string, selectors: readonly string[]): ChatgptElement {
  const selector = selectors.join(', ');
  return {
    id,
    name,
    find: (document) => document.querySelector(selector),
    shown: (document) =>
      [...document.querySelectorAll(selector)].find(
        (candidate) => candidate.getBoundingClientRect().width > 0,
      ) ?? null,
  };
}

export const thread = namedElement('chatgpt.thread', 'ChatGPT 대화 열', [
  signedOutThread,
  signedInThread,
]);

export const composer = namedElement('chatgpt.composer', 'ChatGPT 작성란', [
  signedOutComposer,
  signedInComposer,
]);

// 대화 열과 작성란의 최대 너비를 width(px)로 바꾸는 스타일 규칙(결정 0032). 두 화면의 규칙은 서로의 화면에 맞는 요소가 없어
// 함께 넣어도 부딪히지 않는다. 사이트의 규칙을 이기도록 !important를 단다.
// - 로그인한 화면: 사이트가 대화 열과 작성란의 바깥 상자(와 같은 열의 요소)의 최대 너비를 이 변수로 정한다. 상자마다 제
//   클래스로 값을 두어 물려받은 값보다 앞서므로 모든 요소에 둔다. 최대 너비라 창이 좁으면 상자에 맞춘다.
// - 로그인하지 않은 화면: 담는 상자를 채우되 width를 넘지 않는 가운데 열(바깥 너비가 곧 그 값, border-box). 너비를 채우라고
//   함께 적는 것은 부모가 세로 flex이면 가운데 여백(auto)이 늘이기를 막아 열이 내용 너비로 줄기 때문이다(결정 0031).
export function contentWidthCss(width: number): string {
  const px = `${String(width)}px`;
  return [
    `* { --thread-content-max-width: ${px} !important; }`,
    `${signedOutThread}, ${signedOutComposer} { box-sizing: border-box !important; width: 100% !important; max-width: ${px} !important; margin-inline: auto !important; }`,
  ].join('\n');
}

// 대화 화면의 주소: /c/<id>(로그인한 화면), /uc/<id>(로그인하지 않은 화면), 그 앞에 /g/<이름>/이 붙은 것(프로젝트와 GPT의
// 대화). 모두 2026-10-18에 봤다.
const conversationPath = /^\/(?:g\/[^/]+\/)?u?c\/[^/]+\/?$/;

// 그 화면에 늘 있어야 하는 요소. 새 대화 화면은 작성란, 대화 화면은 대화 열과 작성란이다. 있어야 할지 모르는 화면(GPT 목록
// 등)은 없다. 그런 화면에서 찾지 못함을 알리지 않기 위해서다.
export function expectedElements(location: Pick<Location, 'pathname'>): readonly ChatgptElement[] {
  if (location.pathname === '/') return [composer];
  if (conversationPath.test(location.pathname)) return [thread, composer];
  return [];
}

// 페이지 안 이동(대화 바꿈, 새 대화. 주소가 바뀐다)을 알린다. chatgpt.com은 문서를 다시 싣지 않고 주소를 바꾸므로
// Navigation API의 currententrychange를 그 범위로 듣는다.
export function watchNavigation(scope: Scope, window: Window, onNavigate: () => void): void {
  scope.listen(window.navigation, 'currententrychange', onNavigate);
}
