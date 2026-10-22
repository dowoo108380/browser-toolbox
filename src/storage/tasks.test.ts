import { describe, expect, it, vi } from 'vitest';
import { createFakeStore } from '../platform/fake.ts';
import { type AppError, appError, err, errorKinds, ok } from '../shared/index.ts';
import {
  type TaskRecord,
  type TaskRecords,
  finishTask,
  parseTasks,
  recoveredTasks,
  seenTask,
  startTask,
  taskOf,
  taskText,
  tasksKey,
  watchTask,
  withoutTab,
} from './tasks.ts';

// 탭마다 작업 하나의 기록(COM-10, 결정 0012, 0024).

const running = { id: 'a', featureId: 'save', action: 'run', status: 'running' } as const;
const succeeded = {
  id: 'a',
  featureId: 'save',
  action: 'run',
  status: 'succeeded',
  summary: '파일.txt',
} as const;
const failed = {
  id: 'a',
  featureId: 'save',
  action: 'run',
  status: 'failed',
  error: appError('unavailable', '자막이 없는 영상이다.'),
} as const;

describe('작업 기록의 키', () => {
  it('storage.session의 tasks다(시험 도구와 팝업이 이 이름으로 읽는다)', () => {
    expect(tasksKey).toBe('tasks');
  });
});

describe('작업 기록 읽기', () => {
  it('없으면 빈 기록이다', () => {
    expect(parseTasks(undefined)).toEqual({});
  });

  it('단계마다의 모양을 그대로 읽는다', () => {
    const records = {
      '1': running,
      '2': succeeded,
      '3': failed,
      '4': { ...succeeded, summary: null },
    };
    expect(parseTasks(records)).toEqual(records);
  });

  // 실패의 오류는 요청의 응답과 같은 정의(contracts의 appErrorSchema)로 읽는다. 그 정의가 바뀌어도 작업 기록의 저장 형식은
  // 그대로인지 본다: 오류는 오류 종류 하나와 글이고, 그 밖의 필드는 읽지 않는다.
  it.each(errorKinds)('실패 기록의 오류는 종류(%s)와 글을 저장된 JSON 그대로 읽는다', (kind) => {
    const raw: unknown = JSON.parse(
      `{"1":{"id":"a","featureId":"save","action":"run","status":"failed","error":{"kind":"${kind}","message":"까닭"}}}`,
    );
    expect(parseTasks(raw)).toEqual({ '1': { ...failed, error: { kind, message: '까닭' } } });
  });

  it('실패 기록의 오류에 모르는 필드가 있으면 종류와 글만 읽는다', () => {
    const raw = { '1': { ...failed, error: { ...failed.error, at: 1 } } };
    expect(parseTasks(raw)).toEqual({ '1': failed });
  });

  it.each([
    ['객체가 아님', 'x'],
    ['배열', [running]],
    ['모르는 단계', { '1': { ...running, status: 'paused' } }],
    ['작업 종류가 없음', { '1': { id: 'a', featureId: 'save', status: 'running' } }],
    ['진행 중인데 id가 없음', { '1': { featureId: 'save', status: 'running' } }],
    ['성공인데 짧은 결과가 없음', { '1': { id: 'a', featureId: 'save', status: 'succeeded' } }],
    ['실패인데 오류가 없음', { '1': { id: 'a', featureId: 'save', status: 'failed' } }],
    ['모르는 오류 종류', { '1': { ...failed, error: { kind: 'oops', message: '' } } }],
    ['오류의 글이 없음', { '1': { ...failed, error: { kind: 'unavailable' } } }],
    ['오류의 글이 글자가 아님', { '1': { ...failed, error: { kind: 'unavailable', message: 1 } } }],
  ])('모양이 틀리면(%s) null이다', (_name, raw) => {
    expect(parseTasks(raw)).toBeNull();
  });
});

