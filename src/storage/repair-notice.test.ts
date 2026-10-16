import { describe, expect, it } from 'vitest';
import { createFakeStore } from '../platform/fake.ts';
import type { AppError } from '../shared/index.ts';
import {
  type RepairNotice,
  type RepairScope,
  addRepair,
  dismissRepair,
  isEmptyRepair,
  mergeRepairs,
  noRepair,
  parseRepairNotice,
  repairNoticeKey,
  repairScopeOf,
  watchRepairNotice,
} from './repair-notice.ts';

// 설정 복구 알림(결정 0016).

const t = 1_790_000_000_000;

// 기능 id와 사이트 항목으로 범위를 만든다.
function scope(features: readonly string[], sites: RepairScope['sites'] = []): RepairScope {
  return { whole: false, features, sites };
}

describe('알릴 범위', () => {
  it('설정이 없음과 형식 이전은 손상이 아니라 알리지 않는다', () => {
    expect(repairScopeOf([{ kind: 'missing' }, { kind: 'migrated', from: 1 }])).toEqual(noRepair);
  });

  it('전체 손상과 손상 항목(기능, 사이트)을 모은다', () => {
    expect(
      repairScopeOf([
        { kind: 'corrupt' },
        { kind: 'corruptItems', features: ['sample'], sites: [] },
        {
          kind: 'corruptItems',
          features: ['other'],
          sites: [
            { host: 'a.test', featureId: null },
            { host: 'b.test', featureId: 'sample' },
          ],
        },
      ]),
    ).toEqual({
      whole: true,
      features: ['sample', 'other'],
      sites: [
        { host: 'a.test', featureId: null },
        { host: 'b.test', featureId: 'sample' },
      ],
    });
  });

  it('합칠 때 기능 id와 사이트 항목은 처음 나온 순서대로 한 번씩만 둔다', () => {
    const first = scope(
      ['b', 'a'],
      [
        { host: 'a.test', featureId: 'sample' },
        { host: 'a.test', featureId: null },
      ],
    );
    const second = scope(
      ['a', 'c'],
      [
        { host: 'a.test', featureId: null },
        { host: 'a.test', featureId: 'other' },
        { host: 'b.test', featureId: 'sample' },
      ],
    );
    expect(mergeRepairs(first, second)).toEqual(
      scope(
        ['b', 'a', 'c'],
        [
          { host: 'a.test', featureId: 'sample' },
          { host: 'a.test', featureId: null },
          { host: 'a.test', featureId: 'other' },
          { host: 'b.test', featureId: 'sample' },
        ],
      ),
    );
  });

  it('사이트 항목만 있어도 알릴 것이 있다', () => {
    expect(isEmptyRepair(noRepair)).toBe(true);
    expect(isEmptyRepair(scope([], [{ host: 'a.test', featureId: null }]))).toBe(false);
    expect(isEmptyRepair(scope(['sample']))).toBe(false);
    expect(isEmptyRepair({ ...noRepair, whole: true })).toBe(false);
  });
});

