import type { LocalStore } from './storage.ts';

// 테스트용 가짜. 진짜와 같은 계약을 지킨다(quality 047). 테스트에서만 가져온다(결정 0004).

export interface FakeLocalStore extends LocalStore {
  // 테스트가 저장소를 직접 들여다보거나 바꾼다. 바꾸면 듣는 쪽에 알린다.
  peek(key: string): unknown;
  replace(key: string, value: unknown): void;
}

export function createFakeLocalStore(
  initial: Readonly<Record<string, unknown>> = {},
): FakeLocalStore {
  const items = new Map<string, unknown>(Object.entries(initial));
  const listeners = new Set<{ key: string; listener: (newValue: unknown) => void }>();
  // chrome.storage는 값을 구조화 복제해 저장한다. 같은 객체를 돌려주지 않는다.
  const copy = (value: unknown): unknown =>
    value === undefined ? undefined : structuredClone(value);
  const notify = (key: string) => {
    const value = items.get(key);
    for (const entry of listeners) if (entry.key === key) entry.listener(copy(value));
  };
  return {
    get(key) {
      return Promise.resolve(copy(items.get(key)));
    },
    set(values) {
      for (const [key, value] of Object.entries(values)) items.set(key, copy(value));
      for (const key of Object.keys(values)) notify(key);
      return Promise.resolve();
    },
    onChanged(key, listener) {
      const entry = { key, listener };
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    peek(key) {
      return copy(items.get(key));
    },
    replace(key, value) {
      if (value === undefined) items.delete(key);
      else items.set(key, copy(value));
      notify(key);
    },
  };
}
