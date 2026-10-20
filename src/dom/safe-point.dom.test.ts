import { afterEach, describe, expect, it } from 'vitest';
import { type Point, safePair } from './safe-point.ts';

// 가짜 입력을 보낼 안전한 곳(TAB-2 기대 동작 7, 결정 0041). 실제 Chromium의 배치로 본다. 시험 문서는 Vitest의 iframe이라 그
// 보이는 영역이 좌표의 기준이다.

const added: Element[] = [];

afterEach(() => {
  for (const element of added.splice(0)) element.remove();
});

// 시험 요소(글을 HTML로 넣지 않는다, quality 065).
function element(
  tag: string,
  attributes: Readonly<Record<string, string>> = {},
  children: readonly (Node | string)[] = [],
): HTMLElement {
  const created = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) created.setAttribute(name, value);
  created.append(...children);
  return created;
}

const fill = 'position: fixed; inset: 0; width: 100%; height: 100%; margin: 0';

// 보이는 영역 전체를 덮는 흰 상자 하나에 children을 넣는다.
function cover(...children: readonly Node[]): HTMLElement {
  const box = element('div', { style: `${fill}; padding: 0; background: white` }, children);
  document.body.append(box);
  added.push(box);
  return box;
}

const onElement = (point: Point, target: Element) => {
  const rect = target.getBoundingClientRect();
  return (
    point.x >= rect.left && point.x < rect.right && point.y >= rect.top && point.y < rect.bottom
  );
};

const center = (target: Element): Point => {
  const rect = target.getBoundingClientRect();
  return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
};

describe('안전한 곳 고르기', () => {
  it('TAB-2.14 마지막 마우스 위치가 버튼 위면 그곳이 아닌 안전한 곳을 고른다', () => {
    const button = element(
      'button',
      { style: 'position: absolute; left: 0; top: 0; width: 200px; height: 80px' },
      ['재생'],
    );
    cover(button);
    const pair = safePair(document, null, center(button));
    expect(pair).not.toBeNull();
    if (pair === null) return;
    expect(onElement(pair.first, button)).toBe(false);
    expect(onElement(pair.second, button)).toBe(false);
    expect(pair.second).toEqual({ x: pair.first.x + 1, y: pair.first.y });
  });

  it('마지막 위치가 안전하면 그곳에서 1픽셀씩 번갈아 쓴다. 지난번 두 점이 아직 안전하면 그대로 쓴다', () => {
    cover(element('p', {}, ['글']));
    const last = { x: 120, y: 140 };
    expect(safePair(document, null, last)).toEqual({ first: last, second: { x: 121, y: 140 } });
    const keep = { first: { x: 30, y: 30 }, second: { x: 31, y: 30 } };
    expect(safePair(document, keep, last)).toEqual(keep);
  });

  it.each([
    ['링크', () => [element('a', { href: '#x', style: `${fill}; display: block` }, ['링크'])]],
    ['버튼', () => [element('button', { style: fill }, ['단추'])]],
    ['입력란', () => [element('input', { style: fill })]],
    ['선택', () => [element('select', { style: fill }, [element('option', {}, ['하나'])])]],
    ['글 상자', () => [element('textarea', { style: fill })]],
    ['편집 가능한 영역', () => [element('div', { contenteditable: 'true', style: fill }, ['글'])]],
    ['메뉴 역할', () => [element('div', { role: 'menu', style: fill }, ['메뉴'])]],
    ['버튼 역할', () => [element('div', { role: 'button', style: fill }, ['단추'])]],
    [
      '펼침 메뉴를 여는 요소',
      () => [element('div', { 'aria-haspopup': 'menu', style: fill }, ['열기'])],
    ],
    [
      '펼치고 접는 요소',
      () => [element('div', { 'aria-expanded': 'false', style: fill }, ['더보기'])],
    ],
    ['손 모양 커서', () => [element('div', { style: `${fill}; cursor: pointer` }, ['누름'])]],
    [
      '영상 영역(위에 덮인 것이 있어도)',
      () => [element('video', { style: fill }), element('div', { style: fill }, ['덮개'])],
    ],
    ['iframe 영역', () => [element('iframe', { style: fill })]],
  ])('TAB-2.11 TAB-2.15 화면 전체가 %s이면 안전한 곳이 없다', (_name, make) => {
    cover(...make());
    expect(safePair(document, null, { x: 50, y: 50 })).toBeNull();
  });

  it('TAB-2.11 조작 요소의 안쪽(조상이 링크)도 안전하지 않다', () => {
    cover(
      element('a', { href: '#x', style: `${fill}; display: block` }, [
        element('span', { style: 'cursor: default' }, ['안쪽']),
      ]),
    );
    expect(safePair(document, null, { x: 10, y: 10 })).toBeNull();
  });

  it('열린 shadow root 안의 버튼도 본다', () => {
    const host = element('div', { style: fill });
    cover(host);
    host.attachShadow({ mode: 'open' }).append(element('button', { style: fill }, ['단추']));
    expect(safePair(document, null, { x: 10, y: 10 })).toBeNull();
  });

  it('지난번 두 점 가운데 하나라도 안전하지 않게 되면 다른 곳을 고른다', () => {
    const button = element(
      'button',
      { style: 'position: absolute; left: 0; top: 0; width: 100px; height: 100px' },
      ['단추'],
    );
    cover(button);
    const keep = { first: { x: 98, y: 50 }, second: { x: 99, y: 50 } };
    const pair = safePair(document, keep, null);
    if (pair === null) throw new Error('점이 없다.');
    expect(pair).not.toEqual(keep);
    expect(onElement(pair.first, button) || onElement(pair.second, button)).toBe(false);
  });
});
