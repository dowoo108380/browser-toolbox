import { afterEach, describe, expect, it } from 'vitest';
import { type NamedElement, createScope, pageElementAttribute } from '../../dom/index.ts';
import type { Snapshot } from '../../storage/index.ts';
import { page } from './page.ts';

// GPT-2의 페이지 쪽 일을 실행 틀 없이 시작해 본다(결정 0031). 시험 문서에 chatgpt.com 구조의 뼈대(2026-10-18에 로그인하지
// 않은 화면에서 본 것)를 만든다: 대화 기록 목록(최대 너비 없음)과 작성란 상자(최대 너비 768px, 가운데).
// 화면마다 찾는 요소는 시험 문서(Vitest의 iframe)의 주소를 history로 바꿔 보고, 끝나면 처음 주소로 되돌린다.

const originalUrl = location.href;
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  history.replaceState(null, '', originalUrl);
});

function layout(width: number) {
  const container = document.createElement('section');
  container.style.cssText = `width: ${String(width)}px; display: flex; flex-direction: column; overflow-x: auto;`;
  const transcript = document.createElement('ol');
  transcript.setAttribute('data-conversation-transcript', '');
  transcript.style.cssText = 'margin: 0; padding: 0;';
  const message = document.createElement('li');
  message.setAttribute('data-message-role', 'assistant');
  transcript.append(message);
  const dock = document.createElement('div');
  dock.setAttribute('data-composer-dock', '');
  const positioner = document.createElement('div');
  positioner.setAttribute('data-composer-positioner', '');
  positioner.style.cssText = 'max-width: 768px; margin-inline: auto;';
  positioner.append(document.createElement('form'));
  dock.append(positioner);
  container.append(transcript, dock);
  document.body.append(container);
  cleanups.push(() => {
    container.remove();
  });
  const widthOf = (element: Element) => Math.round(element.getBoundingClientRect().width);
  return {
    container,
    widths: () => ({ thread: widthOf(transcript), composer: widthOf(positioner) }),
  };
}

const settings = (value: unknown): Snapshot => ({
  features: new Map([['chatgpt-width', value]]),
  sites: new Map(),
});

// 실행 틀 없이 기능만 시작한다. 찾기는 부른 요소와 그만두었는지를 적는다.
function start(snapshot: Snapshot) {
  const scope = createScope({ window, onError: () => undefined, isLive: () => true });
  cleanups.push(scope.close);
  const searches: { readonly id: string; stopped: boolean }[] = [];
  const find = (element: NamedElement) => {
    const search = { id: element.id, stopped: false };
    searches.push(search);
    return () => {
      search.stopped = true;
    };
  };
  page.start(snapshot, { window, document, scope, find });
  return { close: scope.close, searches };
}

const styles = () => document.querySelectorAll(`style[${pageElementAttribute}="chatgpt-width"]`);

describe('GPT-2 대화 열·작성란 너비', () => {
  it('꺼져 있으면 아무것도 하지 않는다', () => {
    const { widths } = layout(1500);
    const { searches } = start(settings({ enabled: false, width: 1000 }));
    expect(styles()).toHaveLength(0);
    expect(searches).toEqual([]);
    expect(widths()).toEqual({ thread: 1500, composer: 768 });
  });

  it('GPT-2.1 켜면 대화 열과 작성란의 최대 너비가 정한 값이다', () => {
    const { widths } = layout(1500);
    start(settings({ enabled: true, width: 1000 }));
    expect(widths()).toEqual({ thread: 1000, composer: 1000 });
    expect(styles()).toHaveLength(1);
  });

  it('GPT-2.3 담는 상자가 정한 너비보다 좁으면 그 상자에 맞추고 넘치지 않는다', () => {
    const { container, widths } = layout(700);
    start(settings({ enabled: true, width: 1200 }));
    expect(widths()).toEqual({ thread: 700, composer: 700 });
    expect(container.scrollWidth).toBe(container.clientWidth);
  });

  it('GPT-2.4 COM-1.3 끄면 너비가 켜기 전과 같고 문서에 남는 것이 없다', () => {
    const { widths } = layout(1500);
    const before = document.documentElement.outerHTML;
    const { close } = start(settings({ enabled: true, width: 2000 }));
    expect(widths()).toEqual({ thread: 1500, composer: 1500 });
    close();
    expect(widths()).toEqual({ thread: 1500, composer: 768 });
    expect(document.documentElement.outerHTML).toBe(before);
  });

  it('COM-6 결정 0031 화면에 있어야 할 요소를 찾고, 페이지 안에서 이동하면 앞 찾기를 그만두고 새 화면의 것을 찾는다', () => {
    history.replaceState(null, '', '/');
    const { close, searches } = start(settings({ enabled: true, width: 1000 }));
    // 새 대화 화면에는 작성란만 있어야 한다.
    expect(searches).toEqual([{ id: 'chatgpt.composer', stopped: false }]);

    history.pushState(null, '', '/c/abc');
    expect(searches).toEqual([
      { id: 'chatgpt.composer', stopped: true },
      { id: 'chatgpt.thread', stopped: false },
      { id: 'chatgpt.composer', stopped: false },
    ]);

    // 있어야 할지 모르는 화면에서는 찾지 않는다.
    history.pushState(null, '', '/gpts');
    expect(searches.map((search) => search.stopped)).toEqual([true, true, true]);
    expect(searches).toHaveLength(3);

    // 끈 뒤의 이동에는 찾지 않는다.
    close();
    history.pushState(null, '', '/');
    expect(searches).toHaveLength(3);
  });
});
