// chrome.storage.local을 감싼다. 저장소를 직접 읽고 쓰는 곳은 이 모듈과 그 가짜뿐이다(quality 059).

export interface KeyValueStore {
  // 키가 없으면 undefined.
  get(key: string): Promise<unknown>;
  set(items: Readonly<Record<string, unknown>>): Promise<void>;
  // 그 키가 바뀔 때마다 새 값을 준다(지워지면 undefined). 돌려준 함수로 듣기를 그만둔다.
  onChanged(key: string, listener: (newValue: unknown) => void): () => void;
}

export function chromeLocalStore(): KeyValueStore {
  return {
    async get(key) {
      const items = await chrome.storage.local.get(key);
      const value: unknown = items[key];
      return value;
    },
    async set(items) {
      await chrome.storage.local.set({ ...items });
    },
    onChanged(key, listener) {
      const handle = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
        const change = changes[key];
        if (area === 'local' && change !== undefined) listener(change.newValue);
      };
      chrome.storage.onChanged.addListener(handle);
      return () => {
        chrome.storage.onChanged.removeListener(handle);
      };
    },
  };
}
