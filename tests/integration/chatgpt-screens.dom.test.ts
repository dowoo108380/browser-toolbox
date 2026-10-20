import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PageStatus, pageRuntimeKey, retireEventName } from '../../src/contracts/index.ts';
import { elementTimeoutMs, pageElementAttribute } from '../../src/dom/index.ts';
import { page } from '../../src/features/chatgpt-width/page.ts';
import { startPageRuntime } from '../../src/page/index.ts';
import type { PageProblem } from '../../src/page/runtime.ts';
import { appError, err, ok } from '../../src/shared/index.ts';
import type { SettingsReaderHandlers } from '../../src/storage/index.ts';

// GPT-2를 실제 실행 틀(찾기, 적용 확인, 기능 수명, 기록)로 로그인한 chatgpt.com의 화면 바꾸기에서 본다(COM-6, 결정 0034).
// 2026-10-19에 사용자의 Chrome에서 구조만 본 화면 바꾸기를 본뜬다: 화면마다 상자([data-app-shell-page-surface], 그 화면의
// main을 담음)가 하나의 바깥 상자 안에 있고, 페이지 안에서 이동하면 앞 화면의 상자를 style="display: none"으로 숨긴 채 남기고
// 지금 화면의 상자(display: contents)를 그 뒤에 둔다. 그래서 단서에 맞는 요소가 문서 앞쪽의 숨은 것부터 나온다. 사이트는
// 이동 신호(주소 바꿈) 뒤에 새 화면을 그리므로, 신호를 받은 때에는 앞 화면이 아직 보인다. 가짜는 설정 구독과 기록 통로뿐이고
// 시계는 가짜다.

const originalUrl = location.href;
const cleanups: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  history.replaceState(null, '', '/c/abc');
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.useRealTimers();
  history.replaceState(null, '', originalUrl);
});

// 관찰 알림(마이크로태스크)까지 처리한다.
async function settle() {
  for (let step = 0; step < 5; step += 1) await Promise.resolve();
}

// 화면에 그리는 대화 열: 단서에 맞는 것, 사이트가 속성을 바꿔 단서에 맞지 않게 된 것, 없음(새 채팅 화면).
type Thread = 'clue' | 'changed' | 'none';

// 사이트처럼 열 상자가 열 너비 변수로 최대 너비를 정한다(결정 0032). 바깥 상자는 1500px이다.
function chatgptScreens() {
  const rules = document.createElement('style');
  rules.textContent = `
    .test-surface { display: flex; flex-direction: column; width: 1500px; }
    .test-surface .test-surface { display: contents; }
    .test-column {
      --thread-content-max-width: 48rem;
      box-sizing: border-box; display: flex; flex-direction: column; width: 100%;
      max-width: calc(var(--thread-content-max-width) + 40px); margin-inline: auto; padding-inline: 20px;
    }`;
  document.head.append(rules);
  const surface = () => {
    const box = document.createElement('div');
    box.className = 'test-surface';
    box.setAttribute('data-app-shell-page-surface', '');
    return box;
  };
  const outer = surface();
  document.body.append(outer);
  cleanups.push(() => {
    outer.remove();
    rules.remove();
  });
  const column = (child: Element) => {
    const bound = document.createElement('div');
    bound.className = 'test-column';
    bound.append(child);
    return bound;
  };

  // 새 화면을 지금 화면으로 그린다. 앞 화면의 상자는 숨긴 채 남긴다.
  const draw = (thread: Thread) => {
    const previous = outer.lastElementChild;
    if (previous instanceof HTMLElement) previous.style.display = 'none';
    const main = document.createElement('main');
    main.setAttribute('data-app-shell-main-surface', '');
    if (thread !== 'none') {
      const target = document.createElement('div');
      target.setAttribute(
        thread === 'clue' ? 'data-thread-find-target' : 'data-thread-scroll-target',
        '',
      );
      const turn = document.createElement('div');
      turn.setAttribute('data-turn-key', '');
      target.append(turn);
      main.append(column(target));
    }
    const form = document.createElement('form');
    form.setAttribute('data-chatgpt-composer', '');
    main.append(column(form));
    const screen = surface();
    screen.append(main);
    outer.append(screen);
    return screen;
  };

  // 지금 화면(보이는 것)의 대화 열과 작성란의 그려진 너비. 없으면 null이다.
  const widths = () => {
    const shown = (selector: string) => {
      const width = [...document.querySelectorAll(selector)]
        .map((element) => Math.round(element.getBoundingClientRect().width))
        .find((value) => value > 0);
      return width ?? null;
    };
    return {
      thread: shown('[data-thread-find-target], [data-thread-scroll-target]'),
      composer: shown('form[data-chatgpt-composer]'),
    };
  };
  return { draw, widths };
}

