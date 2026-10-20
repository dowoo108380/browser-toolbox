import type { NamedElement, Scope } from '../../dom/index.ts';

// claude.ai의 화면 지식(결정 0004, 0040). 요소를 찾는 단서, 너비를 바꾸는 규칙, 화면마다 있어야 할 요소, 사이트 안 이동
// 신호는 여기에만 둔다. 2026-10-20에 사용자의 Chrome(로그인한 화면)에서 본 두 화면의 구조다: 새 채팅(/new)과 기존 대화
// (/chat/<id>). 답을 만드는 동안의 구조도 봤다. 클래스 이름은 꾸미기용 유틸리티 클래스이고 aria-label은 화면 언어의 문구라 쓰지
// 않는다. 남은 단서는 요소 종류와 data- 속성의 이름이다(속성의 값은 보지 않았다, R-13). 사이트가 상태에 따라 떼었다 다는 속성은
// 단서로 쓰지 않는다.

// 대화 화면: 메시지와 작성란을 담는 열. 사이트의 CSS 변수 --transcript-width(48rem)에 좌우 안쪽 여백 20px씩을 더한 최대
// 너비로 가운데에 놓인다. 그 안의 대화 기록 상자(메시지 행 [data-transcript-row]를 담음)는 최대 너비가 그 변수 그대로이고,
// 작성란 칸([data-chat-input-container])은 열을 채운다. 열은 작성란 칸을 바로 담는 상자로 가린다. 열의 속성
// data-transcript-stays-put-scope는 사이트가 답을 만드는 동안 뗐다 다시 다는 상태라 단서가 아니다(이슈 #9).
const column = ':has(> [data-chat-input-container])';
const transcriptRow = '[data-transcript-row]';
// 새 채팅 화면: 작성란을 담는 자리. 사이트가 최대 너비를 변수 없이 40rem으로 두고, 그 부모(속성 없음)가 최대 너비
// 80rem(--container-7xl)과 좌우 안쪽 여백 3.5rem씩으로 화면의 틀을 정한다.
const newChatSlot = '[data-chorus-card-slot]';

// 단서에 맞는 요소들. 화면마다 하나였다(앞 화면을 숨긴 채 남기지 않았다). 그래도 지금 화면의 것은 찾기와 확인이 고른다(dom,
// 결정 0035).
function namedElement(id: string, name: string, selector: string): NamedElement {
  return { id, name, candidates: (document) => document.querySelectorAll(selector) };
}

// 대화 열: 열 안에서 메시지 행을 담는 대화 기록 상자. 그려진 너비가 사이트의 변수 그대로다(안쪽 여백 포함). 답을 만드는
// 동안에도 같은 상자다.
export const thread = namedElement(
  'claude.thread',
  'Claude 대화 열',
  `${column} > :has(${transcriptRow})`,
);

// 작성란: 작성 칸의 카드를 담는 상자. 두 화면에 모두 있고, 그려진 너비가 그 화면이 작성란에 주는 너비다.
export const composer = namedElement(
  'claude.composer',
  'Claude 작성란',
  '[data-composer-card-holder]',
);

// 대화 열과 작성란의 최대 너비를 width(px)로 바꾸는 스타일 규칙(결정 0040). 사이트의 규칙을 이기도록 !important를 단다.
// - 대화 화면: 사이트가 열과 대화 기록 상자의 최대 너비를 이 변수로 정하므로 모든 요소에 둔다(ChatGPT와 같은 까닭, 결정
//   0032). 최대 너비라 창이 좁으면 상자에 맞춘다.
// - 새 채팅 화면: 작성란 자리의 최대 너비를 그 값으로 하고, 화면의 틀이 그것을 묶지 않도록 틀의 최대 너비를 사이트의 값과
//   (그 값 + 틀의 좌우 안쪽 여백 7rem) 가운데 큰 것으로 한다. 사이트의 값보다 좁은 너비에서는 틀이 그대로다.
// 두 화면의 규칙은 서로의 화면에 맞는 요소가 없어 함께 넣어도 부딪히지 않는다.
export function contentWidthCss(width: number): string {
  const px = `${String(width)}px`;
  return [
    `* { --transcript-width: ${px} !important; }`,
    `${newChatSlot} { max-width: ${px} !important; }`,
    `:has(> ${newChatSlot}) { max-width: max(var(--container-7xl, 80rem), calc(${px} + 7rem)) !important; }`,
  ].join('\n');
}

// 대화 화면의 주소: /chat/<id>(2026-10-20에 봄).
const conversationPath = /^\/chat\/[^/]+\/?$/;

// 그 화면에 늘 있어야 하는 요소. 새 채팅 화면은 작성란, 대화 화면은 대화 열과 작성란이다. 있어야 할지 모르는 화면(프로젝트
// 화면 등, 보지 않았다)은 없다. 그런 화면에서 찾지 못함을 알리지 않기 위해서다.
export function expectedElements(location: Pick<Location, 'pathname'>): readonly NamedElement[] {
  if (location.pathname === '/new') return [composer];
  if (conversationPath.test(location.pathname)) return [thread, composer];
  return [];
}

// 페이지 안 이동(대화 바꿈, 새 채팅. 주소가 바뀐다)을 알린다. claude.ai는 문서를 다시 싣지 않고 주소를 바꾸며, 그때 Navigation
// API의 currententrychange가 한 번 온다(2026-10-20에 봄). 그 범위로 듣는다.
export function watchNavigation(scope: Scope, window: Window, onNavigate: () => void): void {
  scope.listen(window.navigation, 'currententrychange', onNavigate);
}
