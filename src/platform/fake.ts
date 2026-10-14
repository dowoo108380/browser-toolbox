import type { LocalStore } from './storage.ts';

// 테스트용 가짜. 진짜와 같은 계약을 지킨다(quality 047). 계약 사례는 tests/contract/local-store.ts에 있고,
// 같은 사례를 이 가짜(단위 시험)와 실제 chrome.storage.local(확장 안)에 돌린다. 테스트에서만 가져온다(결정 0004).

export interface FakeLocalStore extends LocalStore {
  // 테스트가 저장소를 직접 들여다보거나 바꾼다.
  peek(key: string): unknown;
  // 저장소 밖에서 일어난 변경(다른 화면의 쓰기, 개발자 도구로 고친 값, 손상)을 흉내 낸다. undefined면 지운다.
  // set과 달리 같은 값이어도 알린다. 읽기 결과와 바뀜 알림이 같은 값을 두 번 주는 경우를 흉내 내는 데 쓴다.
  replace(key: string, value: unknown): void;
}

// chrome.storage는 값을 복사해 저장하고 돌려주며, 객체의 키를 이름 순으로 정렬한다(안쪽 객체도. 배열 순서는
// 그대로). 계약 시험으로 실제 Chromium에서 확인했다(R-24의 관찰과 같다). 정렬은 UTF-16 순서다. Chrome은 UTF-8
// 바이트 순서로 보이지만 둘은 BMP 밖 글자와 U+E000–U+FFFF 사이에서만 다르다(키에 그런 글자를 쓰지 않는다).
function stored(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stored);
  if (typeof value === 'object' && value !== null) {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, stored(Reflect.get(value, key))]),
      );
    }
    return structuredClone(value);
  }
  return value;
}

export function createFakeLocalStore(
  initial: Readonly<Record<string, unknown>> = {},
): FakeLocalStore {
  const items = new Map<string, unknown>(
    Object.entries(initial).map(([key, value]) => [key, stored(value)]),
  );
  const listeners = new Set<{ key: string; listener: (newValue: unknown) => void }>();
  const notify = (key: string) => {
    const value = items.get(key);
    for (const entry of listeners) if (entry.key === key) entry.listener(stored(value));
  };
  return {
    get(key) {
      return Promise.resolve(stored(items.get(key)));
    },
    set(values) {
      // 값이 바뀐 키만 알린다. 같은 값을 다시 쓰면 Chrome은 바뀜 알림을 보내지 않는다(계약 시험으로 확인).
      const changed: string[] = [];
      for (const [key, value] of Object.entries(values)) {
        const next = stored(value);
        if (JSON.stringify(next) !== JSON.stringify(items.get(key))) changed.push(key);
        items.set(key, next);
      }
      for (const key of changed) notify(key);
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
      return stored(items.get(key));
    },
    replace(key, value) {
      if (value === undefined) items.delete(key);
      else items.set(key, stored(value));
      notify(key);
    },
  };
}
