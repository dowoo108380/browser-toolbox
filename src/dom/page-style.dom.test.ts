import { afterEach, describe, expect, it } from 'vitest';
import { createIsolatedHost } from './isolated-host.ts';
import { claimAttribute, claimOwnedElements, pageElementAttribute } from './owned.ts';
import { createPageStyle } from './page-style.ts';

// 페이지 자체의 모양을 바꾸는 스타일 요소(결정 0031)와 이 세계가 넣은 요소의 표식(결정 0008).

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function target(): HTMLElement {
  const element = document.createElement('ol');
  document.body.append(element);
  cleanups.push(() => {
    element.remove();
  });
  return element;
}

describe('페이지 스타일(결정 0031)', () => {
  it('그 문서의 요소에 걸리고, 지우면 문서가 넣기 전과 같다', () => {
    const list = target();
    const before = document.documentElement.outerHTML;
    const style = createPageStyle(document, {
      name: 'test-width',
      css: 'ol { max-width: 120px !important; }',
    });
    expect(getComputedStyle(list).maxWidth).toBe('120px');
    // 문서 루트의 마지막 자식으로 붙고 확장의 표식이 있다.
    const added = document.documentElement.lastElementChild;
    expect(added?.tagName).toBe('STYLE');
    expect(added?.getAttribute(pageElementAttribute)).toBe('test-width');

    style.remove();
    expect(getComputedStyle(list).maxWidth).toBe('none');
    expect(document.documentElement.outerHTML).toBe(before);
  });
});

describe('이 세계가 넣은 요소(결정 0008)', () => {
  it('COM-7.2 물러남 토큰은 화면 요소와 페이지 스타일에 모두 적히고, 지운 요소에는 적히지 않는다', () => {
    const host = createIsolatedHost(document, {
      name: 'test-host',
      css: '',
      parent: document.body,
    });
    cleanups.push(host.remove);
    const style = createPageStyle(document, { name: 'test-style', css: '' });
    cleanups.push(style.remove);
    const removed = createPageStyle(document, { name: 'test-removed', css: '' });
    const removedElement = document.documentElement.lastElementChild;
    removed.remove();

    claimOwnedElements('token-1');
    expect(host.host.getAttribute(claimAttribute)).toBe('token-1');
    expect(
      document
        .querySelector(`style[${pageElementAttribute}="test-style"]`)
        ?.getAttribute(claimAttribute),
    ).toBe('token-1');
    expect(removedElement?.isConnected).toBe(false);
    expect(removedElement?.hasAttribute(claimAttribute)).toBe(false);
  });
});
