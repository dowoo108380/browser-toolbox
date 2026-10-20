import { afterEach, describe, expect, it } from 'vitest';
import { type NamedElement, createScope, pageElementAttribute } from '../../dom/index.ts';
import type { Snapshot } from '../../storage/index.ts';
import { page } from './page.ts';

// CLD-1의 페이지 쪽 일을 실행 틀 없이 시작해 본다(결정 0039, 0040). 시험 문서에 claude.ai 구조의 뼈대(2026-10-20에 사용자의
// Chrome에서 본 두 화면)를 만든다. 사이트처럼 너비는 클래스 규칙으로 둔다. 화면마다 찾는 요소는 시험 문서(Vitest의 iframe)의
// 주소를 history로 바꿔 보고, 끝나면 처음 주소로 되돌린다. 너비가 걸렸는지의 확인은 실제 Chromium의 배치로 잰다.

const originalUrl = location.href;
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  history.replaceState(null, '', originalUrl);
});

const widthOf = (element: Element) => Math.round(element.getBoundingClientRect().width);

function mount(rulesText: string, space: number, build: (container: HTMLElement) => void) {
  const rules = document.createElement('style');
  rules.textContent = rulesText;
  document.head.append(rules);
  const container = document.createElement('section');
  container.style.cssText = `width: ${String(space)}px; overflow-x: auto; --container-7xl: 80rem;`;
  build(container);
  document.body.append(container);
  cleanups.push(() => {
    container.remove();
    rules.remove();
  });
  return container;
}

function element(parent: Element, attributes: readonly string[], className = ''): HTMLElement {
  const created = document.createElement('div');
  for (const name of attributes) created.setAttribute(name, '');
  if (className !== '') created.className = className;
  parent.append(created);
  return created;
}

// 대화 화면: 열은 사이트의 변수(48rem)에 좌우 안쪽 여백 20px씩을 더한 최대 너비로 가운데에 놓이고, 그 안의 대화 기록 상자는
// 변수 그대로(안쪽 여백 16px씩 포함), 작성란 칸은 열을 채운다. variable이 거짓이면 사이트가 변수를 그만 쓰고 같은 값을 바로 둔
// 화면이다.
function chatLayout(space: number, { variable = true }: { variable?: boolean } = {}) {
  const columnMax = variable ? 'calc(var(--transcript-width, 48rem) + 2.5rem)' : '808px';
  const transcriptMax = variable ? 'var(--transcript-width, 48rem)' : '768px';
  let transcript: Element | undefined;
  let holder: Element | undefined;
  const container = mount(
    `.claude-column { box-sizing: border-box; display: flex; flex-direction: column; width: 100%;
       max-width: ${columnMax}; margin-inline: auto; padding-inline: 20px; }
     .claude-transcript { box-sizing: border-box; width: 100%; max-width: ${transcriptMax}; padding-inline: 16px; }`,
    space,
    (root) => {
      const column = element(
        element(root, ['data-autoscroll-container']),
        ['data-testid', 'data-transcript-stays-put-scope'],
        'claude-column',
      );
      transcript = element(column, ['data-testid'], 'claude-transcript');
      element(element(transcript, []), ['data-transcript-row']);
      holder = element(element(column, ['data-chat-input-container']), [
        'data-composer-card-holder',
      ]);
    },
  );
  return {
    container,
    widths: () => ({
      thread: transcript === undefined ? null : widthOf(transcript),
      composer: holder === undefined ? null : widthOf(holder),
    }),
  };
}

// 새 채팅 화면: 작성란 자리의 최대 너비는 40rem이고, 그 부모(화면의 틀)가 최대 너비 80rem과 좌우 안쪽 여백 3.5rem씩을 둔다.
// slotCue가 거짓이면 사이트가 자리의 단서(속성)를 바꾼 화면이다. 작성란은 그대로라 찾지만 너비 규칙이 맞는 요소가 없다.
function newChatLayout(space: number, { slotCue = true }: { slotCue?: boolean } = {}) {
  let holder: Element | undefined;
  const container = mount(
    `.claude-frame { box-sizing: border-box; display: flex; flex-direction: column; width: 100%;
       max-width: var(--container-7xl); margin-inline: auto; padding-inline: 3.5rem; }
     .claude-slot { margin-inline: auto; width: 100%; max-width: 40rem; }`,
    space,
    (root) => {
      const frame = element(element(root, ['data-new-page-scroll-column']), [], 'claude-frame');
      const slot = element(
        frame,
        [slotCue ? 'data-chorus-card-slot' : 'data-card-slot'],
        'claude-slot',
      );
      holder = element(slot, ['data-composer-card-holder']);
    },
  );
  return {
    container,
    widths: () => ({ thread: null, composer: holder === undefined ? null : widthOf(holder) }),
  };
}

