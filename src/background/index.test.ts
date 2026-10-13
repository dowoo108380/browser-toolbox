import { describe, expect, it, vi } from 'vitest';
import { specs, stored } from '../../tests/support/settings.ts';
import { createFakeLocalStore } from '../platform/fake.ts';
import type { LocalStore } from '../platform/index.ts';
import { settingsFormat, settingsKey } from '../storage/index.ts';
import { startBackground } from './index.ts';

// 서비스 워커가 시작할 때 하는 일(결정 0011 "형식 이전과 고쳐 쓰기", quality 067).

function start(store: LocalStore) {
  const clock = { time: 1_790_000_000_000 };
  startBackground({
    features: specs,
    format: settingsFormat,
    store,
    now: () => clock.time,
    sleep: (ms) => {
      clock.time += ms;
      return Promise.resolve();
    },
    listenRequests: () => undefined,
    onInstalled: () => undefined,
    retireOldScripts: () => Promise.resolve(),
  });
}

// 문제 기록에 남은 종류들.
function recordedKinds(store: LocalStore & { peek: (key: string) => unknown }): unknown[] {
  const records = store.peek('problems');
  if (!Array.isArray(records)) return [];
  const list: unknown[] = records;
  return list.map((record) =>
    typeof record === 'object' && record !== null && 'kind' in record ? record.kind : null,
  );
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('서비스 워커 시작', () => {
  it('처음 설치면 기본 설정을 쓰고 아무것도 기록하지 않는다', async () => {
    const store = createFakeLocalStore();
    start(store);
    await vi.waitFor(() => {
      expect(store.peek(settingsKey)).toMatchObject({ version: 1, features: {}, sites: {} });
    });
    await settle();
    expect(recordedKinds(store)).toEqual([]);
  });

  it('설정을 준비하지 못하면(저장 실패) 그 결과를 버리지 않고 기록한다', async () => {
    const fake = createFakeLocalStore();
    const store = {
      ...fake,
      set: (items: Readonly<Record<string, unknown>>) =>
        settingsKey in items ? Promise.reject(new Error('quota')) : fake.set(items),
    };
    start(store);
    await vi.waitFor(() => {
      expect(recordedKinds(fake)).toEqual(['platform']);
    });
  });

  it('고쳐 쓸 값이 최종 검증에 걸리면 unexpected를 한 번만 기록하고 저장된 값은 그대로다', async () => {
    const value = stored(Number.MAX_SAFE_INTEGER, { sample: { enabled: 'no' } });
    const store = createFakeLocalStore({ [settingsKey]: value });
    start(store);
    await vi.waitFor(() => {
      expect(recordedKinds(store)).toEqual(['unexpected']);
    });
    await settle();
    expect(recordedKinds(store)).toEqual(['unexpected']);
    expect(store.peek(settingsKey)).toEqual(value);
  });
});
