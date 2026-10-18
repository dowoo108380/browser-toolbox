import { afterEach, describe, expect, it } from 'vitest';
import { type NamedElement, createScope, pageElementAttribute } from '../../dom/index.ts';
import type { Snapshot } from '../../storage/index.ts';
import { page } from './page.ts';

// GPT-2의 페이지 쪽 일을 실행 틀 없이 시작해 본다(결정 0031, 0032, 0034). 시험 문서에 chatgpt.com 구조의 뼈대(2026-10-18에
// 본 두 화면)를 만든다. 화면마다 찾는 요소는 시험 문서(Vitest의 iframe)의 주소를 history로 바꿔 보고, 끝나면 처음 주소로
// 되돌린다. 너비가 걸렸는지의 확인은 실제 Chromium의 배치로 잰다.

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

// 로그인한 화면의 뼈대(2026-10-18, 사용자의 Chrome, 결정 0032): 대화 열(찾기 대상)과 작성란(ChatGPT 작성 양식)을 각각 바깥
// 상자가 묶는다. 바깥 상자는 사이트의 CSS 변수(48rem)에 좌우 안쪽 여백 20px를 더한 최대 너비로 가운데에 놓인다. 사이트처럼
// 변수와 최대 너비는 클래스 규칙으로 둔다. variable이 거짓이면 사이트가 그 변수를 그만 쓰고 같은 값(808px)을 바로 둔 화면이다
// (결정 0034). previous면 앞 화면이 숨긴 채 남긴 대화 열과 작성란이 문서 앞쪽에 있다.
function signedInLayout(
  width: number,
  { variable = true, previous = false }: { variable?: boolean; previous?: boolean } = {},
) {
  const rules = document.createElement('style');
  const maxWidth = variable ? 'calc(var(--thread-content-max-width) + 40px)' : '808px';
  rules.textContent = `.signed-in-column {
    --thread-content-max-width: 48rem;
    box-sizing: border-box; display: flex; flex-direction: column; width: 100%;
    max-width: ${maxWidth}; margin-inline: auto; padding-inline: 20px;
  }`;
  document.head.append(rules);
  const container = document.createElement('section');
  container.style.cssText = `width: ${String(width)}px; display: flex; flex-direction: column; overflow-x: auto;`;
  const screen = (parent: Element) => {
    const column = () => {
      const bound = document.createElement('div');
      bound.className = 'signed-in-column';
      parent.append(bound);
      return bound;
    };
    const threadBound = column();
    threadBound.setAttribute('data-thread-user-message-navigation-content', '');
    const target = document.createElement('div');
    target.setAttribute('data-thread-find-target', '');
    const turn = document.createElement('div');
    turn.setAttribute('data-turn-key', '');
    target.append(turn);
    threadBound.append(target);
    const form = document.createElement('form');
    form.setAttribute('data-chatgpt-composer', '');
    column().append(form);
    return { target, form };
  };
  if (previous) {
    const hidden = document.createElement('div');
    hidden.hidden = true;
    container.append(hidden);
    screen(hidden);
  }
  const { target, form } = screen(container);
  document.body.append(container);
  cleanups.push(() => {
    container.remove();
    rules.remove();
  });
  const widthOf = (element: Element) => Math.round(element.getBoundingClientRect().width);
  return {
    container,
    widths: () => ({ thread: widthOf(target), composer: widthOf(form) }),
  };
}

const settings = (value: unknown): Snapshot => ({
  features: new Map([['chatgpt-width', value]]),
  sites: new Map(),
});

