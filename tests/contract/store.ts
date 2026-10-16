import type { KeyValueStore } from '../../src/platform/index.ts';

// KeyValueStore(chrome.storage의 local과 session을 감싼 경계)의 계약(quality 047). 같은 사례를 가짜
// (src/platform/fake.ts)에는 단위 시험으로(src/platform/storage-contract.test.ts), 실제(chromeLocalStore,
// chromeSessionStore)에는 확장의 서비스 워커 안에서 돌린다(tests/e2e/storage-contract.spec.ts). 확장 안에서도 돌아야
// 하므로 Vitest를 쓰지 않고, 틀리면 던진다.
// 바뀜 알림이 set의 완료보다 먼저 오는지 늦게 오는지는 계약이 아니다(Chrome 문서에 없음). 그래서 사례는
// 알림을 기다려서 본다. 쓰는 쪽과 읽는 쪽은 순서에 기대지 않는다(결정 0011의 revision, 0016의 stamp).

export interface ContractCase {
  readonly name: string;
  // key는 이 사례만 쓰는 키 이름을 만든다. 실제 저장소는 사례끼리 함께 쓰므로 키로 나눈다.
  readonly run: (store: KeyValueStore, key: (name: string) => string) => Promise<void>;
}

// 키 순서까지 같은지 본다(JSON 문자열로 비교). undefined는 "undefined"로 적는다.
function same(actual: unknown, expected: unknown, what: string): void {
  const text = (value: unknown) => (value === undefined ? 'undefined' : JSON.stringify(value));
  if (text(actual) !== text(expected)) {
    throw new Error(`${what}: ${text(expected)}이어야 하는데 ${text(actual)}였다.`);
  }
}

// 한 키의 바뀜 알림을 모은다. count개가 올 때까지 기다린다(실제 저장소는 알림을 나중에 보낸다).
function record(store: KeyValueStore, key: string) {
  const values: unknown[] = [];
  let wake: () => void = () => undefined;
  const stop = store.onChanged(key, (value) => {
    values.push(value);
    wake();
  });
  const waitFor = async (count: number, what: string) => {
    const deadline = Date.now() + 2000;
    while (values.length < count) {
      if (Date.now() > deadline) {
        throw new Error(
          `${what}: 바뀜 알림 ${String(count)}개를 기다렸는데 ${String(values.length)}개였다.`,
        );
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, 20);
      });
    }
  };
  return { values, waitFor, stop };
}

