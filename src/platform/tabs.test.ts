import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTabActive, listenTabEvents, tabExists } from './tabs.ts';

// 탭 경계(결정 0024). 진짜 chrome 대신 시험이 만든 객체를 전역에 둔다. 서비스 워커를 깨우는지는 Chrome의 일이라
// 여기서는 듣기를 걸고 그만두는 것만 본다(그만두면 깨우지 않는 것은 결정 0024의 실험 6).

afterEach(() => {
  vi.unstubAllGlobals();
});

type Listener = (...args: never[]) => void;

function fakeEvent() {
  const listeners = new Set<Listener>();
  return {
    listeners,
    addListener: (listener: Listener) => listeners.add(listener),
    removeListener: (listener: Listener) => listeners.delete(listener),
    hasListener: (listener: Listener) => listeners.has(listener),
    fire: (...args: unknown[]) => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- 시험이 Chrome처럼 인자를 넘긴다.
      for (const listener of listeners) (listener as (...values: unknown[]) => void)(...args);
    },
  };
}

function fakeTabs(get: (tabId: number) => Promise<unknown> = () => Promise.resolve({})) {
  const removed = fakeEvent();
  const updated = fakeEvent();
  vi.stubGlobal('chrome', { tabs: { onRemoved: removed, onUpdated: updated, get } });
  return { removed, updated };
}

describe('탭 닫힘과 이동 듣기', () => {
  it('처음부터 듣고, 닫힘과 로딩 상태의 바뀜만 넘긴다(제목·아이콘 등의 바뀜은 넘기지 않는다)', () => {
    const { removed, updated } = fakeTabs();
    const seen: string[] = [];
    listenTabEvents({
      removed: (tabId) => seen.push(`removed ${String(tabId)}`),
      navigated: (tabId) => seen.push(`navigated ${String(tabId)}`),
    });
    removed.fire(3, { windowId: 1 });
    updated.fire(4, { status: 'loading', url: 'http://a.test/' });
    updated.fire(4, { title: '제목' });
    updated.fire(4, { status: 'complete' });
    expect(seen).toEqual(['removed 3', 'navigated 4', 'navigated 4']);
  });

  it('그만두면 듣지 않고, 다시 걸면 듣는다. 거듭 걸어도 한 번만 듣는다', () => {
    const { removed, updated } = fakeTabs();
    const seen: number[] = [];
    const events = listenTabEvents({
      removed: (tabId) => seen.push(tabId),
      navigated: () => undefined,
    });
    events.listen(false);
    expect([removed.listeners.size, updated.listeners.size]).toEqual([0, 0]);
    removed.fire(1, {});
    events.listen(true);
    events.listen(true);
    expect([removed.listeners.size, updated.listeners.size]).toEqual([1, 1]);
    removed.fire(2, {});
    events.listen(false);
    events.listen(false);
    expect([removed.listeners.size, updated.listeners.size]).toEqual([0, 0]);
    expect(seen).toEqual([2]);
  });
});

// 탭 1은 창의 지금 탭, 탭 2는 뒤쪽 탭, 탭 3은 닫힌 탭이다. 그 밖의 탭은 Chrome이 알려지지 않은 까닭으로 거절한다.
const tabs = (tabId: number) => {
  if (tabId === 1 || tabId === 2) return Promise.resolve({ id: tabId, active: tabId === 1 });
  if (tabId === 3) return Promise.reject(new Error('No tab with id: 3.'));
  return Promise.reject(new Error('알려지지 않은 거절'));
};

describe('탭이 열려 있는지', () => {
  it('Chrome이 탭을 주면 참, 닫힌 탭이라 거절하면 거짓이다', async () => {
    fakeTabs(tabs);
    expect(await tabExists(1)).toBe(true);
    expect(await tabExists(3)).toBe(false);
  });

  it('닫힌 탭이 아닌 거절은 닫힌 탭으로 여기지 않고 던진다', async () => {
    fakeTabs(tabs);
    await expect(tabExists(9)).rejects.toThrow('알려지지 않은 거절');
  });
});

describe('창의 지금 탭인지', () => {
  it('지금 탭이면 참, 뒤쪽 탭이거나 닫힌 탭이면 거짓이다', async () => {
    fakeTabs(tabs);
    expect(await isTabActive(1)).toBe(true);
    expect(await isTabActive(2)).toBe(false);
    expect(await isTabActive(3)).toBe(false);
  });

  it('닫힌 탭이 아닌 거절은 닫힌 탭으로 여기지 않고 던진다', async () => {
    fakeTabs(tabs);
    await expect(isTabActive(9)).rejects.toThrow('알려지지 않은 거절');
  });
});
