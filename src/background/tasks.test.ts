import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineFeature, v } from '../contracts/index.ts';
import { type FakeStore, createFakeStore } from '../platform/fake.ts';
import type { Delivery, TabBadge } from '../platform/index.ts';
import { type AppError, appError, err, ok } from '../shared/index.ts';
import {
  type TaskOutcome,
  type TaskRecord,
  type TaskRecords,
  parseTasks,
  taskOf,
  tasksKey,
} from '../storage/index.ts';
import type { Problem } from './problems.ts';
import { type TaskContext, type TaskPart, defineTaskPart } from './task-part.ts';
import { createTaskRunner } from './tasks.ts';

// 실행 기능의 작업 실행(COM-10, 결정 0012, 0024). 저장소는 가짜이고, 일의 끝은 시험이 정한다.

afterEach(() => {
  vi.useRealTimers();
});

const save = defineFeature({
  id: 'save',
  requirements: [],
  name: '자막 저장',
  description: '시험용',
  category: 'subtitles',
  kind: 'action',
  content: null,
  permissions: [],
  task: { timeoutMs: 10_000 },
});

const copy = defineFeature({ ...save, id: 'copy', name: 'URL 복사' });

const toggle = defineFeature({
  id: 'speed',
  requirements: [],
  name: '배속',
  description: '시험용',
  category: 'media',
  kind: 'toggle',
  content: null,
  permissions: [],
  settings: { schema: v.object({ enabled: v.boolean() }), defaults: { enabled: false } },
});

// 시험이 끝을 정하는 일. 부를 때마다 받은 것을 남기고, finish로 끝낸다.
function controlledPart(feature: typeof save) {
  const calls: { context: TaskContext; finish: (outcome: TaskOutcome) => void }[] = [];
  const part = defineTaskPart(
    feature,
    (context) =>
      new Promise<TaskOutcome>((resolve) => {
        calls.push({ context, finish: resolve });
      }),
  );
  const call = (index: number) => {
    const found = calls[index];
    if (found === undefined) throw new Error(`일이 ${String(index + 1)}번 불리지 않았다.`);
    return found;
  };
  return { part, calls, call };
}

// 배지와 탭 사건 듣기는 시험이 받아 둔다.
function setup(
  options: {
    readonly parts?: readonly TaskPart[];
    readonly tabExists?: (tabId: number) => Promise<boolean>;
    readonly session?: FakeStore;
    readonly badge?: (tabId: number, badge: TabBadge | null) => Promise<void>;
    readonly popupViewing?: (tabId: number) => boolean;
    readonly isTabActive?: (tabId: number) => Promise<boolean>;
    readonly notify?: (tabId: number, text: string) => Promise<Delivery>;
  } = {},
) {
  const saving = controlledPart(save);
  const copying = controlledPart(copy);
  const session = options.session ?? createFakeStore();
  const problems: Problem[] = [];
  const badges: [number, TabBadge | null][] = [];
  const listening: boolean[] = [];
  // 보낸 페이지 위 알림(탭, 글).
  const notices: [number, string][] = [];
  let ids = 0;
  const runner = createTaskRunner({
    session,
    features: [toggle, save, copy],
    parts: options.parts ?? [saving.part, copying.part],
    randomId: () => {
      ids += 1;
      return `t${String(ids)}`;
    },
    tabExists: options.tabExists ?? (() => Promise.resolve(true)),
    badge:
      options.badge ??
      ((tabId, badge) => {
        badges.push([tabId, badge]);
        return Promise.resolve();
      }),
    listenTabs: (on) => listening.push(on),
    popupViewing: options.popupViewing ?? (() => false),
    isTabActive: options.isTabActive ?? (() => Promise.resolve(true)),
    notify:
      options.notify ??
      ((tabId, text) => {
        notices.push([tabId, text]);
        return Promise.resolve('delivered');
      }),
    record: (problem) => problems.push(problem),
  });
  return {
    runner,
    session,
    problems,
    saving,
    copying,
    badges,
    listening,
    notices,
    records: () => session.peek(tasksKey),
  };
}

// 시험이 정한 때부터 읽기나 쓰기가 실패하는 작업 기록 저장소. 실패하는 동안에도 담긴 기록은 그대로다.
function breakableStore(initial: Readonly<Record<string, unknown>> = {}) {
  const store = createFakeStore(initial);
  const broken = { get: false, set: false };
  const session: FakeStore = {
    ...store,
    get: (key) => (broken.get ? Promise.reject(new Error('session')) : store.get(key)),
    set: (items) => (broken.set ? Promise.reject(new Error('quota')) : store.set(items)),
  };
  return { session, broken };
}

// 저장소의 어느 쪽이 실패하는지. 시험 이름에 앞의 말을 쓴다.
const storeFailures = [
  ['읽지', 'get'],
  ['쓰지', 'set'],
] as const;

// 끝났고 아직 보지 않은 작업 기록.
const unseen = { id: 'a', featureId: 'save', status: 'succeeded', summary: null } as const;

const unavailable = (message: string): AppError => appError('unavailable', message);

