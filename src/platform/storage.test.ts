import { afterEach, describe, expect, it, vi } from 'vitest';
import { chromeLocalStore } from './storage.ts';

// chrome.storage를 감싼 저장소의 바뀜 듣기(Chrome 경계). 진짜 chrome 대신 시험이 만든 객체를 전역에 둔다. 읽기와 쓰기의
// 계약은 실제 확장 안에서 본다(tests/e2e/storage-contract.spec.ts).

afterEach(() => {
  vi.unstubAllGlobals();
});

type Handle = (changes: Record<string, { newValue?: unknown }>, areaName: string) => void;

function fakeChrome() {
  const handles = new Set<Handle>();
  vi.stubGlobal('chrome', {
    runtime: { id: 'abcdefghijklmnopabcdefghijklmnop' },
    storage: {
      local: {},
      onChanged: {
        addListener: (handle: Handle) => handles.add(handle),
        removeListener: (handle: Handle) => handles.delete(handle),
      },
    },
  });
  return handles;
}

describe('저장소의 바뀜 듣기', () => {
  it('그 영역의 그 키가 바뀔 때만 새 값을 주고, 돌려준 함수로 그만둔다', () => {
    const handles = fakeChrome();
    const received: unknown[] = [];
    const stop = chromeLocalStore().onChanged('settings', (value) => received.push(value));
    for (const handle of handles) {
      handle({ settings: { newValue: 1 } }, 'local');
      handle({ settings: { newValue: 2 } }, 'session');
      handle({ other: { newValue: 3 } }, 'local');
      handle({ settings: {} }, 'local');
    }
    expect(received).toEqual([1, undefined]);
    stop();
    expect(handles.size).toBe(0);
  });

  it('COM-7.2 확장을 다시 불러와 연결이 끊긴 뒤(chrome.storage가 없어짐, 2026-10-18 사용자의 Chrome) 그만두기는 던지지 않는다', () => {
    for (const disconnected of [{ runtime: {} }, { runtime: {}, storage: undefined }, {}]) {
      fakeChrome();
      const stop = chromeLocalStore().onChanged('settings', () => undefined);
      vi.stubGlobal('chrome', disconnected);
      expect(stop).not.toThrow();
    }
  });
});
