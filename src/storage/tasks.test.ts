import { describe, expect, it } from 'vitest';
import { appError, err, ok } from '../shared/index.ts';
import { type TaskRecords, finishTask, parseTasks, startTask, taskOf } from './tasks.ts';

// 탭마다 작업 하나의 기록(COM-10, 결정 0012, 0024).

const running = { id: 'a', featureId: 'save', status: 'running' } as const;
const succeeded = { id: 'a', featureId: 'save', status: 'succeeded', summary: '파일.txt' } as const;
const failed = {
  id: 'a',
  featureId: 'save',
  status: 'failed',
  error: appError('unavailable', '자막이 없는 영상이다.'),
} as const;

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

  it.each([
    ['객체가 아님', 'x'],
    ['배열', [running]],
    ['모르는 단계', { '1': { ...running, status: 'paused' } }],
    ['진행 중인데 id가 없음', { '1': { featureId: 'save', status: 'running' } }],
    ['성공인데 짧은 결과가 없음', { '1': { id: 'a', featureId: 'save', status: 'succeeded' } }],
    ['실패인데 오류가 없음', { '1': { id: 'a', featureId: 'save', status: 'failed' } }],
    ['모르는 오류 종류', { '1': { ...failed, error: { kind: 'oops', message: '' } } }],
  ])('모양이 틀리면(%s) null이다', (_name, raw) => {
    expect(parseTasks(raw)).toBeNull();
  });
});

describe('작업 시작', () => {
  it('기록이 없는 탭에서 진행 중인 작업을 남기고, 다른 탭의 기록은 그대로다', () => {
    const records: TaskRecords = { '2': succeeded };
    const started = startTask(records, 1, { id: 'b', featureId: 'copy' });
    expect(started).toEqual(
      ok({ '1': { id: 'b', featureId: 'copy', status: 'running' }, '2': succeeded }),
    );
    // 받은 기록은 고치지 않는다.
    expect(records).toEqual({ '2': succeeded });
  });

  it('진행 중인 작업이 있으면 시작하지 않고 그 작업을 돌려준다(COM-10.7)', () => {
    expect(startTask({ '1': running }, 1, { id: 'b', featureId: 'copy' })).toEqual(err(running));
  });

  it.each([
    ['성공', succeeded],
    ['실패', failed],
  ])('끝난 이전 결과(%s)는 새 작업으로 바뀐다', (_name, previous) => {
    expect(startTask({ '1': previous }, 1, { id: 'b', featureId: 'copy' })).toEqual(
      ok({ '1': { id: 'b', featureId: 'copy', status: 'running' } }),
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
