import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostTagName, pageElementAttribute } from '../dom/index.ts';
import { createNoticeBoard, noticeMs } from './notice.ts';

// 페이지 위 작업 결과 알림(COM-10 기대 동작 4, 결정 0024). 알림은 닫힌 shadow root 안에 있다. 시험은 attachShadow가 돌려준
// root를 잡아서 안을 본다.

let roots: ShadowRoot[] = [];
// eslint-disable-next-line @typescript-eslint/unbound-method -- 아래에서 call로 this를 주어 부른다.
const originalAttachShadow = Element.prototype.attachShadow;

beforeEach(() => {
  roots = [];
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (
    this: Element,
    init: ShadowRootInit,
  ) {
    const root = originalAttachShadow.call(this, init);
    if (this.localName === hostTagName) roots.push(root);
    return root;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const host of document.querySelectorAll(hostTagName)) host.remove();
  Reflect.deleteProperty(document, 'visibilityState');
});

const hosts = () => [...document.querySelectorAll<HTMLElement>(hostTagName)];
const text = () => roots.at(-1)?.querySelector('.notice')?.textContent ?? null;

describe('페이지 위 작업 결과 알림', () => {
  it('글을 최상위 층에 띄우고 화면 낭독기가 읽게 하며, 3초 뒤에 지운다', () => {
    vi.useFakeTimers();
    const board = createNoticeBoard({ window, document });
    board.show('자막 저장: 끝났다. 영상.txt');
    const [host] = hosts();
    expect(host?.matches(':popover-open')).toBe(true);
    expect(host?.getAttribute(pageElementAttribute)).toBe('task-notice');
    expect(text()).toBe('자막 저장: 끝났다. 영상.txt');
    expect(roots.at(-1)?.querySelector('.notice')?.getAttribute('role')).toBe('status');
    vi.advanceTimersByTime(noticeMs - 1);
    expect(hosts()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(hosts()).toHaveLength(0);
  });

  it('페이지 오른쪽 위에 있고 누르기를 가로채지 않는다(페이지 CSS와 popover 기본 스타일에 상관없이)', () => {
    const pageStyle = document.createElement('style');
    pageStyle.textContent =
      '[popover] { inset: 0 !important; margin: auto !important; pointer-events: auto !important; }';
    document.head.append(pageStyle);
    try {
      createNoticeBoard({ window, document }).show('끝났다.');
      const [host] = hosts();
      if (host === undefined) throw new Error('알림이 없다.');
      const box = host.getBoundingClientRect();
      expect(Math.round(window.innerWidth - box.right)).toBe(16);
      expect(Math.round(box.top)).toBe(16);
      expect(getComputedStyle(host).pointerEvents).toBe('none');
    } finally {
      pageStyle.remove();
    }
  });

  it('다음 알림이 오면 앞의 것을 바꾸고, 그때부터 3초를 다시 센다', () => {
    vi.useFakeTimers();
    const board = createNoticeBoard({ window, document });
    board.show('첫째');
    vi.advanceTimersByTime(2000);
    board.show('둘째');
    expect(hosts()).toHaveLength(1);
    expect(text()).toBe('둘째');
    vi.advanceTimersByTime(2000);
    expect(hosts()).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(hosts()).toHaveLength(0);
  });

  it('close로 남은 알림을 지운다(실행 틀이 물러날 때). 지운 뒤의 시간은 할 일이 없다', () => {
    vi.useFakeTimers();
    const board = createNoticeBoard({ window, document });
    board.show('끝났다.');
    board.close();
    expect(hosts()).toHaveLength(0);
    board.close();
    vi.advanceTimersByTime(noticeMs);
    expect(hosts()).toHaveLength(0);
  });

  it('문서가 보이지 않으면 띄우지 않는다(배지만 남는다)', () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    createNoticeBoard({ window, document }).show('끝났다.');
    expect(hosts()).toHaveLength(0);
  });
});
