import { afterEach, describe, expect, it } from 'vitest';
import { type NamedElement, createScope } from '../../dom/index.ts';
import { composer, thread, watchNavigation } from './index.ts';

// 2026-10-20에 claude.ai(로그인한 화면, 사용자의 Chrome)에서 본 구조의 뼈대(결정 0040). 클래스와 글은 뺐고, 값을 보지 않은
// 속성은 비워 둔다.

const added: Element[] = [];

afterEach(() => {
  for (const element of added.splice(0)) element.remove();
});

// 그 요소의 단서에 맞는 요소들(문서 순서).
function candidates(named: NamedElement): Element[] {
  return [...named.candidates(document)];
}

// 속성을 단 요소를 만들어 parent(없으면 문서 본문)에 붙인다.
function element(
  tag: string,
  attributes: Readonly<Record<string, string>> = {},
  parent: Element = document.body,
): Element {
  const created = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) created.setAttribute(name, value);
  parent.append(created);
  if (parent === document.body) added.push(created);
  return created;
}

describe('claude.ai의 이름 붙은 요소(결정 0040)', () => {
  it('대화 열은 열 안에서 메시지 행을 담는 대화 기록 상자이고, 열의 다른 칸과 열 밖의 메시지 행은 대화 열이 아니다', () => {
    const scope = element('div', { 'data-testid': '', 'data-transcript-stays-put-scope': '' });
    const transcript = element('div', { 'data-testid': '' }, scope);
    element('div', { 'aria-hidden': '', 'data-composer-banners-room': '' }, scope);
    const input = element('div', { 'data-chat-input-container': '' }, scope);
    expect(candidates(thread)).toEqual([]);
    // 메시지 행은 몇 겹 안쪽에 있다.
    element(
      'div',
      { 'data-transcript-row': '' },
      element('div', {}, element('div', {}, transcript)),
    );
    element('div', { 'data-transcript-row': '' });
    expect(candidates(thread)).toEqual([transcript]);
    expect(candidates(thread)).not.toContain(input);
  });

  it('대화 열은 답을 만드는 동안 사이트가 열에서 상태 속성(data-transcript-stays-put-scope)을 떼어도 같은 상자다(이슈 #9)', () => {
    // 2026-10-20에 사용자의 Chrome에서 메시지를 보내고 본 열: 자식 넷과 메시지 행은 그대로이고 그 속성만 뗐다 다시 단다.
    const scope = element('div', { 'data-testid': '', 'data-transcript-stays-put-scope': '' });
    const transcript = element('div', { 'data-testid': '' }, scope);
    element('div', { 'data-transcript-row': '' }, element('div', {}, transcript));
    element('div', { 'aria-hidden': '', 'data-composer-banners-room': '' }, scope);
    element(
      'span',
      { hidden: '', 'data-chat-dock-kind': '', 'data-chat-transcript-phase': '' },
      scope,
    );
    element('div', { 'data-chat-input-container': '' }, scope);
    expect(candidates(thread)).toEqual([transcript]);

    scope.removeAttribute('data-transcript-stays-put-scope');
    expect(candidates(thread)).toEqual([transcript]);

    scope.setAttribute('data-transcript-stays-put-scope', '');
    expect(candidates(thread)).toEqual([transcript]);
  });

  it('작성란은 작성 칸의 카드를 담는 상자이고, 대화 화면과 새 채팅 화면 모두 같은 단서다', () => {
    expect(candidates(composer)).toEqual([]);
    const input = element('div', { 'data-chat-input-container': '' });
    const inChat = element('div', { 'data-composer-card-holder': '' }, element('div', {}, input));
    element('div', { contenteditable: 'true', 'data-composer-editor': '' }, inChat);
    const slot = element('div', { 'data-chorus-card-slot': '' });
    const onNewChat = element('div', { 'data-composer-card-holder': '' }, element('div', {}, slot));
    expect(candidates(composer)).toEqual([inChat, onNewChat]);
  });
});

describe('claude.ai의 사이트 안 이동 신호(결정 0040)', () => {
  it('Navigation API의 currententrychange를 알리고, 범위가 닫히면 그만 듣는다', () => {
    const scope = createScope({ window, onError: () => undefined, isLive: () => true });
    let count = 0;
    watchNavigation(scope, window, () => {
      count += 1;
    });
    window.navigation.dispatchEvent(new Event('currententrychange'));
    expect(count).toBe(1);
    scope.close();
    window.navigation.dispatchEvent(new Event('currententrychange'));
    expect(count).toBe(1);
  });
});