describe('서비스 워커가 쓰는 기록', () => {
  const sample: RepairNotice = { stamp: t, ...scope(['sample']) };

  it('기록이 없으면 지금 시각을 stamp로 새로 쓴다', () => {
    expect(addRepair(null, scope(['sample']), t)).toEqual(sample);
  });

  it('고칠 범위가 비었으면 쓰지 않는다', () => {
    expect(addRepair(sample, noRepair, t + 5)).toBeNull();
    expect(addRepair(null, noRepair, t)).toBeNull();
  });

  it('이미 기록된 기능이나 설정 전체, 사이트 항목이 다시 고쳐지면 범위는 그대로이고 stamp가 커진다', () => {
    expect(addRepair(sample, scope(['sample']), t + 5)).toEqual({ ...sample, stamp: t + 5 });
    const whole: RepairNotice = { stamp: t, ...noRepair, whole: true };
    expect(addRepair(whole, { ...noRepair, whole: true }, t)).toEqual({ ...whole, stamp: t + 1 });
    const site: RepairNotice = { stamp: t, ...scope([], [{ host: 'a.test', featureId: null }]) };
    expect(addRepair(site, scope([], [{ host: 'a.test', featureId: null }]), t)).toEqual({
      ...site,
      stamp: t + 1,
    });
  });

  it('첫 손상에 대한 확인은 같은 기능이 다시 고쳐진 기록을 지우지 않는다', () => {
    const again = addRepair(sample, scope(['sample']), t + 5);
    expect(again).not.toBeNull();
    if (again !== null) expect(dismissRepair(again, t, t + 10)).toBeNull();
  });

  it('새 손상을 더하면 앞의 것을 남기고 stamp가 커진다(시계가 뒤로 가도)', () => {
    expect(addRepair(sample, { ...noRepair, whole: true }, t - 60_000)).toEqual({
      stamp: t + 1,
      ...scope(['sample']),
      whole: true,
    });
  });

  it('사용자가 본 기록을 확인하면 비우고 stamp가 커진다', () => {
    expect(dismissRepair(sample, t, t + 10)).toEqual({ stamp: t + 10, ...noRepair });
    const site: RepairNotice = { stamp: t, ...scope([], [{ host: 'a.test', featureId: null }]) };
    expect(dismissRepair(site, t, t + 10)).toEqual({ stamp: t + 10, ...noRepair });
  });

  it('확인한 뒤에 손상이 더해졌으면(stamp가 다름) 지우지 않는다', () => {
    const later = addRepair(sample, scope(['other']), t + 3);
    expect(later).not.toBeNull();
    if (later !== null) expect(dismissRepair(later, t, t + 10)).toBeNull();
  });

  it('지울 것이 없으면 쓰지 않는다', () => {
    expect(dismissRepair(null, t, t)).toBeNull();
    expect(dismissRepair({ stamp: t, ...noRepair }, t, t + 1)).toBeNull();
  });

  it('저장 키 이름은 바뀌지 않는다(이미 저장된 기록을 다음 판이 읽는다)', () => {
    expect(repairNoticeKey).toBe('repairNotice');
  });

  it('형식이 틀린 기록은 없는 것으로 본다', () => {
    expect(parseRepairNotice({ stamp: 0, whole: false, features: [] })).toBeNull();
    expect(parseRepairNotice({ stamp: t, whole: 'yes', features: [] })).toBeNull();
    expect(parseRepairNotice({ ...sample, sites: [{ host: 'a.test' }] })).toBeNull();
    expect(parseRepairNotice({ ...sample, sites: 'a.test' })).toBeNull();
    expect(parseRepairNotice(undefined)).toBeNull();
    expect(parseRepairNotice(sample)).toEqual(sample);
  });

  it('결정 0017 사이트 항목이 없던 때의 기록은 사이트 항목이 없는 것으로 읽는다', () => {
    expect(parseRepairNotice({ stamp: t, whole: false, features: ['sample'] })).toEqual(sample);
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
  const first: RepairNotice = { stamp: t, ...scope(['sample']) };
  const second: RepairNotice = { stamp: t + 1, ...scope(['sample']), whole: true };

  it('열 때 남아 있는 기록을 읽고, 바뀌면 새 기록을 받는다', async () => {
    const store = createFakeStore({ [repairNoticeKey]: first });
    const watcher = watch(store);
    await settle();
    store.replace(repairNoticeKey, second);
    expect(watcher.notices).toEqual([first, second]);
  });

  it('읽기 결과가 바뀜 알림보다 늦게 와도 옛 기록으로 돌아가지 않는다', async () => {
    const store = createFakeStore({ [repairNoticeKey]: first });
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
    const store = createFakeStore();
    const watcher = watch(store);
    await settle();
    store.replace(repairNoticeKey, first);
    store.replace(repairNoticeKey, first);
    store.replace(repairNoticeKey, { stamp: t + 5, features: 'sample' });
    expect(watcher.notices).toEqual([first]);
  });

  it('읽지 못하면 알리고, 그만둔 뒤에는 읽기 실패도 바뀜도 알리지 않는다', async () => {
    const store = createFakeStore();
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

  it('그만두면 듣기를 그만두고, 그 직후에 이미 보낸 바뀜 알림이 와도 알리지 않는다', async () => {
    const store = createFakeStore();
    let listening = 0;
    // 듣기를 그만두기 전에 보낸 알림이 그만둔 뒤에 닿는 경우: 듣기를 그만둬도 알림이 계속 오게 흉내 낸다.
    const watcher = watch({
      get: (key) => store.get(key),
      onChanged: (key, listener) => {
        listening += 1;
        store.onChanged(key, listener);
        return () => {
          listening -= 1;
        };
      },
    });
    await settle();
    watcher.stop();
    expect(listening).toBe(0);
    store.replace(repairNoticeKey, first);
    expect(watcher.notices).toEqual([]);
  });
});