// 실행 틀 없이 기능만 시작한다. 찾기는 부른 요소와 그만두었는지를 적고, 그 요소가 문서에 있으면 곧바로 찾았다고 알린다.
// 확인은 받은 확인 함수와 그만두었는지를 적는다(시험이 그 함수를 부른다).
function start(snapshot: Snapshot) {
  const scope = createScope({ window, onError: () => undefined, isLive: () => true });
  cleanups.push(scope.close);
  const searches: { readonly id: string; stopped: boolean }[] = [];
  const find = (element: NamedElement, onFound: (found: Element) => void | Promise<void>) => {
    const search = { id: element.id, stopped: false };
    searches.push(search);
    const found = element.find(document);
    if (found !== null) void onFound(found);
    return () => {
      search.stopped = true;
    };
  };
  const verifications: { readonly check: () => NamedElement | null; stopped: boolean }[] = [];
  const verify = (check: () => NamedElement | null) => {
    const verification = { check, stopped: false };
    verifications.push(verification);
    return () => {
      verification.stopped = true;
    };
  };
  page.start(snapshot, { window, document, scope, find, verify });
  return { close: scope.close, searches, verifications };
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

describe('GPT-2 로그인한 화면의 대화 열·작성란 너비(결정 0032, 이슈 #6)', () => {
  it('GPT-2.1 켜면 로그인한 화면의 대화 열과 작성란도 정한 너비이고, 끄면 문서가 켜기 전과 같다', () => {
    const { widths } = signedInLayout(1500);
    expect(widths()).toEqual({ thread: 768, composer: 768 });
    const before = document.documentElement.outerHTML;
    const { close } = start(settings({ enabled: true, width: 1000 }));
    expect(widths()).toEqual({ thread: 1000, composer: 1000 });
    close();
    expect(widths()).toEqual({ thread: 768, composer: 768 });
    expect(document.documentElement.outerHTML).toBe(before);
  });

  it('GPT-2.3 담는 상자가 정한 너비보다 좁으면 그 상자에 맞추고 넘치지 않는다', () => {
    const { container, widths } = signedInLayout(700);
    start(settings({ enabled: true, width: 1200 }));
    // 바깥 상자의 좌우 안쪽 여백(20px씩)을 뺀 너비다.
    expect(widths()).toEqual({ thread: 660, composer: 660 });
    expect(container.scrollWidth).toBe(container.clientWidth);
  });
});

describe('GPT-2 너비가 실제로 걸렸는지 확인(결정 0034)', () => {
  const on = settings({ enabled: true, width: 1200 });

  // 대화 화면에서 시작해, 그 화면의 요소를 모두 찾고 받은 확인을 부른다. 걸리지 않은 요소의 이름표를 돌려준다.
  function verifyConversation(): string | null {
    history.replaceState(null, '', '/c/abc');
    const { verifications } = start(on);
    expect(verifications).toHaveLength(1);
    return verifications[0]?.check()?.id ?? null;
  }

  it.each([
    ['로그인하지 않은 화면, 넓은 창', () => layout(1500)],
    ['로그인하지 않은 화면, 정한 너비보다 좁은 창', () => layout(700)],
    ['로그인한 화면, 넓은 창', () => signedInLayout(1500)],
    ['로그인한 화면, 정한 너비보다 좁은 창', () => signedInLayout(1000)],
    ['로그인한 화면, 사이트의 원래 너비보다 좁은 창', () => signedInLayout(700)],
  ])('GPT-2.3 COM-6.8 %s: 너비 규칙이 작용하면 확인을 통과한다', (_name, draw) => {
    draw();
    expect(verifyConversation()).toBeNull();
  });

  it.each([
    ['넓은 창', 1500],
    ['정한 너비보다 좁은 창', 1000],
    ['사이트의 원래 너비보다 좁은 창', 700],
  ])(
    'GPT-2.6 로그인한 화면에서 사이트가 열 너비 변수를 쓰지 않으면 %s에서도 대화 열이 걸리지 않은 것이다',
    (_name, width) => {
      signedInLayout(width, { variable: false });
      expect(verifyConversation()).toBe('chatgpt.thread');
    },
  );

  it('확인은 규칙을 잠시 바꿨다 되돌려 문서와 너비가 확인 전과 같다', () => {
    const { widths } = signedInLayout(700);
    history.replaceState(null, '', '/c/abc');
    const { verifications } = start(on);
    const before = { html: document.documentElement.outerHTML, widths: widths() };
    expect(verifications[0]?.check()).toBeNull();
    expect({ html: document.documentElement.outerHTML, widths: widths() }).toEqual(before);
  });

  it('앞 화면이 숨긴 채 남긴 요소가 문서 앞쪽에 있어도 화면에 보이는 것을 잰다', () => {
    signedInLayout(1500, { previous: true });
    expect(verifyConversation()).toBeNull();
  });

  it('새 대화 화면에서는 작성란만 찾아 확인하고, 있어야 할 요소를 다 찾지 못하면 확인하지 않는다', () => {
    signedInLayout(1500, { variable: false });
    history.replaceState(null, '', '/');
    const newChat = start(on);
    expect(newChat.verifications[0]?.check()?.id).toBe('chatgpt.composer');
    newChat.close();

    for (const element of document.querySelectorAll('[data-thread-find-target]')) element.remove();
    history.replaceState(null, '', '/c/abc');
    expect(start(on).verifications).toEqual([]);
  });

  it('페이지 안에서 이동하면 앞 화면의 확인을 그만두고 새 화면의 것을 한다', () => {
    signedInLayout(1500);
    history.replaceState(null, '', '/c/abc');
    const { verifications } = start(on);
    history.pushState(null, '', '/c/def');
    expect(verifications.map((verification) => verification.stopped)).toEqual([true, false]);
  });
});
