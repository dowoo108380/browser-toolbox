import { describe, expect, it } from 'vitest';
import { createFakeLocalStore } from '../platform/fake.ts';
import type { AppError } from '../shared/index.ts';
import {
  type RepairNotice,
  addRepair,
  dismissRepair,
  mergeRepairs,
  noRepair,
  parseRepairNotice,
  repairNoticeKey,
  repairScopeOf,
  watchRepairNotice,
} from './repair-notice.ts';

// 설정 복구 알림(결정 0016).

const t = 1_790_000_000_000;

describe('알릴 범위', () => {
  it('설정이 없음과 형식 이전은 손상이 아니라 알리지 않는다', () => {
    expect(repairScopeOf([{ kind: 'missing' }, { kind: 'migrated', from: 1 }])).toEqual(noRepair);
  });

  it('전체 손상과 손상 항목을 모은다', () => {
    expect(
      repairScopeOf([
        { kind: 'corrupt' },
        { kind: 'corruptItems', items: ['sample'] },
        { kind: 'corruptItems', items: ['other'] },
      ]),
    ).toEqual({ whole: true, features: ['sample', 'other'] });
  });

  it('합칠 때 기능 id는 처음 나온 순서대로 한 번씩만 둔다', () => {
    expect(
      mergeRepairs({ whole: false, features: ['b', 'a'] }, { whole: false, features: ['a', 'c'] }),
    ).toEqual({ whole: false, features: ['b', 'a', 'c'] });
  });
});

describe('서비스 워커가 쓰는 기록', () => {
  const sample: RepairNotice = { stamp: t, whole: false, features: ['sample'] };

  it('기록이 없으면 지금 시각을 stamp로 새로 쓴다', () => {
    expect(addRepair(null, { whole: false, features: ['sample'] }, t)).toEqual(sample);
  });

  it('더해지는 것이 없으면 쓰지 않는다', () => {
    expect(addRepair(sample, { whole: false, features: ['sample'] }, t + 5)).toBeNull();
    expect(addRepair(null, noRepair, t)).toBeNull();
  });

  it('새 손상을 더하면 앞의 것을 남기고 stamp가 커진다(시계가 뒤로 가도)', () => {
    expect(addRepair(sample, { whole: true, features: [] }, t - 60_000)).toEqual({
      stamp: t + 1,
      whole: true,
      features: ['sample'],
    });
  });

  it('사용자가 본 기록을 확인하면 비우고 stamp가 커진다', () => {
    expect(dismissRepair(sample, t, t + 10)).toEqual({ stamp: t + 10, ...noRepair });
  });

  it('확인한 뒤에 손상이 더해졌으면(stamp가 다름) 지우지 않는다', () => {
    const later = addRepair(sample, { whole: false, features: ['other'] }, t + 3);
    expect(later).not.toBeNull();
    if (later !== null) expect(dismissRepair(later, t, t + 10)).toBeNull();
  });

  it('지울 것이 없으면 쓰지 않는다', () => {
    expect(dismissRepair(null, t, t)).toBeNull();
    expect(dismissRepair({ stamp: t, ...noRepair }, t, t + 1)).toBeNull();
  });

  it('형식이 틀린 기록은 없는 것으로 본다', () => {
    expect(parseRepairNotice({ stamp: 0, whole: false, features: [] })).toBeNull();
    expect(parseRepairNotice({ stamp: t, whole: 'yes', features: [] })).toBeNull();
    expect(parseRepairNotice(undefined)).toBeNull();
    expect(parseRepairNotice(sample)).toEqual(sample);
  });
});

describe('확장 화면이 읽는 기록', () => {
  function watch(store: Parameters<typeof watchRepairNotice>[0]) {
    const notices: RepairNotice[] = [];
    const problems: AppError[] = [];
    const stop = watchRepairNotice(store, {
      notice: (notice) => notices.push(notice),
      problem: (error) => problems.push(error),
    });
    return { notices, problems, stop };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const first: RepairNotice = { stamp: t, whole: false, features: ['sample'] };
  const second: RepairNotice = { stamp: t + 1, whole: true, features: ['sample'] };

  it('열 때 남아 있는 기록을 읽고, 바뀌면 새 기록을 받는다', async () => {
    const store = createFakeLocalStore({ [repairNoticeKey]: first });
    const watcher = watch(store);
    await settle();
    store.replace(repairNoticeKey, second);
    expect(watcher.notices).toEqual([first, second]);
  });

  it('읽기 결과가 바뀜 알림보다 늦게 와도 옛 기록으로 돌아가지 않는다', async () => {
    const store = createFakeLocalStore({ [repairNoticeKey]: first });
    let release: () => void = () => undefined;
    // 읽기 결과는 시험이 놓아줄 때 온다. 그 결과는 읽기를 시작한 때의 기록이다.
    const watcher = watch({
      onChanged: (key, listener) => store.onChanged(key, listener),
      get: (key) =>
        store.get(key).then(
          (value) =>
            new Promise((resolve) => {
              release = () => {
                resolve(value);
              };
            }),
        ),
    });
    await settle();
    store.replace(repairNoticeKey, second);
    release();
    await settle();
    expect(watcher.notices).toEqual([second]);
  });

  it('같은 기록을 두 번 받아도 한 번만 알리고, 형식이 틀린 기록은 넘긴다', async () => {
    const store = createFakeLocalStore();
    const watcher = watch(store);
    await settle();
    store.replace(repairNoticeKey, first);
    store.replace(repairNoticeKey, first);
    store.replace(repairNoticeKey, { stamp: t + 5, features: 'sample' });
    expect(watcher.notices).toEqual([first]);
  });

  it('읽지 못하면 알리고, 그만둔 뒤에는 읽기 실패도 바뀜도 알리지 않는다', async () => {
    const store = createFakeLocalStore();
    const failing = watch({ ...store, get: () => Promise.reject(new Error('읽기 실패')) });
    await settle();
    expect(failing.problems.map((problem) => problem.kind)).toEqual(['platform']);

    let fail: () => void = () => undefined;
    const stopped = watch({
      ...store,
      get: () =>
        new Promise((_resolve, reject) => {
          fail = () => {
            reject(new Error('읽기 실패'));
          };
        }),
    });
    stopped.stop();
    fail();
    store.replace(repairNoticeKey, first);
    await settle();
    expect(stopped.problems).toEqual([]);
    expect(stopped.notices).toEqual([]);
  });
});