export const storeContract: readonly ContractCase[] = [
  {
    name: '없는 키를 읽으면 undefined다',
    run: async (store, key) => {
      await store.set({ [key('other')]: 1 });
      same(await store.get(key('missing')), undefined, '없는 키');
    },
  },
  {
    name: '쓴 뒤에 원래 객체를 바꿔도 저장된 값은 그대로다',
    run: async (store, key) => {
      const value = { list: [1, 2], nested: { flag: true } };
      await store.set({ [key('value')]: value });
      value.list.push(3);
      value.nested.flag = false;
      same(await store.get(key('value')), { list: [1, 2], nested: { flag: true } }, '저장된 값');
    },
  },
  {
    name: '읽은 값을 바꿔도 저장된 값은 그대로다(읽을 때마다 새 사본)',
    run: async (store, key) => {
      await store.set({ [key('value')]: { list: [1] } });
      const first = await store.get(key('value'));
      if (typeof first !== 'object' || first === null || !('list' in first)) {
        throw new Error('읽은 값의 모양이 틀렸다.');
      }
      const { list } = first;
      if (Array.isArray(list)) list.push(2);
      same(await store.get(key('value')), { list: [1] }, '다시 읽은 값');
    },
  },
  {
    name: '바뀜 알림의 값을 바꿔도 저장된 값은 그대로다',
    run: async (store, key) => {
      const changes = record(store, key('value'));
      await store.set({ [key('value')]: { list: [1] } });
      await changes.waitFor(1, '바뀜 알림');
      const [received] = changes.values;
      if (typeof received === 'object' && received !== null && 'list' in received) {
        const { list } = received;
        if (Array.isArray(list)) list.push(2);
      }
      changes.stop();
      same(await store.get(key('value')), { list: [1] }, '저장된 값');
    },
  },
  {
    name: '객체의 키는 이름 순으로 정렬되어 돌아온다(안쪽 객체도, 배열 순서는 그대로)',
    run: async (store, key) => {
      const changes = record(store, key('value'));
      await store.set({ [key('value')]: { b: 1, a: { d: [3, 1, 2], c: 2 } } });
      const expected = { a: { c: 2, d: [3, 1, 2] }, b: 1 };
      same(await store.get(key('value')), expected, '읽은 값의 키 순서');
      await changes.waitFor(1, '바뀜 알림');
      same(changes.values, [expected], '바뀜 알림 값의 키 순서');
      changes.stop();
    },
  },
  {
    name: '바뀜 알림은 그 키가 바뀔 때만, 새 값을 담아 온다',
    run: async (store, key) => {
      const first = record(store, key('first'));
      const second = record(store, key('second'));
      // 한 번에 두 키를 쓰면 키마다 자기 값이 한 번씩 온다.
      await store.set({ [key('first')]: { n: 1 }, [key('second')]: 'b' });
      await first.waitFor(1, '첫 키');
      await second.waitFor(1, '둘째 키');
      // 다른 키만 바꾸면 오지 않는다. 표식으로 첫 키를 다시 쓰고, 그 알림까지 기다린다.
      await store.set({ [key('second')]: 'c' });
      await store.set({ [key('first')]: { n: 2 } });
      await first.waitFor(2, '첫 키 표식');
      await second.waitFor(2, '둘째 키');
      same(first.values, [{ n: 1 }, { n: 2 }], '첫 키의 알림');
      same(second.values, ['b', 'c'], '둘째 키의 알림');
      first.stop();
      second.stop();
    },
  },
  {
    name: '같은 값을 다시 쓰면 바뀜 알림이 오지 않는다',
    run: async (store, key) => {
      const changes = record(store, key('value'));
      await store.set({ [key('value')]: { n: 1 } });
      await changes.waitFor(1, '처음 쓰기');
      await store.set({ [key('value')]: { n: 1 } });
      // 표식: 다른 값을 쓰고 그 알림까지 기다린다.
      await store.set({ [key('value')]: { n: 2 } });
      await changes.waitFor(2, '표식');
      same(changes.values, [{ n: 1 }, { n: 2 }], '알림');
      changes.stop();
    },
  },
  {
    name: '구독을 해제하면 그 듣기에만 알림이 그치고, 다른 듣기는 계속 받는다',
    run: async (store, key) => {
      const stopped = record(store, key('value'));
      const kept = record(store, key('value'));
      stopped.stop();
      await store.set({ [key('value')]: 1 });
      await kept.waitFor(1, '남은 듣기');
      // 해제한 듣기에 알림이 늦게 오는지 표식으로 한 번 더 기다린다.
      await store.set({ [key('value')]: 2 });
      await kept.waitFor(2, '남은 듣기 표식');
      same(stopped.values, [], '해제한 듣기');
      same(kept.values, [1, 2], '남은 듣기');
      kept.stop();
    },
  },
];

// 두 영역의 저장소는 서로의 바뀜을 알리지 않는다. chrome.storage.onChanged는 모든 영역의 바뀜을 한 곳에서 알리므로
// 실제 저장소에서만 뜻이 있다(가짜는 저장소마다 따로다). 확장 안에서 local과 session으로 돌린다.
export async function checkAreaIsolation(
  first: KeyValueStore,
  second: KeyValueStore,
  key: (name: string) => string,
): Promise<void> {
  const changes = record(second, key('shared'));
  await first.set({ [key('shared')]: 'first' });
  // 표식: 둘째 영역에 쓰고 그 알림까지 기다린다. 첫 영역의 바뀜이 왔다면 그 앞에 있다.
  await second.set({ [key('shared')]: 'second' });
  await changes.waitFor(1, '표식');
  same(changes.values, ['second'], '둘째 영역의 알림');
  same(await second.get(key('shared')), 'second', '둘째 영역의 값');
  same(await first.get(key('shared')), 'first', '첫 영역의 값');
  changes.stop();
}
