import { afterEach, describe, expect, it } from 'vitest';
import { type NamedElement, type Scope, createScope, pageElementAttribute } from '../dom/index.ts';
import { startContentWidth } from './content-width.ts';
import type { PageStart } from './part.ts';

// 너비 기능이 함께 쓰는 흐름을 지어낸 사이트로 본다(결정 0039). 이 흐름에는 사이트마다의 분기가 없어, 사이트의 지식(규칙,
// 화면마다 있어야 할 요소, 이동 신호)을 모두 받은 것으로만 한다. 실제 사이트의 구조로는 각 기능의 page.dom.test가 본다.
// 실행 틀 없이 찾기와 확인을 흉내 낸다: 찾기는 문서에 있는 요소를 곧바로 찾았다고 알리고, 확인은 받은 것을 적는다.

const originalUrl = location.href;
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  history.replaceState(null, '', originalUrl);
});

const named = (id: string, selector: string): NamedElement => ({
  id,
  name: id,
  candidates: (document) => document.querySelectorAll(selector),
});
const column = named('site.column', '[data-column]');
const box = named('site.box', '[data-box]');
const navigate = 'site-navigate';

// 지어낸 사이트: /a 화면에는 열과 상자, /b 화면에는 상자가 있어야 한다. 규칙은 그 둘의 최대 너비를 바꾼다. obeyed가 거짓이면
// 사이트가 너비를 정하는 방법을 바꿔 규칙이 맞는 요소가 없는 것이다.
function site({ obeyed = true }: { obeyed?: boolean } = {}) {
  return {
    css: (px: number) =>
      `${obeyed ? '[data-column], [data-box]' : '[data-gone]'} { max-width: ${String(px)}px !important; }`,
    expectedElements: ({ pathname }: Pick<Location, 'pathname'>) =>
      pathname === '/a' ? [column, box] : pathname === '/b' ? [box] : [],
    watchNavigation: (scope: Scope, window: Window, onNavigate: () => void) => {
      scope.listen(window, navigate, onNavigate);
    },
  };
}

function layout(space: number) {
  const container = document.createElement('section');
  container.style.cssText = `width: ${String(space)}px; overflow-x: auto;`;
  const make = (attribute: string) => {
    const element = document.createElement('div');
    element.setAttribute(attribute, '');
    element.style.cssText = 'max-width: 300px;';
    container.append(element);
    return element;
  };
  const elements = [make('data-column'), make('data-box')];
  document.body.append(container);
  cleanups.push(() => {
    container.remove();
  });
  return {
    container,
    widths: () => elements.map((element) => Math.round(element.getBoundingClientRect().width)),
  };
}

interface Verification {
  readonly ids: readonly string[];
  readonly check: (current: readonly Element[]) => number | null;
  stopped: boolean;
}

function start(width: number, options: { obeyed?: boolean } = {}) {
  const scope = createScope({ window, onError: () => undefined, isLive: () => true });
  cleanups.push(scope.close);
  const searches: { readonly id: string; stopped: boolean }[] = [];
  const verifications: Verification[] = [];
  const context: PageStart = {
    window,
    document,
    scope,
    topFrame: true,
    send: () => {
      throw new Error('이 기능은 기능 명령을 보내지 않는다.');
    },
    answer: () => {
      throw new Error('이 기능은 기능 명령에 답하지 않는다.');
    },
    find: (element, onFound) => {
      const search = { id: element.id, stopped: false };
      searches.push(search);
      const [found] = element.candidates(document);
      if (found !== undefined) void onFound(found);
      return () => {
        search.stopped = true;
      };
    },
    verify: (elements, check) => {
      const verification = { ids: elements.map(({ id }) => id), check, stopped: false };
      verifications.push(verification);
      return () => {
        verification.stopped = true;
      };
    },
  };
  startContentWidth(context, { name: 'site-width', width, site: site(options) });
  return { close: scope.close, searches, verifications };
}

// 실행 틀이 한도 때 하는 것처럼 그 요소들로 확인 함수를 부른다.
function judge(verification: Verification | undefined): number | null {
  if (verification === undefined) throw new Error('받은 확인이 없다.');
  return verification.check(
    [column, box]
      .filter(({ id }) => verification.ids.includes(id))
      .map((element) => {
        const [found] = element.candidates(document);
        if (found === undefined) throw new Error(`${element.id}이 문서에 없다.`);
        return found;
      }),
  );
}

const styles = () => document.querySelectorAll(`style[${pageElementAttribute}="site-width"]`);

describe('결정 0039 너비 기능이 함께 쓰는 흐름', () => {
  it('사이트의 규칙을 그 이름의 스타일 하나로 넣고, 화면에 있어야 할 요소를 모두 찾으면 확인하며, 이동하면 새 화면의 것을 한다', () => {
    const { widths } = layout(1500);
    const before = document.documentElement.outerHTML;
    history.replaceState(null, '', '/a');
    const { close, searches, verifications } = start(1000);
    expect(styles()).toHaveLength(1);
    expect(widths()).toEqual([1000, 1000]);
    expect(searches).toEqual([
      { id: 'site.column', stopped: false },
      { id: 'site.box', stopped: false },
    ]);
    expect(verifications.map(({ ids }) => ids)).toEqual([['site.column', 'site.box']]);

    history.pushState(null, '', '/b');
    window.dispatchEvent(new Event(navigate));
    expect(searches.map(({ stopped }) => stopped)).toEqual([true, true, false]);
    expect(verifications.map(({ ids, stopped }) => [ids, stopped])).toEqual([
      [['site.column', 'site.box'], true],
      [['site.box'], false],
    ]);

    // 있어야 할 요소가 없는 화면에서는 찾지도 확인하지도 않는다.
    history.pushState(null, '', '/c');
    window.dispatchEvent(new Event(navigate));
    expect(searches).toHaveLength(3);
    expect(verifications).toHaveLength(2);

    close();
    expect(document.documentElement.outerHTML).toBe(before);
    window.dispatchEvent(new Event(navigate));
    expect(searches).toHaveLength(3);
  });

  it('확인은 사이트의 규칙을 다른 너비로 잠시 바꿔 재어, 좁은 상자에서도 규칙이 너비를 정하는지 가르고 되돌린다', () => {
    history.replaceState(null, '', '/a');
    const narrow = layout(600);
    const applied = start(1000);
    expect(narrow.widths()).toEqual([600, 600]);
    expect(narrow.container.scrollWidth).toBe(narrow.container.clientWidth);
    const before = document.documentElement.outerHTML;
    expect(judge(applied.verifications[0])).toBeNull();
    expect(document.documentElement.outerHTML).toBe(before);
    applied.close();

    // 사이트가 너비를 정하는 방법을 바꾸면 요소는 사이트의 너비(300px) 그대로다. 넓은 상자에서도 좁은 상자에서도 드러난다.
    const ignored = start(1000, { obeyed: false });
    expect(judge(ignored.verifications[0])).toBe(0);
  });
});
