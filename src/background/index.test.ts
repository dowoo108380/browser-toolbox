import { describe, expect, it, vi } from 'vitest';
import { specs, stored } from '../../tests/support/settings.ts';
import { createFakeLocalStore } from '../platform/fake.ts';
import type { LocalStore } from '../platform/index.ts';
import { type AppError, appError } from '../shared/index.ts';
import { settingsFormat, settingsKey } from '../storage/index.ts';
import { startBackground } from './index.ts';

// 서비스 워커가 시작할 때 하는 일(결정 0011 "형식 이전과 고쳐 쓰기", quality 067).

// 돌려준 함수를 부르면 설치·갱신 이벤트가 온 것처럼 한다.
function start(
  store: LocalStore,
  retire: (report: (problem: AppError) => void) => Promise<void> = () => Promise.resolve(),
) {
  const clock = { time: 1_790_000_000_000 };
  let installed: () => void = () => undefined;
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
    onInstalled: (listener) => {
      installed = listener;
    },
    retireOldScripts: retire,
  });
  return () => {
    installed();
  };
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

describe('설치·갱신 때 옛 스크립트 정리(결정 0008)', () => {
  it('quality 067 정리가 알린 문제를 종류마다 한 번 기록한다(탭이 많아도 문제 기록을 채우지 않게)', async () => {
    const store = createFakeLocalStore();
    const install = start(store, async (report) => {
      report(appError('unexpected', '정리 함수가 끝까지 돌지 못했다.'));
      report(appError('unexpected', '정리 함수가 끝까지 돌지 못했다.'));
      report(appError('platform', '넣지 못했다.'));
      // 늦게 끝난 탭이 같은 종류를 다시 알려도 남기지 않는다.
      await settle();
      report(appError('unexpected', '정리 함수가 끝까지 돌지 못했다.'));
      report(appError('timeout', '응답하지 않았다.'));
    });
    await settle();
    install();
    await vi.waitFor(() => {
      expect(recordedKinds(store)).toEqual(['unexpected', 'platform', 'timeout']);
    });
    await settle();
    expect(recordedKinds(store)).toEqual(['unexpected', 'platform', 'timeout']);
  });

  it('quality 067 알린 문제는 정리 전체가 끝나기를 기다리지 않고 기록한다(그 사이 서비스 워커가 멈춰도 남게)', async () => {
    const store = createFakeLocalStore();
    const install = start(store, (report) => {
      report(appError('platform', '넣지 못했다.'));
      return new Promise(() => undefined);
    });
    await settle();
    install();
    await vi.waitFor(() => {
      expect(recordedKinds(store)).toEqual(['platform']);
    });
  });

  it('알린 문제가 없으면 기록하지 않고, 정리 자체가 실패하면 platform을 기록한다', async () => {
    const quiet = createFakeLocalStore();
    start(quiet)();
    await settle();
    expect(recordedKinds(quiet)).toEqual([]);
    const failing = createFakeLocalStore();
    start(failing, () => Promise.reject(new Error('tabs.query 실패')))();
    await vi.waitFor(() => {
      expect(recordedKinds(failing)).toEqual(['platform']);
    });
  });
});
