import { isExtensionConnected } from './messaging.ts';

// chrome.storage의 local과 session을 감싼다. 저장소를 직접 읽고 쓰는 곳은 이 모듈과 그 가짜뿐이다(quality 059).
// local은 설정처럼 오래 남기는 값, session은 탭마다의 작업 기록처럼 확장을 다시 불러오거나 갱신하거나 브라우저를 다시
// 시작하면 비는 값이다(결정 0024의 실험 2). 두 영역의 계약은 같다(tests/contract/store.ts).

export interface KeyValueStore {
  // 키가 없으면 undefined.
  get(key: string): Promise<unknown>;
  set(items: Readonly<Record<string, unknown>>): Promise<void>;
  // 그 키가 바뀔 때마다 새 값을 준다(지워지면 undefined). 돌려준 함수로 듣기를 그만둔다.
  onChanged(key: string, listener: (newValue: unknown) => void): () => void;
}

type AreaName = 'local' | 'session';

function chromeStore(areaName: AreaName): KeyValueStore {
  const area = chrome.storage[areaName];
  return {
    async get(key) {
      const items = await area.get(key);
      const value: unknown = items[key];
      return value;
    },
    async set(items) {
      await area.set({ ...items });
    },
    onChanged(key, listener) {
      // chrome.storage.onChanged는 모든 영역의 바뀜을 한 곳에서 알린다. 이 영역의 것만 넘긴다.
      const handle = (changes: Record<string, chrome.storage.StorageChange>, changed: string) => {
        const change = changes[key];
        if (changed === areaName && change !== undefined) listener(change.newValue);
      };
      chrome.storage.onChanged.addListener(handle);
      return () => {
        // 확장을 다시 불러온 뒤의 옛 콘텐츠 스크립트(연결이 끊긴 세계)에서는 chrome.storage가 없어지기도 하고(2026-10-18,
        // 사용자의 Chrome), Chrome이 그 세계의 듣기를 더 부르지 않으므로 그만둘 것도 없다. 그만두기가 던지지 않게 한다.
        if (isExtensionConnected()) chrome.storage.onChanged.removeListener(handle);
      };
    },
  };
}

export function chromeLocalStore(): KeyValueStore {
  return chromeStore('local');
}

export function chromeSessionStore(): KeyValueStore {
  return chromeStore('session');
}
