import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/mini';
import { defineFeature } from '../contracts/index.ts';
import { createFakeStore } from '../platform/fake.ts';
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
  settings: { schema: z.object({ enabled: z.boolean() }), defaults: { enabled: false } },
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

function setup(
  options: {
    readonly parts?: readonly TaskPart[];
    readonly tabExists?: (tabId: number) => Promise<boolean>;
    readonly session?: ReturnType<typeof createFakeStore>;
  } = {},
) {
  const saving = controlledPart(save);
  const copying = controlledPart(copy);
  const session = options.session ?? createFakeStore();
  const problems: Problem[] = [];
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
    record: (problem) => problems.push(problem),
  });
  return { runner, session, problems, saving, copying, records: () => session.peek(tasksKey) };
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

describe('실행 기능과 일의 짝(quality 066)', () => {
  const start = (parts: readonly TaskPart[]) => () =>
    createTaskRunner({
      session: createFakeStore(),
      features: [toggle, save],
      parts,
      randomId: () => 't',
      tabExists: () => Promise.resolve(true),
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