describe('작업 시작', () => {
  it('진행 중을 남기고 작업 id로 답한 뒤, 그 탭 id로 일을 시작한다', async () => {
    const { runner, saving, records } = setup();
    expect(await runner.start('save', 4)).toEqual(ok({ taskId: 't1' }));
    expect(records()).toEqual({ '4': { id: 't1', featureId: 'save', status: 'running' } });
    await vi.waitFor(() => {
      expect(saving.calls).toHaveLength(1);
    });
    expect(saving.call(0).context.tabId).toBe(4);
    expect(saving.call(0).context.signal.aborted).toBe(false);
  });

  it('실행 기능이 아니거나 모르는 기능이면 시작하지 않는다(invalid-input)', async () => {
    const { runner, records } = setup();
    for (const featureId of ['speed', 'nothing']) {
      const result = await runner.start(featureId, 4);
      expect(result.ok ? null : result.error.kind).toBe('invalid-input');
    }
    expect(records()).toBeUndefined();
  });

  it('탭이 없으면 시작하지 않는다(unavailable)', async () => {
    const { runner, records } = setup({ tabExists: () => Promise.resolve(false) });
    expect(await runner.start('save', 4)).toEqual(err(unavailable('작업을 시작할 탭이 없다.')));
    expect(records()).toBeUndefined();
  });

  it('COM-10.7 그 탭에서 작업이 진행 중이면 다른 작업도 같은 작업도 시작하지 않고 이유에 진행 중인 기능 이름을 담는다', async () => {
    const { runner, copying, records } = setup();
    await runner.start('save', 4);
    const reason = err(unavailable('이 탭에서 자막 저장 진행 중이다. 끝난 뒤 다시 한다.'));
    expect(await runner.start('copy', 4)).toEqual(reason);
    expect(await runner.start('save', 4)).toEqual(reason);
    expect(copying.calls).toHaveLength(0);
    expect(records()).toEqual({ '4': { id: 't1', featureId: 'save', status: 'running' } });
  });

  it('겹쳐 온 시작 요청도 하나만 시작한다(줄에서 차례로 판단)', async () => {
    const { runner, records } = setup();
    const results = await Promise.all([runner.start('save', 4), runner.start('copy', 4)]);
    expect(results.map((result) => result.ok)).toEqual([true, false]);
    expect(records()).toEqual({ '4': { id: 't1', featureId: 'save', status: 'running' } });
  });

  it('다른 탭에서는 따로 시작한다', async () => {
    const { runner, records } = setup();
    await runner.start('save', 4);
    expect(await runner.start('copy', 5)).toEqual(ok({ taskId: 't2' }));
    expect(records()).toEqual({
      '4': { id: 't1', featureId: 'save', status: 'running' },
      '5': { id: 't2', featureId: 'copy', status: 'running' },
    });
  });

  it('탭이 열려 있는지 묻지 못하면 시작하지 않고 platform으로 답한다(이유는 팝업이 보인다)', async () => {
    const { runner, saving, records, problems, listening } = setup({
      tabExists: () => Promise.reject(new Error('tabs')),
    });
    const result = await runner.start('save', 4);
    expect(result.ok ? null : result.error.kind).toBe('platform');
    expect(records()).toBeUndefined();
    expect(saving.calls).toHaveLength(0);
    expect(problems).toEqual([]);
    // 시작하지 않았으므로 읽은 기록(없음)에 맞춰 듣기를 되돌린다.
    expect(listening).toEqual([true, false]);
  });

  it('기록을 남기지 못하면 시작하지 않고 platform으로 답한다', async () => {
    const fake = createFakeStore();
    const session = { ...fake, set: () => Promise.reject(new Error('quota')) };
    const saving = controlledPart(save);
    const runner = createTaskRunner({
      session,
      features: [save],
      parts: [saving.part],
      randomId: () => 't1',
      tabExists: () => Promise.resolve(true),
      badge: () => Promise.resolve(),
      listenTabs: () => undefined,
      popupViewing: () => false,
      isTabActive: () => Promise.resolve(true),
      notify: () => Promise.resolve('delivered' as const),
      record: () => undefined,
    });
    const result = await runner.start('save', 4);
    expect(result.ok ? null : result.error.kind).toBe('platform');
    expect(saving.calls).toHaveLength(0);
  });

  it('읽은 기록의 모양이 틀리면 unexpected로 기록하고 빈 기록에서 다시 시작한다', async () => {
    const session = createFakeStore({ [tasksKey]: { '9': { status: 'odd' } } });
    const { runner, problems, records } = setup({ session });
    expect(await runner.start('save', 4)).toEqual(ok({ taskId: 't1' }));
    expect(records()).toEqual({ '4': { id: 't1', featureId: 'save', status: 'running' } });
    expect(problems).toEqual([{ featureId: null, kind: 'unexpected' }]);
  });
});