describe('작업 시작', () => {
  it('기록이 없는 탭에서 진행 중인 작업을 남기고, 다른 탭의 기록은 그대로다', () => {
    const records: TaskRecords = { '2': succeeded };
    const started = startTask(records, 1, { id: 'b', featureId: 'copy', action: 'run' });
    expect(started).toEqual(
      ok({ '1': { id: 'b', featureId: 'copy', action: 'run', status: 'running' }, '2': succeeded }),
    );
    // 받은 기록은 고치지 않는다.
    expect(records).toEqual({ '2': succeeded });
  });

  it('진행 중인 작업이 있으면 시작하지 않고 그 작업을 돌려준다(COM-10.7)', () => {
    expect(startTask({ '1': running }, 1, { id: 'b', featureId: 'copy', action: 'run' })).toEqual(
      err(running),
    );
  });

  it.each([
    ['성공', succeeded],
    ['실패', failed],
  ])('끝난 이전 결과(%s)는 새 작업으로 바뀐다', (_name, previous) => {
    expect(startTask({ '1': previous }, 1, { id: 'b', featureId: 'copy', action: 'run' })).toEqual(
      ok({ '1': { id: 'b', featureId: 'copy', action: 'run', status: 'running' } }),
    );
  });

  it('그 탭의 작업을 읽는다. 없으면 null이다', () => {
    expect(taskOf({ '1': running }, 1)).toEqual(running);
    expect(taskOf({ '1': running }, 2)).toBeNull();
  });
});

describe('작업 끝남', () => {
  it('성공이면 짧은 결과를, 실패면 오류를 남기고 다른 탭의 기록은 그대로다', () => {
    const records: TaskRecords = { '1': running, '2': failed };
    expect(finishTask(records, 1, 'a', ok({ summary: '파일.txt' }))).toEqual({
      '1': succeeded,
      '2': failed,
    });
    expect(finishTask(records, 1, 'a', err(failed.error))).toEqual({ '1': failed, '2': failed });
    expect(records).toEqual({ '1': running, '2': failed });
  });

  it.each([
    ['그 탭의 기록이 없음(탭을 닫음)', {}],
    ['다른 작업이 진행 중(새 작업이 시작됨)', { '1': { ...running, id: 'b' } }],
    ['같은 id가 이미 끝남', { '1': succeeded }],
  ])('%s이면 늦게 온 결과를 버린다(null)', (_name, records: TaskRecords) => {
    expect(finishTask(records, 1, 'a', ok({ summary: null }))).toBeNull();
  });
});

describe('작업을 알리는 문장(팝업의 작업 칸과 페이지 위 알림, quality 018)', () => {
  it.each([
    ['진행 중', running, '저장: 진행 중이다.'],
    ['끝남', succeeded, '저장: 끝났다. 파일.txt'],
    ['끝남(짧은 결과 없음)', { ...succeeded, summary: null }, '저장: 끝났다.'],
    ['실패', failed, '저장: 실패했다. 자막이 없는 영상이다.'],
    [
      '취소(실패의 cancelled)',
      { ...failed, error: appError('cancelled', 'Esc를 눌러 멈췄다.') },
      '저장: 취소했다. Esc를 눌러 멈췄다.',
    ],
  ])('%s', (_name, task: TaskRecord, text) => {
    expect(taskText(task, '저장')).toBe(text);
  });
});

describe('결과 확인(결정 0012)', () => {
  it.each([
    ['성공', succeeded],
    ['실패', failed],
  ])('같은 작업의 끝난 결과(%s)면 그 탭의 기록만 지운다', (_name, finished) => {
    const records: TaskRecords = { '1': finished, '2': running };
    expect(seenTask(records, 1, 'a')).toEqual({ '2': running });
    expect(records).toEqual({ '1': finished, '2': running });
  });

  it.each([
    ['다른 작업의 확인(늦게 닿음, COM-10.8)', { '1': { ...succeeded, id: 'b' } }],
    ['진행 중', { '1': running }],
    ['기록이 없음', {}],
  ])('%s이면 null이다(아무것도 지우지 않는다)', (_name, records: TaskRecords) => {
    expect(seenTask(records, 1, 'a')).toBeNull();
  });
});