const settings = (value: unknown): Snapshot => ({
  features: new Map([['claude-width', value]]),
  sites: new Map(),
});

interface Verification {
  readonly elements: readonly NamedElement[];
  readonly check: (current: readonly Element[]) => number | null;
  stopped: boolean;
}

// 실행 틀 없이 기능만 시작한다. 찾기는 부른 요소와 그만두었는지를 적고, 그 요소가 문서에 있으면 곧바로 찾았다고 알린다.
// 확인은 받은 것을 적는다(시험이 judge로 한다).
function start(snapshot: Snapshot) {
  const scope = createScope({ window, onError: () => undefined, isLive: () => true });
  cleanups.push(scope.close);
  const searches: { readonly id: string; stopped: boolean }[] = [];
  const verifications: Verification[] = [];
  page.start(snapshot, {
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
      const verification = { elements, check, stopped: false };
      verifications.push(verification);
      return () => {
        verification.stopped = true;
      };
    },
  });
  return { close: scope.close, searches, verifications };
}

// 실행 틀이 한도 때 하는 것처럼 그 요소들로 확인 함수를 불러, 작용하지 않는 요소의 이름표를 돌려준다.
function judge(verification: Verification | undefined): string | null {
  if (verification === undefined) throw new Error('받은 확인이 없다.');
  const current = verification.elements.map((element) => {
    const [found] = element.candidates(document);
    if (found === undefined) throw new Error(`${element.name}이 문서에 없다.`);
    return found;
  });
  const index = verification.check(current);
  return index === null ? null : (verification.elements[index]?.id ?? null);
}

const styles = () => document.querySelectorAll(`style[${pageElementAttribute}="claude-width"]`);
const on = (width = 1200) => settings({ enabled: true, width });

describe('CLD-1 대화 열·작성란 너비', () => {
  it('꺼져 있으면 아무것도 하지 않는다', () => {
    const { widths } = chatLayout(1500);
    const { searches } = start(settings({ enabled: false, width: 1000 }));
    expect(styles()).toHaveLength(0);
    expect(searches).toEqual([]);
    expect(widths()).toEqual({ thread: 768, composer: 768 });
  });

  it('CLD-1.1 켜면 대화 화면의 대화 열과 작성란의 최대 너비가 정한 값이다', () => {
    const { widths } = chatLayout(1500);
    start(on(1000));
    expect(widths()).toEqual({ thread: 1000, composer: 1000 });
    expect(styles()).toHaveLength(1);
  });

  it('CLD-1.1 켜면 새 채팅 화면의 작성란도 정한 값이다(화면의 틀보다 넓어도, 사이트의 너비보다 좁아도)', () => {
    const { widths } = newChatLayout(2000);
    expect(widths()).toEqual({ thread: null, composer: 640 });
    const wider = start(on(1500));
    expect(widths()).toEqual({ thread: null, composer: 1500 });
    wider.close();
    start(on(640));
    expect(widths()).toEqual({ thread: null, composer: 640 });
  });

  it('CLD-1.3 담는 상자가 정한 너비보다 좁으면 그 상자에 맞추고 넘치지 않는다', () => {
    const chat = chatLayout(700);
    start(on(1200));
    // 열의 좌우 안쪽 여백(20px씩)을 뺀 너비다.
    expect(chat.widths()).toEqual({ thread: 660, composer: 660 });
    expect(chat.container.scrollWidth).toBe(chat.container.clientWidth);

    const newChat = newChatLayout(700);
    // 화면의 틀의 좌우 안쪽 여백(56px씩)을 뺀 너비다.
    expect(newChat.widths()).toEqual({ thread: null, composer: 588 });
    expect(newChat.container.scrollWidth).toBe(newChat.container.clientWidth);
  });

  it('CLD-1.4 COM-1.3 끄면 너비가 켜기 전과 같고 문서에 남는 것이 없다', () => {
    const chat = chatLayout(1500);
    const newChat = newChatLayout(1500);
    const before = document.documentElement.outerHTML;
    const { close } = start(on(2000));
    expect(chat.widths()).toEqual({ thread: 1460, composer: 1460 });
    expect(newChat.widths()).toEqual({ thread: null, composer: 1388 });
    close();
    expect(chat.widths()).toEqual({ thread: 768, composer: 768 });
    expect(newChat.widths()).toEqual({ thread: null, composer: 640 });
    expect(document.documentElement.outerHTML).toBe(before);
  });

  it('COM-6 결정 0040 화면에 있어야 할 요소를 찾고, 페이지 안에서 이동하면 앞 찾기를 그만두고 새 화면의 것을 찾는다', () => {
    history.replaceState(null, '', '/new');
    const { close, searches } = start(on(1000));
    // 새 채팅 화면에는 작성란만 있어야 한다.
    expect(searches).toEqual([{ id: 'claude.composer', stopped: false }]);

    history.pushState(null, '', '/chat/abc');
    expect(searches).toEqual([
      { id: 'claude.composer', stopped: true },
      { id: 'claude.thread', stopped: false },
      { id: 'claude.composer', stopped: false },
    ]);

    // 있어야 할지 모르는 화면에서는 찾지 않는다.
    history.pushState(null, '', '/recents');
    expect(searches.map((search) => search.stopped)).toEqual([true, true, true]);
    expect(searches).toHaveLength(3);

    close();
    history.pushState(null, '', '/new');
    expect(searches).toHaveLength(3);
  });
});

