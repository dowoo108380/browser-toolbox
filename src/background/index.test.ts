import { describe, expect, it, vi } from 'vitest';
import { startTestBackground } from '../../tests/support/background.ts';
import { specs, stored } from '../../tests/support/settings.ts';
import { defineFeature, tabStatus, taskStart } from '../contracts/index.ts';
import { createFakeStore } from '../platform/fake.ts';
import type { KeyValueStore, PageProbe } from '../platform/index.ts';
import { type AppError, appError, ok } from '../shared/index.ts';
import { settingsFormat, settingsKey, tasksKey } from '../storage/index.ts';
import { defineTaskPart, startBackground } from './index.ts';

// 서비스 워커가 시작할 때 하는 일(결정 0011 "형식 이전과 고쳐 쓰기", quality 067).

// 돌려준 함수를 부르면 설치·갱신 이벤트가 온 것처럼 한다.
function start(
  store: KeyValueStore,
  retire: (report: (problem: AppError) => void) => Promise<void> = () => Promise.resolve(),
) {
  const clock = { time: 1_790_000_000_000 };
  let installed: () => void = () => undefined;
  startBackground({
    features: specs,
    format: settingsFormat,
    store,
    session: createFakeStore(),
    taskParts: [],
    randomId: () => 'task',
    tabExists: () => Promise.resolve(true),
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
    probePage: () => Promise.resolve({ status: 'ran', runtime: true }),
  });
  return () => {
    installed();
  };
}

// 문제 기록에 남은 종류들.
function recordedKinds(store: KeyValueStore & { peek: (key: string) => unknown }): unknown[] {
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
    const store = createFakeStore();
    start(store);
    await vi.waitFor(() => {
      expect(store.peek(settingsKey)).toMatchObject({ version: 1, features: {}, sites: {} });
    });
    await settle();
    expect(recordedKinds(store)).toEqual([]);
  });

  it('설정을 준비하지 못하면(저장 실패) 그 결과를 버리지 않고 기록한다', async () => {
    const fake = createFakeStore();
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
    const store = createFakeStore({ [settingsKey]: value });
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
    const store = createFakeStore();
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
    const store = createFakeStore();
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
    const quiet = createFakeStore();
    start(quiet)();
    await settle();
    expect(recordedKinds(quiet)).toEqual([]);
    const failing = createFakeStore();
    start(failing, () => Promise.reject(new Error('tabs.query 실패')))();
    await vi.waitFor(() => {
      expect(recordedKinds(failing)).toEqual(['platform']);
    });
  });
});

describe('결정 0023 지금 탭의 상태(tab.status)', () => {
  async function statusWith(probe: PageProbe) {
    const store = createFakeStore();
    const probed: number[] = [];
    const request = startTestBackground({
      store,
      features: specs,
      startTime: 1_790_000_000_000,
      probePage: (tabId) => {
        probed.push(tabId);
        return Promise.resolve(probe);
      },
    });
    const result = await request(tabStatus, { tabId: 7 });
    await settle();
    return { result, probed, recorded: recordedKinds(store) };
  }

  it('그 탭의 최상위 문서에 실행 틀이 있으면 ready, 넣을 수는 있는데 없으면 reload다', async () => {
    const ready = await statusWith({ status: 'ran', runtime: true });
    expect(ready.result).toEqual({ ok: true, value: { page: 'ready' } });
    expect(ready.probed).toEqual([7]);
    const reload = await statusWith({ status: 'ran', runtime: false });
    expect(reload.result).toEqual({ ok: true, value: { page: 'reload' } });
    expect(reload.recorded).toEqual([]);
  });

  it('Chrome이 알려진 문구로 거절하면 denied이고 기록하지 않는다', async () => {
    const denied = await statusWith({ status: 'unavailable' });
    expect(denied.result).toEqual({ ok: true, value: { page: 'denied' } });
    expect(denied.recorded).toEqual([]);
  });

  it('quality 067 알려지지 않은 거절도 denied로 답하되 platform으로 기록한다', async () => {
    const failed = await statusWith({ status: 'failed' });
    expect(failed.result).toEqual({ ok: true, value: { page: 'denied' } });
    expect(failed.recorded).toEqual(['platform']);
  });
});

describe('결정 0024 실행 기능의 작업(task.start)', () => {
  const action = defineFeature({
    id: 'save',
    requirements: [],
    name: '저장',
    description: '시험용',
    category: 'tabs',
    kind: 'action',
    content: null,
    permissions: [],
    task: { timeoutMs: 1000 },
  });

  it('요청을 그 기능의 일로 보내 작업 id로 답하고, 끝을 세션 저장소의 작업 기록에 남긴다', async () => {
    const session = createFakeStore();
    const tabs: number[] = [];
    const part = defineTaskPart(action, ({ tabId }) => {
      tabs.push(tabId);
      return Promise.resolve(ok({ summary: '끝' }));
    });
    const request = startTestBackground({
      store: createFakeStore(),
      features: [...specs, action],
      startTime: 1_790_000_000_000,
      session,
      taskParts: [part],
    });
    expect(await request(taskStart, { featureId: 'save', tabId: 3 })).toEqual(
      ok({ taskId: 'task-1' }),
    );
    await vi.waitFor(() => {
      expect(session.peek(tasksKey)).toEqual({
        '3': { id: 'task-1', featureId: 'save', status: 'succeeded', summary: '끝' },
      });
    });
    expect(tabs).toEqual([3]);
  });

  it('quality 066 실행 기능의 일이 등록 목록에 없으면 서비스 워커가 시작하지 않고 던진다', () => {
    expect(() =>
      startTestBackground({
        store: createFakeStore(),
        features: [...specs, action],
        startTime: 1_790_000_000_000,
      }),
    ).toThrow('실행 기능 save의 일이 0개다.');
  });
});
