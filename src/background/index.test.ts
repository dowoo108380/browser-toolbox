import { describe, expect, it, vi } from 'vitest';
import { startTestBackground } from '../../tests/support/background.ts';
import { specs, stored } from '../../tests/support/settings.ts';
import {
  type PageStatus,
  defineFeature,
  problemReport,
  tabStatus,
  taskStart,
} from '../contracts/index.ts';
import { createFakeStore } from '../platform/fake.ts';
import type { KeyValueStore, PageProbe, TabEventHandlers, TabResponse } from '../platform/index.ts';
import { type AppError, appError, err, ok } from '../shared/index.ts';
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
    setTabBadge: () => Promise.resolve(),
    listenTabEvents: () => ({ listen: () => undefined }),
    watchPopups: () => ({ viewing: () => false }),
    isTabActive: () => Promise.resolve(true),
    notifyTab: () => Promise.resolve('unreachable' as const),
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
    askPage: () => Promise.resolve({ delivery: 'delivered', value: { notFound: [] } }),
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

describe('결정 0026 콘텐츠 스크립트가 알린 문제(problem.report)', () => {
  it('COM-5 기대 동작 2 찾지 못한 외부 화면 요소의 이름표와 이름을 기록하고, 64자를 넘는 이름은 받지 않는다', async () => {
    const store = createFakeStore();
    const request = startTestBackground({ store, features: specs, startTime: 1_790_000_000_000 });
    const element = { id: 'chatgpt.thread', name: 'ChatGPT 대화 열' };
    expect(
      await request(problemReport, { featureId: 'sample', kind: 'not-found', element }),
    ).toEqual(ok(null));
    const tooLong = await request(problemReport, {
      featureId: 'sample',
      kind: 'not-found',
      element: { id: 'chatgpt.thread', name: '가'.repeat(65) },
    });
    expect(tooLong.ok ? null : tooLong.error.kind).toBe('invalid-input');
    expect(store.peek('problems')).toMatchObject([
      { featureId: 'sample', kind: 'not-found', element },
    ]);
  });
});