describe('CLD-1 너비가 실제로 걸렸는지 확인(결정 0034, 0039, 0040)', () => {
  function verifyAt(pathname: string, ids: readonly string[]): string | null {
    history.replaceState(null, '', pathname);
    const { verifications } = start(on(1200));
    expect(verifications.map(({ elements }) => elements.map(({ id }) => id))).toEqual([ids]);
    return judge(verifications[0]);
  }
  const conversation = () => verifyAt('/chat/abc', ['claude.thread', 'claude.composer']);
  const newChat = () => verifyAt('/new', ['claude.composer']);

  it.each([
    ['대화 화면, 넓은 창', () => chatLayout(1500), conversation],
    ['대화 화면, 정한 너비보다 좁은 창', () => chatLayout(1000), conversation],
    ['대화 화면, 사이트의 원래 너비보다 좁은 창', () => chatLayout(700), conversation],
    ['새 채팅 화면, 넓은 창', () => newChatLayout(1500), newChat],
    ['새 채팅 화면, 정한 너비보다 좁은 창', () => newChatLayout(1000), newChat],
    ['새 채팅 화면, 사이트의 원래 너비보다 좁은 창', () => newChatLayout(600), newChat],
  ])('CLD-1.6 COM-6.8 %s: 너비 규칙이 작용하면 확인을 통과한다', (_name, draw, verify) => {
    draw();
    expect(verify()).toBeNull();
  });

  it.each([
    ['넓은 창', 1500],
    ['정한 너비보다 좁은 창', 1000],
    ['사이트의 원래 너비보다 좁은 창', 700],
  ])(
    'CLD-1.6 사이트가 열 너비 변수를 쓰지 않으면 %s에서도 대화 열이 걸리지 않은 것이다',
    (_name, space) => {
      chatLayout(space, { variable: false });
      expect(conversation()).toBe('claude.thread');
    },
  );

  it('새 채팅 화면에서 사이트가 작성란 자리의 단서를 바꾸면(작성란은 그대로) 작성란이 걸리지 않은 것이다', () => {
    newChatLayout(1500, { slotCue: false });
    expect(newChat()).toBe('claude.composer');
  });

  it('확인은 규칙을 잠시 바꿨다 되돌려 문서와 너비가 확인 전과 같다', () => {
    const { widths } = chatLayout(700);
    history.replaceState(null, '', '/chat/abc');
    const { verifications } = start(on(1200));
    const before = { html: document.documentElement.outerHTML, widths: widths() };
    expect(judge(verifications[0])).toBeNull();
    expect({ html: document.documentElement.outerHTML, widths: widths() }).toEqual(before);
  });
});
