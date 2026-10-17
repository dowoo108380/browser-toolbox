import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineFeature, v } from '../contracts/index.ts';
import { type FakeStore, createFakeStore } from '../platform/fake.ts';
import type { Delivery, TabBadge } from '../platform/index.ts';
import { type AppError, appError, err, ok } from '../shared/index.ts';
import { type TaskOutcome, tasksKey } from '../storage/index.ts';
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

  it('같은 작업의 끝난 결과면 그 탭의 기록을 지운다', async () => {
    const { runner, records } = await finished();
    expect(await runner.seen(4, 't1')).toEqual(ok(null));
    expect(records()).toEqual({});
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
});

describe('서비스 워커가 다시 시작함(결정 0024)', () => {
  const interrupted = appError(
    'unexpected',
    '확장이 작업 도중 다시 시작되어 끝까지 하지 못했다. 다시 실행한다.',
  );

  it('앞 서비스 워커의 진행 중 작업은 끝내고 실패 배지를 달며 기록한다. 닫힌 탭의 기록은 지우고 끝난 결과는 그대로다', async () => {
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
    expect(badges).toEqual([[4, failedBadge]]);
    expect(listening).toEqual([true]);
    // 끝낸 작업이 있던 탭에서 다시 시작할 수 있다.
    expect((await runner.start('copy', 4)).ok).toBe(true);
  });

  it('고칠 것이 없으면 쓰지 않고, 기록이 없으면 탭 사건 듣기를 그만둔다', async () => {
    const session = createFakeStore();
    const writes = vi.spyOn(session, 'set');
    const { runner, listening } = setup({ session });
    await runner.recover();
    expect(writes).not.toHaveBeenCalled();
    expect(listening).toEqual([false]);
  });

  it('끝난 결과만 있으면 쓰지 않고 듣기를 이어 간다(배지는 서비스 워커가 멈춰도 남는다)', async () => {
    const session = createFakeStore({
      [tasksKey]: { '4': { id: 'a', featureId: 'save', status: 'succeeded', summary: null } },
    });
    const writes = vi.spyOn(session, 'set');
    const { runner, listening, badges } = setup({ session });
    await runner.recover();
    expect(writes).not.toHaveBeenCalled();
    expect(listening).toEqual([true]);
    expect(badges).toEqual([]);
  });

  it('기록을 읽지 못하면 platform으로 기록하고 듣기를 그대로 둔다', async () => {
    const failing = { ...createFakeStore(), get: () => Promise.reject(new Error('session')) };
    const { runner, problems, listening } = setup({ session: failing });
    await runner.recover();
    expect(problems).toEqual([{ featureId: null, kind: 'platform' }]);
    expect(listening).toEqual([]);
  });
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
