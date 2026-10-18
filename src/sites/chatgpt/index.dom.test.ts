import { afterEach, describe, expect, it } from 'vitest';
import { createScope } from '../../dom/index.ts';
import { composer, thread, watchNavigation } from './index.ts';

// 2026-10-18에 로그인하지 않은 chatgpt.com에서 본 구조의 뼈대(결정 0031). 클래스와 글은 뺐다.

const added: Element[] = [];

afterEach(() => {
  for (const element of added.splice(0)) element.remove();
});

// 속성을 단 요소를 만들어 parent(없으면 문서 본문)에 붙인다.
function element(
  tag: string,
  attributes: Readonly<Record<string, string>>,
  parent: Element = document.body,
): Element {
  const created = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) created.setAttribute(name, value);
  parent.append(created);
  if (parent === document.body) added.push(created);
  return created;
}

describe('chatgpt.com의 이름 붙은 요소(결정 0031)', () => {
  it('대화 열은 메시지를 담는 대화 기록 목록이고, 다른 목록은 대화 열이 아니다', () => {
    element('li', {}, element('ol', {}));
    expect(thread.find(document)).toBeNull();
    const transcript = element('ol', {
      'aria-label': 'Conversation',
      'data-conversation-transcript': '',
    });
    element('li', { 'data-message-role': 'user' }, transcript);
    expect(thread.find(document)).toBe(transcript);
  });

  it('작성란은 작성 양식을 담고 너비를 정하는 상자다', () => {
    expect(composer.find(document)).toBeNull();
    const positioner = element(
      'div',
      { 'data-composer-positioner': '' },
      element('div', { 'data-composer-dock': '' }),
    );
    element('form', {}, positioner);
    expect(composer.find(document)).toBe(positioner);
  });
});

// 2026-10-18에 로그인한 화면(사용자의 Chrome)에서 본 구조의 뼈대(결정 0032, 이슈 #6). 값을 보지 않은 속성은 비워 둔다.
describe('로그인한 chatgpt.com의 이름 붙은 요소(결정 0032)', () => {
  it('이슈 #6 대화 열은 메시지 차례를 담는 찾기 대상이고, 작성란은 ChatGPT 작성 양식이다', () => {
    const bound = element('div', { 'data-thread-user-message-navigation-content': '' });
    const target = element('div', { 'data-thread-find-target': '' }, bound);
    element('div', { 'data-turn-key': '' }, target);
    expect(thread.find(document)).toBe(target);
    const form = element(
      'form',
      { 'data-chatgpt-composer': '', 'data-thread-find-composer': '' },
      element('div', {}),
    );
    expect(composer.find(document)).toBe(form);
  });
});

describe('chatgpt.com의 사이트 안 이동 신호(결정 0031)', () => {
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