describe('확장 화면이 그 탭의 작업을 읽음', () => {
  it('그 탭의 작업을 읽고, 바뀌면 그 탭의 작업을 다시 준다. 없으면 null이다', async () => {
    const store = createFakeStore({ [tasksKey]: { '1': running, '2': failed } });
    const seen: (TaskRecord | null)[] = [];
    const stop = watchTask(store, 1, { task: (task) => seen.push(task), problem: () => undefined });
    await vi.waitFor(() => {
      expect(seen).toEqual([running]);
    });
    await store.set({ [tasksKey]: { '1': succeeded } });
    await store.set({ [tasksKey]: { '2': failed } });
    expect(seen).toEqual([running, succeeded, null]);
    stop();
    await store.set({ [tasksKey]: { '1': running } });
    expect(seen).toEqual([running, succeeded, null]);
  });

  it('모양이 틀린 기록은 작업이 없는 것으로 준다', async () => {
    const store = createFakeStore({ [tasksKey]: 'x' });
    const seen: (TaskRecord | null)[] = [];
    watchTask(store, 1, { task: (task) => seen.push(task), problem: () => undefined });
    await vi.waitFor(() => {
      expect(seen).toEqual([null]);
    });
  });

  it('바뀜 알림이 읽기 결과보다 먼저 오면 늦게 온 읽기 결과(옛 값)는 버린다', async () => {
    const store = createFakeStore({ [tasksKey]: { '1': running } });
    let release: () => void = () => undefined;
    const slow = {
      ...store,
      get: async (key: string) => {
        const value = await store.get(key);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return value;
      },
    };
    const seen: (TaskRecord | null)[] = [];
    watchTask(slow, 1, { task: (task) => seen.push(task), problem: () => undefined });
    await store.set({ [tasksKey]: { '1': succeeded } });
    release();
    await vi.waitFor(() => {
      expect(seen).toEqual([succeeded]);
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toEqual([succeeded]);
  });

  it('읽지 못하면 그 까닭을 알리고, 그만둔 뒤에는 알리지 않는다', async () => {
    const failing = { ...createFakeStore(), get: () => Promise.reject(new Error('x')) };
    const problems: AppError[] = [];
    watchTask(failing, 1, { task: () => undefined, problem: (error) => problems.push(error) });
    await vi.waitFor(() => {
      expect(problems).toEqual([appError('platform', '작업 기록을 읽지 못했다.')]);
    });
    const later: string[] = [];
    const stop = watchTask(failing, 1, {
      task: () => undefined,
      problem: (error) => later.push(error.kind),
    });
    stop();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(later).toEqual([]);
  });
});

describe('탭이 닫힘', () => {
  it('그 탭의 기록만 지운다', () => {
    const records: TaskRecords = { '1': running, '2': succeeded };
    expect(withoutTab(records, 1)).toEqual({ '2': succeeded });
    expect(withoutTab(records, 3)).toEqual(records);
    expect(records).toEqual({ '1': running, '2': succeeded });
  });
});

describe('서비스 워커가 다시 시작할 때 고친 기록(결정 0024)', () => {
  const stopped = appError('unexpected', '다시 시작되었다.');

  it('진행 중이던 작업은 그 오류로 끝내 돌려주고, 끝난 결과는 그대로 두며, 열려 있지 않은 탭의 기록은 지운다', () => {
    const records: TaskRecords = {
      '1': running,
      '2': succeeded,
      '3': { ...running, id: 'c' },
      '4': failed,
    };
    const recovered = recoveredTasks(records, (tabId) => tabId !== 3 && tabId !== 4, stopped);
    const ended = {
      id: 'a',
      featureId: 'save',
      action: 'run',
      status: 'failed',
      error: stopped,
    } as const;
    expect(recovered).toEqual({ records: { '1': ended, '2': succeeded }, interrupted: [ended] });
    expect(records['1']).toEqual(running);
  });

  it('고칠 것이 없으면 같은 기록과 빈 목록이다', () => {
    const records: TaskRecords = { '2': succeeded };
    expect(recoveredTasks(records, () => true, stopped)).toEqual({ records, interrupted: [] });
  });
});