// GPT-2만 든 실행 틀을 이 문서에서 시작하고 켜진 설정(정한 너비 1200px)을 준다. 시험이 끝나면 물러나게 한다.
function startGpt2() {
  let handlers: SettingsReaderHandlers | undefined;
  let answerStatus: (() => PageStatus) | undefined;
  const reports: PageProblem[] = [];
  const runtime = { connected: true };
  startPageRuntime({
    parts: [page],
    bundle: 'chatgpt',
    context: { window, document },
    topFrame: true,
    subscribe: (next) => {
      handlers = next;
      return () => undefined;
    },
    report: (problem) => {
      reports.push(problem);
      return Promise.resolve(ok(null));
    },
    isConnected: () => runtime.connected,
    listenNotices: () => () => undefined,
    subscribeTab: () => () => undefined,
    sendCommand: () => Promise.resolve(err(appError('unavailable', '기능 명령을 쓰지 않는다.'))),
    listenCommands: () => () => undefined,
    listenStatus: (answer) => {
      answerStatus = answer;
      return () => undefined;
    },
  });
  cleanups.push(() => {
    runtime.connected = false;
    document.dispatchEvent(new Event(retireEventName));
    Reflect.deleteProperty(globalThis, Symbol.for(pageRuntimeKey));
  });
  handlers?.apply(
    { features: new Map([['chatgpt-width', { enabled: true, width: 1200 }]]), sites: new Map() },
    1,
  );
  return { reports, status: () => answerStatus?.() };
}

const styled = () =>
  document.querySelector(`style[${pageElementAttribute}="chatgpt-width"]`) !== null;

const threadNotFound: PageProblem = {
  featureId: 'chatgpt-width',
  kind: 'not-found',
  element: { id: 'chatgpt.thread', name: 'ChatGPT 대화 열' },
};

// 탭이 보인 시간이 찾기·확인의 한도를 넘게 시계를 돌린다.
async function passLimit() {
  vi.advanceTimersByTime(elementTimeoutMs);
  await settle();
}

describe('앞 화면이 숨긴 채 남는 로그인한 chatgpt.com에서 GPT-2(결정 0034)', () => {
  it('GPT-2.5 COM-6.1 COM-6.3 앞 화면의 대화 열이 숨은 채 남아 있어도 지금 화면의 대화 열이 단서에 맞지 않으면 15초 뒤 찾지 못함으로 멈춰 되돌리고 기록하며, 지금 화면의 것이 단서에 맞게 되면 다시 작용한다', async () => {
    const screens = chatgptScreens();
    screens.draw('clue');
    const current = screens.draw('changed');
    const gpt2 = startGpt2();
    // 찾는 동안에는 너비가 걸려 있다.
    expect(screens.widths()).toEqual({ thread: 1200, composer: 1200 });

    await passLimit();
    expect(gpt2.reports).toEqual([threadNotFound]);
    expect(styled()).toBe(false);
    expect(screens.widths()).toEqual({ thread: 768, composer: 768 });
    expect(gpt2.status()).toEqual({
      unmet: [
        {
          featureId: 'chatgpt-width',
          reason: 'not-found',
          element: { id: 'chatgpt.thread', name: 'ChatGPT 대화 열' },
        },
      ],
    });

    // 지금 화면의 대화 열이 단서에 맞게 되면 다시 작용하고, 15초가 지나도 또 어긋나지 않는다.
    current
      .querySelector('[data-thread-scroll-target]')
      ?.setAttribute('data-thread-find-target', '');
    await settle();
    expect(styled()).toBe(true);
    expect(screens.widths()).toEqual({ thread: 1200, composer: 1200 });
    await passLimit();
    expect(gpt2.reports).toEqual([threadNotFound]);
    expect(gpt2.status()).toEqual({ unmet: [] });
  });

  it('GPT-2.2 COM-6 기대 동작 4 기존 대화와 새 채팅을 오가며 앞 화면이 숨은 채 쌓여도 새 화면의 요소가 단서에 맞으면 15초가 지나도 어긋남이 없고, 이동 신호 때 앞 화면의 대화 열이 아직 보여도 새 화면의 대화 열이 단서에 맞지 않으면 15초 뒤 찾지 못함이다', async () => {
    const screens = chatgptScreens();
    screens.draw('clue');
    const gpt2 = startGpt2();
    await passLimit();
    expect(gpt2.reports).toEqual([]);

    // 사이트처럼 주소를 먼저 바꾸고(이동 신호) 새 화면을 그린다.
    const moveTo = async (pathname: string, thread: Thread) => {
      history.pushState(null, '', pathname);
      screens.draw(thread);
      await settle();
    };
    await moveTo('/', 'none');
    await passLimit();
    await moveTo('/c/def', 'clue');
    await passLimit();
    expect(gpt2.reports).toEqual([]);
    expect(screens.widths()).toEqual({ thread: 1200, composer: 1200 });

    // 이동 신호 때에는 앞 화면(/c/def)의 단서에 맞는 대화 열이 아직 보인다.
    await moveTo('/c/ghi', 'changed');
    await passLimit();
    expect(gpt2.reports).toEqual([threadNotFound]);
    expect(styled()).toBe(false);
  });
});