describe('결정 0023 지금 탭의 상태(tab.status)', () => {
  async function statusWith(
    probe: PageProbe,
    answer: TabResponse<PageStatus> = { delivery: 'delivered', value: { notFound: [] } },
  ) {
    const store = createFakeStore();
    const probed: number[] = [];
    const asked: [number, number][] = [];
    const request = startTestBackground({
      store,
      features: specs,
      startTime: 1_790_000_000_000,
      probePage: (tabId) => {
        probed.push(tabId);
        return Promise.resolve(probe);
      },
      askPage: (tabId, timeoutMs) => {
        asked.push([tabId, timeoutMs]);
        return Promise.resolve(answer);
      },
    });
    const result = await request(tabStatus, { tabId: 7 });
    await settle();
    return { result, probed, asked, recorded: recordedKinds(store) };
  }

  it('그 탭의 최상위 문서에 실행 틀이 있으면 ready, 넣을 수는 있는데 없으면 reload다', async () => {
    const ready = await statusWith({ status: 'ran', runtime: true });
    expect(ready.result).toEqual({ ok: true, value: { page: 'ready', notFound: [] } });
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

  it('COM-6 기대 동작 2 결정 0026 실행 틀이 있는 탭은 그 최상위 프레임의 실행 틀에 1초 안에 물어 찾지 못한 기능을 함께 답한다', async () => {
    const notFound = [
      { featureId: 'sample', element: { id: 'chatgpt.thread', name: 'ChatGPT 대화 열' } },
    ];
    const ready = await statusWith(
      { status: 'ran', runtime: true },
      { delivery: 'delivered', value: { notFound } },
    );
    expect(ready.result).toEqual({ ok: true, value: { page: 'ready', notFound } });
    expect(ready.asked).toEqual([[7, 1000]]);
    expect(ready.recorded).toEqual([]);
  });

  it('결정 0026 실행 틀이 없거나 넣을 수 없는 탭에는 묻지 않는다', async () => {
    for (const probe of [
      { status: 'ran', runtime: false },
      { status: 'unavailable' },
      { status: 'failed' },
    ] as const) {
      expect((await statusWith(probe)).asked).toEqual([]);
    }
  });

  it('quality 067 실행 틀이 답하지 못하면 찾지 못함 없이 ready로 답하고, 받는 쪽이 없는 것(탐침 뒤에 물러남)이 아니면 기록한다', async () => {
    const cases = [
      ['unreachable', []],
      ['timeout', ['timeout']],
      ['failed', ['platform']],
    ] as const;
    for (const [delivery, recorded] of cases) {
      const answered = await statusWith({ status: 'ran', runtime: true }, { delivery });
      expect(answered.result).toEqual({ ok: true, value: { page: 'ready', notFound: [] } });
      expect(answered.recorded).toEqual(recorded);
    }
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

describe('결정 0024 작업 기록과 탭 사건의 연결', () => {
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
  const part = defineTaskPart(action, () => new Promise(() => undefined));

  function startWith(session: ReturnType<typeof createFakeStore>) {
    let handlers: TabEventHandlers | undefined;
    const listening: boolean[] = [];
    startTestBackground({
      store: createFakeStore(),
      features: [...specs, action],
      startTime: 1_790_000_000_000,
      session,
      taskParts: [part],
      listenTabEvents: (next) => {
        handlers = next;
        return { listen: (on) => listening.push(on) };
      },
    });
    if (handlers === undefined) throw new Error('탭 사건을 처음 실행 때 듣지 않았다.');
    return { handlers, listening };
  }

  it('시작할 때 앞 서비스 워커가 남긴 진행 중 작업을 끝내고, 기록이 남으면 탭 사건을 듣는다', async () => {
    const session = createFakeStore({
      [tasksKey]: { '3': { id: 'old', featureId: 'save', status: 'running' } },
    });
    const { listening } = startWith(session);
    await vi.waitFor(() => {
      expect(session.peek(tasksKey)).toMatchObject({ '3': { id: 'old', status: 'failed' } });
    });
    expect(listening).toEqual([true]);
  });

  it('COM-10.6 첫 작업의 기록을 쓰는 사이에 탭이 닫혀도 그 닫힘을 들어, 그 일을 멈추고 기록을 지운다', async () => {
    // 첫 기록(진행 중) 쓰기를 시험이 붙잡는다.
    const backing = createFakeStore();
    let releaseWrite: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writes = 0;
    const session: KeyValueStore = {
      ...backing,
      set: async (values) => {
        writes += 1;
        if (writes === 1) await held;
        await backing.set(values);
      },
    };
    // 멈춤 신호를 받으면 취소로 끝나는 일.
    const signals: AbortSignal[] = [];
    const stoppable = defineTaskPart(action, ({ signal }) => {
      signals.push(signal);
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          resolve(err(appError('cancelled', '탭이 닫혔다.')));
        });
      });
    });
    // Chrome처럼 듣는 동안만 탭 닫힘을 넘긴다. 듣지 않는 동안 닫힌 탭의 사건은 오지 않는다(결정 0024의 실험 6).
    const open = new Set([3]);
    let handlers: TabEventHandlers | undefined;
    let listening = true;
    const local = createFakeStore();
    const request = startTestBackground({
      store: local,
      features: [...specs, action],
      startTime: 1_790_000_000_000,
      session,
      taskParts: [stoppable],
      tabExists: (tabId) => Promise.resolve(open.has(tabId)),
      listenTabEvents: (next) => {
        handlers = next;
        return {
          listen: (on) => {
            listening = on;
          },
        };
      },
    });
    const closeTab = (tabId: number) => {
      open.delete(tabId);
      if (listening) handlers?.removed(tabId);
    };
    // 기록이 없어 탭 사건 듣기를 그만둔 서비스 워커에서 첫 작업을 시작한다.
    await vi.waitFor(() => {
      expect(listening).toBe(false);
    });
    const started = request(taskStart, { featureId: 'save', tabId: 3 });
    await vi.waitFor(() => {
      expect(writes).toBe(1);
    });
    closeTab(3);
    releaseWrite();
    expect(await started).toEqual(ok({ taskId: 'task-1' }));
    // 들은 닫힘은 시작 뒤에 줄을 서서 그 일에 멈춤 신호를 보내고 기록을 지운다.
    await vi.waitFor(() => {
      expect(signals[0]?.aborted).toBe(true);
    });
    await vi.waitFor(() => {
      expect(backing.peek(tasksKey)).toEqual({});
    });
    expect(listening).toBe(false);
    // 탭을 닫아 생긴 취소는 고장이 아니다.
    await settle();
    expect(recordedKinds(local)).toEqual([]);
  });

  it('기록이 없으면 시작한 뒤 탭 사건 듣기를 그만두고, 닫힌 탭의 기록은 지운다', async () => {
    const session = createFakeStore();
    const { handlers, listening } = startWith(session);
    await vi.waitFor(() => {
      expect(listening).toEqual([false]);
    });
    await session.set({
      [tasksKey]: { '3': { id: 'a', featureId: 'save', status: 'succeeded', summary: null } },
    });
    handlers.removed(3);
    await vi.waitFor(() => {
      expect(session.peek(tasksKey)).toEqual({});
    });
  });
});