describe('작업 끝남', () => {
  it('성공하면 짧은 결과를 남기고 문제로 기록하지 않는다', async () => {
    const { runner, saving, records, problems } = setup();
    await runner.start('save', 4);
    await vi.waitFor(() => {
      expect(saving.calls).toHaveLength(1);
    });
    saving.call(0).finish(ok({ summary: '영상.txt' }));
    await vi.waitFor(() => {
      expect(records()).toEqual({
        '4': { id: 't1', featureId: 'save', status: 'succeeded', summary: '영상.txt' },
      });
    });
    expect(problems).toEqual([]);
  });

  it.each([
    ['unavailable', false],
    ['invalid-input', false],
    ['cancelled', false],
    ['not-found', true],
    ['platform', true],
    ['permission', true],
  ] as const)(
    '실패(%s)를 남기고, 상황을 알리는 종류가 아니면 그 기능으로 문제 기록에 남긴다(%s)',
    async (kind, recorded) => {
      const { runner, saving, records, problems } = setup();
      await runner.start('save', 4);
      await vi.waitFor(() => {
        expect(saving.calls).toHaveLength(1);
      });
      const error = appError(kind, '이유');
      saving.call(0).finish(err(error));
      await vi.waitFor(() => {
        expect(records()).toEqual({
          '4': { id: 't1', featureId: 'save', status: 'failed', error },
        });
      });
      expect(problems).toEqual(recorded ? [{ featureId: 'save', kind }] : []);
    },
  );

  it('일이 던지면 unexpected로 끝내고 기록한다', async () => {
    const throwing = defineTaskPart(save, () => Promise.reject(new Error('boom')));
    const { runner, records, problems } = setup({ parts: [throwing, controlledPart(copy).part] });
    await runner.start('save', 4);
    await vi.waitFor(() => {
      expect(records()).toEqual({
        '4': {
          id: 't1',
          featureId: 'save',
          status: 'failed',
          error: appError('unexpected', '작업 중에 예상하지 못한 오류가 났다.'),
        },
      });
    });
    expect(problems).toEqual([{ featureId: 'save', kind: 'unexpected' }]);
  });

  it('제한 시간을 넘기면 일에 멈춤 신호를 보내고 timeout으로 끝내며, 늦게 온 결과는 버린다', async () => {
    vi.useFakeTimers();
    const { runner, saving, records, problems } = setup();
    await runner.start('save', 4);
    await vi.waitFor(() => {
      expect(saving.calls).toHaveLength(1);
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const timedOut = {
      '4': {
        id: 't1',
        featureId: 'save',
        status: 'failed',
        error: appError('timeout', '10초 안에 끝나지 않아 멈췄다.'),
      },
    };
    await vi.waitFor(() => {
      expect(records()).toEqual(timedOut);
    });
    expect(saving.call(0).context.signal.aborted).toBe(true);
    expect(problems).toEqual([{ featureId: 'save', kind: 'timeout' }]);
    saving.call(0).finish(ok({ summary: '늦음.txt' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(records()).toEqual(timedOut);
  });

  it.each(storeFailures)(
    '끝을 쓸 때 기록을 %s 못하면 그 기능으로 platform을 기록하고 진행 중으로 남긴다(다음 서비스 워커 시작이 고친다)',
    async (_, operation) => {
      const { session, broken } = breakableStore();
      const { runner, saving, records, problems } = setup({ session });
      await runner.start('save', 4);
      broken[operation] = true;
      await finishLast(saving, ok({ summary: null }));
      await vi.waitFor(() => {
        expect(problems).toEqual([{ featureId: 'save', kind: 'platform' }]);
      });
      expect(records()).toEqual({ '4': { id: 't1', featureId: 'save', status: 'running' } });
    },
  );

  it('끝을 쓰고 알리는 동안 예상하지 못한 예외가 나도 그 기능으로 unexpected를 기록한다', async () => {
    // 알림 경계는 거절하지 않고 결과로 답하기로 되어 있다. 그 약속이 깨진 경우를 흉내 낸다.
    const { runner, saving, problems } = setup({
      notify: () => Promise.reject(new Error('boom')),
    });
    await runner.start('save', 4);
    await finishLast(saving, ok({ summary: null }));
    await vi.waitFor(() => {
      expect(problems).toEqual([{ featureId: 'save', kind: 'unexpected' }]);
    });
  });

  it('그 탭의 기록이 바뀐 뒤(예: 지워짐)에 온 결과는 버리고 문제로 기록하지 않는다', async () => {
    const { runner, saving, session, records, problems } = setup();
    await runner.start('save', 4);
    await vi.waitFor(() => {
      expect(saving.calls).toHaveLength(1);
    });
    session.replace(tasksKey, {});
    saving.call(0).finish(err(appError('platform', '탭이 닫혔다.')));
    // 줄이 빌 때까지 기다린다: 같은 줄에 선 다음 시작이 끝나면 앞의 끝도 처리되었다.
    await runner.start('copy', 5);
    expect(records()).toEqual({ '5': { id: 't2', featureId: 'copy', status: 'running' } });
    expect(problems).toEqual([]);
  });

  it('끝난 뒤에는 그 탭에서 새 작업을 시작하고 이전 결과는 새 작업으로 바뀐다', async () => {
    const { runner, saving, copying, records } = setup();
    await runner.start('save', 4);
    await vi.waitFor(() => {
      expect(saving.calls).toHaveLength(1);
    });
    saving.call(0).finish(ok({ summary: null }));
    await vi.waitFor(() => {
      expect(records()).toMatchObject({ '4': { status: 'succeeded' } });
    });
    expect(await runner.start('copy', 4)).toEqual(ok({ taskId: 't2' }));
    expect(records()).toEqual({ '4': { id: 't2', featureId: 'copy', status: 'running' } });
    await vi.waitFor(() => {
      expect(copying.calls).toHaveLength(1);
    });
  });
});

describe('결과 확인(task.seen, 결정 0012)', () => {
  async function finished() {
    const context = setup();
    await context.runner.start('save', 4);
    await vi.waitFor(() => {
      expect(context.saving.calls).toHaveLength(1);
    });
    context.saving.call(0).finish(ok({ summary: null }));
    await vi.waitFor(() => {
      expect(context.records()).toMatchObject({ '4': { status: 'succeeded' } });
    });
    return context;
  }

  it('같은 작업의 끝난 결과면 그 탭의 배지를 한 번 지우고 기록을 지운다', async () => {
    const { runner, records, badges } = await finished();
    const before = badges.length;
    expect(await runner.seen(4, 't1')).toEqual(ok(null));
    expect(records()).toEqual({});
    expect(badges.slice(before)).toEqual([[4, null]]);
  });

  it('COM-10.8 다음 작업이 시작된 뒤 늦게 닿은 확인은 그 작업을 지우지 않는다', async () => {
    const { runner, records } = await finished();
    await runner.start('copy', 4);
    expect(await runner.seen(4, 't1')).toEqual(ok(null));
    expect(records()).toEqual({ '4': { id: 't2', featureId: 'copy', status: 'running' } });
  });

  it('진행 중인 작업의 확인은 아무것도 하지 않는다', async () => {
    const { runner, records } = setup();
    await runner.start('save', 4);
    expect(await runner.seen(4, 't1')).toEqual(ok(null));
    expect(records()).toEqual({ '4': { id: 't1', featureId: 'save', status: 'running' } });
  });

  it.each(storeFailures)(
    '기록을 %s 못하면 platform으로 답하고 기록한다. 팝업은 이 실패를 보이지 않는다',
    async (_, operation) => {
      const { session, broken } = breakableStore({ [tasksKey]: { '4': unseen } });
      const { runner, records, problems } = setup({ session });
      broken[operation] = true;
      const result = await runner.seen(4, 'a');
      expect(result.ok ? null : result.error.kind).toBe('platform');
      expect(problems).toEqual([{ featureId: null, kind: 'platform' }]);
      // 지우지 못한 결과는 팝업을 다음에 열 때 다시 보인다.
      expect(records()).toEqual({ '4': unseen });
    },
  );

  it('배지를 지우지 못하면 기록도 지우지 않고 platform으로 답하고 기록한다. 기록이 없는 탭에 배지만 남지 않는다(결정 0038)', async () => {
    const session = createFakeStore({ [tasksKey]: { '4': unseen } });
    const writes = vi.spyOn(session, 'set');
    const { runner, records, problems } = setup({
      session,
      badge: () => Promise.reject(new Error('action')),
    });
    const result = await runner.seen(4, 'a');
    expect(result.ok ? null : result.error.kind).toBe('platform');
    expect(writes).not.toHaveBeenCalled();
    expect(records()).toEqual({ '4': unseen });
    expect(problems).toEqual([{ featureId: null, kind: 'platform' }]);
  });
});

describe('실행 기능과 일의 짝(quality 066)', () => {
  const start = (parts: readonly TaskPart[]) => () =>
    createTaskRunner({
      session: createFakeStore(),
      features: [toggle, save],
      parts,
      randomId: () => 't',
      tabExists: () => Promise.resolve(true),
      badge: () => Promise.resolve(),
      listenTabs: () => undefined,
      popupViewing: () => false,
      isTabActive: () => Promise.resolve(true),
      notify: () => Promise.resolve('delivered' as const),
      record: () => undefined,
    });

  it('실행 기능의 일이 없거나 둘이면 시작할 때 던진다', () => {
    expect(start([])).toThrow('실행 기능 save의 일이 0개다.');
    const part = controlledPart(save).part;
    expect(start([part, part])).toThrow('실행 기능 save의 일이 2개다.');
  });

  it('일에 맞는 실행 기능이 없으면(켜고 끄기 기능 포함) 시작할 때 던진다', () => {
    const part = controlledPart(save).part;
    expect(start([part, { ...part, featureId: 'speed' }])).toThrow(
      '작업의 일 speed에 맞는 실행 기능이 없다.',
    );
  });
});

// 시험의 일이 불릴 때까지 기다린 뒤 마지막으로 불린 것의 끝을 정한다.
async function finishLast(part: ReturnType<typeof controlledPart>, outcome: TaskOutcome) {
  await vi.waitFor(() => {
    expect(part.calls.length).toBeGreaterThan(0);
  });
  part.call(part.calls.length - 1).finish(outcome);
}

const succeededBadge: TabBadge = {
  text: '✓',
  color: '#1a7f37',
  title: 'Browser Toolbox: 자막 저장 끝남',
};
const failedBadge: TabBadge = {
  text: '!',
  color: '#c62828',
  title: 'Browser Toolbox: 자막 저장 실패',
};

describe('배지와 제목은 기록에서 계산한다(결정 0012, 0024)', () => {
  it('시작하면 그 탭의 배지를 지우고, 끝나면 성공·실패를 달며, 보면 다시 지운다', async () => {
    const { runner, saving, badges } = setup();
    await runner.start('save', 4);
    expect(badges).toEqual([[4, null]]);
    await finishLast(saving, ok({ summary: null }));
    await vi.waitFor(() => {
      expect(badges).toEqual([
        [4, null],
        [4, succeededBadge],
      ]);
    });
    await runner.seen(4, 't1');
    expect(badges.at(-1)).toEqual([4, null]);

    await runner.start('save', 4);
    await finishLast(saving, err(appError('unavailable', '자막이 없다.')));
    await vi.waitFor(() => {
      expect(badges.at(-1)).toEqual([4, failedBadge]);
    });
  });

  it('탭이 다른 문서로 이동하면 끝났고 보지 않은 결과의 배지를 다시 단다. 진행 중이거나 기록이 없으면 달지 않는다', async () => {
    const { runner, saving, badges } = setup();
    await runner.tabNavigated(4);
    await runner.start('save', 4);
    await runner.tabNavigated(4);
    expect(badges).toEqual([[4, null]]);
    await finishLast(saving, ok({ summary: null }));
    await vi.waitFor(() => {
      expect(badges).toHaveLength(2);
    });
    await runner.tabNavigated(4);
    await runner.tabNavigated(5);
    expect(badges).toEqual([
      [4, null],
      [4, succeededBadge],
      [4, succeededBadge],
    ]);
  });

  it('탭이 이동할 때 기록을 읽지 못하면 배지를 다시 달지 못한 까닭을 platform으로 기록한다', async () => {
    const { session, broken } = breakableStore({ [tasksKey]: { '4': unseen } });
    const { runner, badges, problems } = setup({ session });
    broken.get = true;
    await runner.tabNavigated(4);
    expect(badges).toEqual([]);
    expect(problems).toEqual([{ featureId: null, kind: 'platform' }]);
  });

  it('배지를 달지 못하면 기록은 그대로 쓰고 platform으로 기록한다', async () => {
    const { runner, saving, records, problems } = setup({
      badge: () => Promise.reject(new Error('action')),
    });
    await runner.start('save', 4);
    await finishLast(saving, ok({ summary: null }));
    await vi.waitFor(() => {
      expect(records()).toMatchObject({ '4': { status: 'succeeded' } });
    });
    await vi.waitFor(() => {
      // 시작(배지 지우기)과 끝(배지 달기) 모두 그 작업의 기능으로 남는다.
      expect(problems).toEqual([
        { featureId: 'save', kind: 'platform' },
        { featureId: 'save', kind: 'platform' },
      ]);
    });
  });
});

describe('탭 사건은 기록이 있는 동안만 듣는다(결정 0024)', () => {
  it('기록을 쓸 때마다 기록이 있는지에 따라 듣거나 그만둔다', async () => {
    const { runner, saving, listening } = setup();
    await runner.start('save', 4);
    // 시작은 탭이 있는지 보기 전에 듣기 시작하고, 진행 중을 쓴 뒤에도 듣는다.
    expect(listening).toEqual([true, true]);
    await finishLast(saving, ok({ summary: null }));
    await vi.waitFor(() => {
      expect(listening).toEqual([true, true, true]);
    });
    await runner.seen(4, 't1');
    expect(listening).toEqual([true, true, true, false]);
  });

  it('시작은 탭이 있는지 보기 전부터 듣고, 시작하지 않으면 읽은 기록에 맞춰 되돌린다', async () => {
    // 탭을 볼 때 이미 듣고 있다. 그래야 탭을 본 뒤에 닫혀도 놓치지 않는다(COM-10.6).
    let listeningWhenChecked: readonly boolean[] = [];
    const missing = setup({
      tabExists: () => {
        listeningWhenChecked = [...missing.listening];
        return Promise.resolve(false);
      },
    });
    await missing.runner.start('save', 4);
    expect(listeningWhenChecked).toEqual([true]);
    expect(missing.listening).toEqual([true, false]);

    // 진행 중인 작업이 있어 시작하지 않으면 기록이 있으므로 계속 듣는다.
    const busy = setup();
    await busy.runner.start('save', 4);
    await busy.runner.start('copy', 4);
    expect(busy.listening).toEqual([true, true, true, true]);

    // 기록을 쓰지 못하면 쓰기 전의 기록(없음)에 맞춰 그만둔다.
    const fake = createFakeStore();
    const unwritable = setup({
      session: { ...fake, set: () => Promise.reject(new Error('quota')) },
    });
    expect((await unwritable.runner.start('save', 4)).ok).toBe(false);
    expect(unwritable.listening).toEqual([true, false]);
  });
});

describe('COM-10.6 탭이 닫힘', () => {
  it('그 탭의 기록을 지우고 진행 중이던 일에 멈춤 신호를 보낸다. 늦게 온 결과는 버리고 문제로 기록하지 않는다', async () => {
    const { runner, saving, records, problems, badges, listening } = setup();
    await runner.start('save', 4);
    await runner.start('copy', 5);
    await vi.waitFor(() => {
      expect(saving.calls).toHaveLength(1);
    });
    await runner.tabRemoved(4);
    expect(saving.call(0).context.signal.aborted).toBe(true);
    expect(records()).toEqual({ '5': { id: 't2', featureId: 'copy', status: 'running' } });
    saving.call(0).finish(err(appError('platform', '탭이 없다.')));
    // 줄이 빌 때까지 기다린다: 같은 줄에 선 다음 일이 끝나면 앞의 끝도 처리되었다.
    await runner.tabRemoved(9);
    expect(records()).toEqual({ '5': { id: 't2', featureId: 'copy', status: 'running' } });
    expect(problems).toEqual([]);
    // 닫힌 탭에는 배지를 달지 않는다. 기록이 남아 있으므로 계속 듣는다.
    expect(badges).toEqual([
      [4, null],
      [5, null],
    ]);
    expect(listening.at(-1)).toBe(true);
  });

  it('끝난 결과만 있던 탭이 닫혀도 지우고, 기록이 없어지면 듣기를 그만둔다', async () => {
    const { runner, saving, records, listening } = setup();
    await runner.start('save', 4);
    await finishLast(saving, ok({ summary: null }));
    await vi.waitFor(() => {
      expect(records()).toMatchObject({ '4': { status: 'succeeded' } });
    });
    await runner.tabRemoved(4);
    expect(records()).toEqual({});
    expect(listening.at(-1)).toBe(false);
  });

  it('기록이 없는 탭이 닫히면 아무것도 쓰지 않는다', async () => {
    const session = createFakeStore();
    const writes = vi.spyOn(session, 'set');
    const { runner } = setup({ session });
    await runner.tabRemoved(4);
    expect(writes).not.toHaveBeenCalled();
  });

  it.each(storeFailures)(
    '기록을 %s 못하면 platform으로 기록한다(남은 기록은 다음 서비스 워커 시작이 지운다)',
    async (_, operation) => {
      const { session, broken } = breakableStore({ [tasksKey]: { '4': unseen } });
      const { runner, problems } = setup({ session });
      broken[operation] = true;
      await runner.tabRemoved(4);
      expect(problems).toEqual([{ featureId: null, kind: 'platform' }]);
    },
  );
});

describe('서비스 워커가 다시 시작함(결정 0024)', () => {
  const interrupted = appError(
    'unexpected',
    '확장이 작업 도중 다시 시작되어 끝까지 하지 못했다. 다시 실행한다.',
  );

  it('앞 서비스 워커의 진행 중 작업은 끝내고 실패 배지를 달며 기록한다. 닫힌 탭의 기록은 지우고 끝난 결과는 그대로 두며 그 배지를 다시 단다', async () => {
    const done = { id: 'b', featureId: 'copy', status: 'succeeded', summary: null } as const;
    const session = createFakeStore({
      [tasksKey]: {
        '4': { id: 'a', featureId: 'save', status: 'running' },
        '5': done,
        '6': { id: 'c', featureId: 'save', status: 'running' },
      },
    });
    const { runner, records, problems, badges, listening } = setup({
      session,
      tabExists: (tabId) => Promise.resolve(tabId !== 6),
    });
    await runner.recover();
    expect(records()).toEqual({
      '4': { id: 'a', featureId: 'save', status: 'failed', error: interrupted },
      '5': done,
    });
    expect(problems).toEqual([{ featureId: 'save', kind: 'unexpected' }]);
    expect(badges).toEqual([
      [4, failedBadge],
      [5, { ...succeededBadge, title: 'Browser Toolbox: URL 복사 끝남' }],
    ]);
    expect(listening).toEqual([true]);
    // 끝낸 작업이 있던 탭에서 다시 시작할 수 있다.
    expect((await runner.start('copy', 4)).ok).toBe(true);
  });

  it('고칠 것이 없으면 쓰지 않고, 기록이 없으면 배지를 건드리지 않고 탭 사건 듣기를 그만둔다', async () => {
    const session = createFakeStore();
    const writes = vi.spyOn(session, 'set');
    const { runner, listening, badges } = setup({ session });
    await runner.recover();
    expect(writes).not.toHaveBeenCalled();
    expect(badges).toEqual([]);
    expect(listening).toEqual([false]);
  });

  it('끝난 결과만 있으면 쓰지 않고 듣기를 이어 가며, 앞 서비스 워커가 배지를 바꾸기 전에 멈췄을 수 있어 그 배지를 다시 단다(결정 0038)', async () => {
    const session = createFakeStore({
      [tasksKey]: { '4': { id: 'a', featureId: 'save', status: 'succeeded', summary: null } },
    });
    const writes = vi.spyOn(session, 'set');
    const { runner, listening, badges } = setup({ session });
    await runner.recover();
    expect(writes).not.toHaveBeenCalled();
    expect(listening).toEqual([true]);
    expect(badges).toEqual([[4, succeededBadge]]);
  });

  it('COM-10.6 진행 중인 작업이 없어도 닫힌 탭의 기록은 지워 쓰고, 열린 탭의 배지는 다시 단다(닫힘을 놓친 경우)', async () => {
    const session = createFakeStore({ [tasksKey]: { '4': unseen, '6': unseen } });
    const { runner, records, badges, listening } = setup({
      session,
      tabExists: (tabId) => Promise.resolve(tabId !== 6),
    });
    await runner.recover();
    expect(records()).toEqual({ '4': unseen });
    expect(badges).toEqual([[4, succeededBadge]]);
    expect(listening).toEqual([true]);
  });

  it('기록을 읽지 못하면 platform으로 기록하고 듣기를 그대로 둔다', async () => {
    const failing = { ...createFakeStore(), get: () => Promise.reject(new Error('session')) };
    const { runner, problems, listening } = setup({ session: failing });
    await runner.recover();
    expect(problems).toEqual([{ featureId: null, kind: 'platform' }]);
    expect(listening).toEqual([]);
  });

  it('탭이 열려 있는지 묻지 못하면 platform으로 기록하고 고치지 않으며 듣기를 그대로 둔다', async () => {
    const running = { id: 'a', featureId: 'save', status: 'running' } as const;
    const session = createFakeStore({ [tasksKey]: { '4': running } });
    const writes = vi.spyOn(session, 'set');
    const { runner, problems, listening, badges } = setup({
      session,
      tabExists: () => Promise.reject(new Error('tabs')),
    });
    await runner.recover();
    expect(problems).toEqual([{ featureId: null, kind: 'platform' }]);
    expect(writes).not.toHaveBeenCalled();
    expect(badges).toEqual([]);
    expect(listening).toEqual([]);
  });

  it('고친 기록을 쓰지 못하면 platform으로 기록하고, 끝내지 못한 작업은 다음 시작에 고칠 때 기록한다', async () => {
    const running = { id: 'a', featureId: 'save', status: 'running' } as const;
    const { session, broken } = breakableStore({ [tasksKey]: { '4': running } });
    const { runner, records, problems } = setup({ session });
    broken.set = true;
    await runner.recover();
    expect(problems).toEqual([{ featureId: null, kind: 'platform' }]);
    expect(records()).toEqual({ '4': running });
  });
});

describe('이슈 #7 서비스 워커가 작업 기록과 배지 사이에서 멈춰도 다시 시작한 뒤 배지는 기록과 같다', () => {
  // Chrome에 남는 것은 작업 기록(storage.session)과 탭마다 보이는 배지 글자·아이콘 제목이다. 서비스 워커가 바뀌어도 남는다.
  // 배지 하나는 실제 setTabBadge처럼 글자를 바꾼 뒤 제목을 바꾸는 두 호출이다.
  interface Shown {
    readonly text: string;
    readonly title: string;
  }
  const blank: Shown = { text: '', title: 'Browser Toolbox' };
  const names: Readonly<Record<string, string>> = { save: '자막 저장', copy: 'URL 복사' };
  // 그 기록이면 보여야 하는 배지. 끝났고 보지 않은 결과만 배지가 있다(결정 0012, 0024).
  const expectedOf = (task: TaskRecord | null): Shown => {
    if (task === null || task.status === 'running') return blank;
    const name = names[task.featureId] ?? task.featureId;
    return task.status === 'succeeded'
      ? { text: '✓', title: `Browser Toolbox: ${name} 끝남` }
      : { text: '!', title: `Browser Toolbox: ${name} 실패` };
  };

  // 탭 4에서 일이 일어난다. 탭 5에는 다른 기능의 보지 않은 결과와 그 배지가 있어 탭 4의 일이 그것을 흐트러뜨리지 않는지도
  // 본다. 탭 6은 닫혔다.
  const openTabs = [4, 5] as const;
  const closedTab = 6;
  const other: TaskRecord = { id: 'b', featureId: 'copy', status: 'succeeded', summary: null };
  const running: TaskRecord = { id: 'a', featureId: 'save', status: 'running' };

  // 서비스 워커를 Chrome API 호출의 차례(0부터)의 앞이나 뒤에서 멈춘다. 뒤에서 멈추면 그 호출은 Chrome에 닿았다.
  interface StopPoint {
    readonly call: number;
    readonly when: 'before' | 'after';
  }

  function chromeWith(records: TaskRecords, badges: readonly (readonly [number, Shown])[]) {
    const session = createFakeStore({ [tasksKey]: records });
    const shown = new Map<number, Shown>(badges);
    // 서비스 워커 하나. 멈춘 뒤로는 어떤 Chrome API 호출도 끝나지 않아, 그 줄의 일도 더 돌지 않는다.
    const worker = (stop: StopPoint | null) => {
      let calls = 0;
      let stopped = false;
      const halted = Promise.withResolvers<'stopped'>();
      const never = new Promise<never>(() => undefined);
      const call = async <T>(effect: () => T | Promise<T>): Promise<T> => {
        if (stopped) return never;
        const index = calls;
        calls += 1;
        const stopsAt = (when: StopPoint['when']) => {
          if (stop?.call !== index || stop.when !== when) return false;
          stopped = true;
          halted.resolve('stopped');
          return true;
        };
        if (stopsAt('before')) return never;
        const value = await effect();
        if (stopsAt('after')) return never;
        return value;
      };
      const paint = (tabId: number, change: Partial<Shown>) =>
        call(() => {
          shown.set(tabId, { ...(shown.get(tabId) ?? blank), ...change });
        });
      const saving = controlledPart(save);
      let ids = 0;
      const runner = createTaskRunner({
        session: {
          ...session,
          get: (key) => call(() => session.get(key)),
          set: (items) => call(() => session.set(items)),
        },
        features: [toggle, save, copy],
        parts: [saving.part, controlledPart(copy).part],
        randomId: () => {
          ids += 1;
          return `n${String(ids)}`;
        },
        tabExists: (tabId) => call(() => tabId !== closedTab),
        badge: async (tabId, badge) => {
          await paint(tabId, { text: badge?.text ?? blank.text });
          await paint(tabId, { title: badge?.title ?? blank.title });
        },
        listenTabs: () => undefined,
        // 그 탭을 보는 팝업이 있어 페이지 위 알림은 보내지 않는다(이 시험이 보는 것이 아니다).
        popupViewing: () => true,
        isTabActive: () => Promise.resolve(true),
        notify: () => Promise.resolve('delivered'),
        record: () => undefined,
      });
      return { runner, saving, halted: halted.promise, calls: () => calls };
    };
    return { session, shown, worker };
  }

  type Worker = ReturnType<ReturnType<typeof chromeWith>['worker']>;

  // 가짜의 호출은 모두 곧 끝나므로, 한 번 쉬면 일이 끝을 쓰고 배지를 다는 데까지 간다.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  // 멈춰 볼 일. 처음 기록과 배지에서 시작해 서비스 워커 하나가 한다.
  const scenarios: readonly {
    readonly name: string;
    readonly records: TaskRecords;
    readonly badges: readonly (readonly [number, Shown])[];
    readonly run: (worker: Worker) => Promise<unknown>;
  }[] = [
    {
      name: '작업이 끝나 끝난 기록을 쓰고 배지를 닮',
      records: { '5': other },
      badges: [[5, expectedOf(other)]],
      run: async ({ runner, saving }) => {
        await runner.start('save', 4);
        saving.call(0).finish(ok({ summary: null }));
        await settle();
      },
    },
    {
      name: '팝업이 결과를 보여 기록과 배지를 지움',
      records: { '4': unseen, '5': other },
      badges: [
        [4, expectedOf(unseen)],
        [5, expectedOf(other)],
      ],
      run: ({ runner }) => runner.seen(4, 'a'),
    },
    {
      name: '보지 않은 결과가 있는 탭에서 새 작업을 시작함',
      records: { '4': unseen, '5': other },
      badges: [
        [4, expectedOf(unseen)],
        [5, expectedOf(other)],
      ],
      run: ({ runner }) => runner.start('copy', 4),
    },
    {
      name: '탭이 다른 문서로 이동해 Chrome이 지운 배지를 다시 닮',
      records: { '4': unseen, '5': other },
      badges: [[5, expectedOf(other)]],
      run: ({ runner }) => runner.tabNavigated(4),
    },
    {
      name: '다시 시작한 서비스 워커가 진행 중이던 작업을 끝내고 닫힌 탭의 기록을 지움',
      records: { '4': running, '5': other, [String(closedTab)]: unseen },
      badges: [[5, expectedOf(other)]],
      run: ({ runner }) => runner.recover(),
    },
  ];

  // 서비스 워커가 그 일을 하다 멈추면(stop이 null이면 끝까지 한다) 새 서비스 워커가 시작해 복구한다(startBackground가
  // 시작할 때 하는 일).
  async function stopAndRestart(scenario: (typeof scenarios)[number], stop: StopPoint | null) {
    const chrome = chromeWith(scenario.records, scenario.badges);
    const first = chrome.worker(stop);
    await Promise.race([scenario.run(first), first.halted]);
    const second = chrome.worker(null);
    await second.runner.recover();
    return { chrome, first, second };
  }

  it.each(scenarios)(
    '$name: 어느 Chrome API 호출의 앞이나 뒤에서 멈춰도 배지가 기록과 같고, 남은 결과를 보면 기록과 배지가 함께 지워진다',
    async (scenario) => {
      const total = (await stopAndRestart(scenario, null)).first.calls();
      expect(total).toBeGreaterThan(1);
      for (let call = 0; call < total; call += 1) {
        for (const when of ['before', 'after'] as const) {
          const at = `호출 ${String(call)}의 ${when === 'before' ? '앞' : '뒤'}에서 멈춤`;
          const { chrome, second } = await stopAndRestart(scenario, { call, when });
          const records = parseTasks(chrome.session.peek(tasksKey)) ?? {};
          for (const tabId of openTabs) {
            expect(chrome.shown.get(tabId) ?? blank, `${at}, 탭 ${String(tabId)}`).toEqual(
              expectedOf(taskOf(records, tabId)),
            );
          }
          // 남은 결과는 팝업이 보인 뒤 확인을 보낸다. 그러면 기록과 배지가 함께 지워진다(COM-10.4).
          for (const tabId of openTabs) {
            const task = taskOf(records, tabId);
            if (task !== null) await second.runner.seen(tabId, task.id);
          }
          expect(chrome.session.peek(tasksKey), `${at}, 확인 뒤`).toEqual({});
          for (const tabId of openTabs) {
            expect(chrome.shown.get(tabId) ?? blank, `${at}, 확인 뒤 탭 ${String(tabId)}`).toEqual(
              blank,
            );
          }
        }
      }
    },
  );
});

describe('COM-10 기대 동작 4 페이지 위 알림(결정 0024)', () => {
  it('그 탭을 보는 팝업이 없고 창의 지금 탭이면 끝난 결과를 그 탭에 보낸다', async () => {
    const { runner, saving, notices } = setup();
    await runner.start('save', 4);
    await finishLast(saving, ok({ summary: '영상.txt' }));
    await vi.waitFor(() => {
      expect(notices).toEqual([[4, '자막 저장: 끝났다. 영상.txt']]);
    });
  });

  it.each([
    [
      appError('unavailable', '자막이 없는 영상이다.'),
      '자막 저장: 실패했다. 자막이 없는 영상이다.',
    ],
    [
      appError('cancelled', '다른 영상으로 이동했다.'),
      '자막 저장: 취소했다. 다른 영상으로 이동했다.',
    ],
  ])('실패(%o)는 그 이유를 담는다', async (error, text) => {
    const { runner, saving, notices } = setup();
    await runner.start('save', 4);
    await finishLast(saving, err(error));
    await vi.waitFor(() => {
      expect(notices).toEqual([[4, text]]);
    });
  });

  it('그 탭을 보는 팝업이 열려 있거나 그 탭이 창의 지금 탭이 아니면 보내지 않는다(팝업과 배지가 알린다)', async () => {
    for (const options of [
      { popupViewing: (tabId: number) => tabId === 4 },
      { isTabActive: () => Promise.resolve(false) },
    ]) {
      const { runner, saving, notices, records } = setup(options);
      await runner.start('save', 4);
      await finishLast(saving, ok({ summary: null }));
      await vi.waitFor(() => {
        expect(records()).toMatchObject({ '4': { status: 'succeeded' } });
      });
      await runner.start('copy', 5);
      expect(notices).toEqual([]);
    }
  });

  it('그 탭이 창의 지금 탭인지 묻지 못하면 그 기능으로 platform을 기록하고 보내지 않는다(배지가 알린다)', async () => {
    const { runner, saving, notices, problems, badges } = setup({
      isTabActive: () => Promise.reject(new Error('tabs')),
    });
    await runner.start('save', 4);
    await finishLast(saving, ok({ summary: null }));
    await vi.waitFor(() => {
      expect(problems).toEqual([{ featureId: 'save', kind: 'platform' }]);
    });
    expect(notices).toEqual([]);
    expect(badges.at(-1)).toEqual([4, succeededBadge]);
  });

  it('끝을 쓰지 않은 결과(탭이 닫힘)는 보내지 않는다', async () => {
    const { runner, saving, notices } = setup();
    await runner.start('save', 4);
    await vi.waitFor(() => {
      expect(saving.calls).toHaveLength(1);
    });
    await runner.tabRemoved(4);
    saving.call(0).finish(ok({ summary: null }));
    await runner.start('copy', 5);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(notices).toEqual([]);
  });

  it.each([
    ['delivered', []],
    ['unreachable', []],
    ['timeout', [{ featureId: 'save', kind: 'timeout' }]],
    ['failed', [{ featureId: 'save', kind: 'platform' }]],
  ] as const)(
    '보낸 결과가 %s이면 그에 맞게 기록한다(받는 쪽이 없는 탭은 배지만 쓰는 경우라 기록하지 않는다)',
    async (delivery, recorded) => {
      const sent: string[] = [];
      const { runner, saving, problems } = setup({
        notify: (_tabId, text) => {
          sent.push(text);
          return Promise.resolve(delivery);
        },
      });
      await runner.start('save', 4);
      await finishLast(saving, ok({ summary: null }));
      await vi.waitFor(() => {
        expect(sent).toHaveLength(1);
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(problems).toEqual(recorded);
    },
  );

  it('알림이 늦게 답해도 다른 탭의 시작과 확인은 기다리지 않는다(줄 밖에서 보낸다)', async () => {
    const { runner, saving, records } = setup({ notify: () => new Promise(() => undefined) });
    await runner.start('save', 4);
    await finishLast(saving, ok({ summary: null }));
    await vi.waitFor(() => {
      expect(records()).toMatchObject({ '4': { status: 'succeeded' } });
    });
    expect(await runner.start('copy', 5)).toEqual(ok({ taskId: 't2' }));
    expect(await runner.seen(4, 't1')).toEqual(ok(null));
  });

  it('글이 길면 알림의 한도에서 자른다', async () => {
    const { runner, saving, notices } = setup();
    await runner.start('save', 4);
    await finishLast(saving, ok({ summary: '가'.repeat(600) }));
    await vi.waitFor(() => {
      expect(notices).toHaveLength(1);
    });
    expect(notices[0]?.[1]).toHaveLength(500);
  });
});
