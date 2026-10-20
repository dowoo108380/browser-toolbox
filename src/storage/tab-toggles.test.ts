import { describe, expect, it } from 'vitest';
import { createFakeStore } from '../platform/fake.ts';
import { appError } from '../shared/index.ts';
import {
  type TabToggleRecords,
  mayBeOn,
  parseTabToggleHint,
  parseTabToggles,
  recordedTabs,
  tabIsOn,
  tabNotice,
  tabTogglesKey,
  watchTabToggles,
  withAllTabs,
  withChoice,
  withNotice,
  withReplacedTab,
  withTurnedOff,
  withoutTab,
} from './tab-toggles.ts';

// 탭마다 켜고 끄는 기능의 기록(TAB-2 기대 동작 1, 결정 0043).

const f = 'tab-keep-active';
const empty: TabToggleRecords = {};

describe('탭마다 켜고 끄기의 기록', () => {
  it('없으면 빈 기록이고, 모양이 틀리면 null이다', () => {
    expect(parseTabToggles(undefined)).toEqual({});
    const records = {
      [f]: { allTabs: true, tabs: { '3': { choice: false, notice: 'cancelled' } } },
    };
    expect(parseTabToggles(records)).toEqual(records);
    expect(parseTabToggles({ [f]: { allTabs: 'yes', tabs: {} } })).toBeNull();
    expect(
      parseTabToggles({ [f]: { allTabs: true, tabs: { '3': { choice: 1, notice: null } } } }),
    ).toBeNull();
    expect(parseTabToggles([])).toBeNull();
  });

  it('TAB-2 기대 동작 1 고른 것이 없으면 스위치를 따르고, 고른 것이 있으면 그것이다', () => {
    expect(tabIsOn(empty, f, 1, false)).toBe(false);
    expect(tabIsOn(empty, f, 1, true)).toBe(true);
    const chosen = withChoice(withAllTabs(empty, f, false) ?? empty, f, false, [1], true);
    expect(tabIsOn(chosen, f, 1, false)).toBe(true);
    expect(tabIsOn(chosen, f, 2, false)).toBe(false);
  });

  it('스위치와 같은 쪽을 고르면 고른 것을 지워 기록이 남지 않는다(알림도 지운다)', () => {
    const on = withAllTabs(empty, f, true) ?? empty;
    const off = withChoice(on, f, true, [1, 2], false);
    expect(recordedTabs(off, f)).toEqual([1, 2]);
    const back = withChoice(withNotice(off, f, true, 1, 'no-safe-point'), f, true, [1], true);
    expect(recordedTabs(back, f)).toEqual([2]);
    expect(tabIsOn(back, f, 1, true)).toBe(true);
    expect(tabNotice(back, f, 1)).toBeNull();
  });

  it('TAB-2 기대 동작 1 스위치가 기록이 따르던 값과 다르면 고른 것과 알림을 모두 지운다(한꺼번에 적용). 같으면 바뀌지 않는다', () => {
    const on = withAllTabs(empty, f, true) ?? empty;
    expect(withAllTabs(on, f, true)).toBeNull();
    const chosen = withTurnedOff(
      withChoice(on, f, true, [1], false),
      f,
      true,
      [2],
      'attach-failed',
    );
    expect(recordedTabs(chosen, f)).toEqual([1, 2]);
    const switched = withAllTabs(chosen, f, false);
    expect(switched).toEqual({ [f]: { allTabs: false, tabs: {} } });
  });

  it('TAB-2 기대 동작 9 기능이 끈 탭은 까닭을 남긴다. 스위치가 켜져 있으면 끔을 고른 것으로, 꺼져 있으면 스위치를 따른다', () => {
    const switchedOn = withTurnedOff(
      withAllTabs(empty, f, true) ?? empty,
      f,
      true,
      [4],
      'attach-failed',
    );
    expect(tabIsOn(switchedOn, f, 4, true)).toBe(false);
    expect(tabNotice(switchedOn, f, 4)).toBe('attach-failed');
    const chosen = withChoice(withAllTabs(empty, f, false) ?? empty, f, false, [4], true);
    const switchedOff = withTurnedOff(chosen, f, false, [4], 'cancelled');
    expect(tabIsOn(switchedOff, f, 4, false)).toBe(false);
    expect(switchedOff[f]?.tabs['4']).toEqual({ choice: null, notice: 'cancelled' });
  });

  it('알림은 고른 것을 그대로 두고, 둘 다 없으면 그 탭의 기록을 지운다', () => {
    const chosen = withChoice(withAllTabs(empty, f, false) ?? empty, f, false, [5], true);
    const noticed = withNotice(chosen, f, false, 5, 'no-safe-point');
    expect(noticed[f]?.tabs['5']).toEqual({ choice: true, notice: 'no-safe-point' });
    const plain = withNotice(withAllTabs(empty, f, true) ?? empty, f, true, 6, 'no-safe-point');
    expect(tabIsOn(plain, f, 6, true)).toBe(true);
    expect(recordedTabs(withNotice(plain, f, true, 6, null), f)).toEqual([]);
  });

  it('어느 탭에서 켜졌을 수 있는지: 스위치가 켜졌거나 켬을 고른 탭이 있다', () => {
    const off = withAllTabs(empty, f, false) ?? empty;
    expect(mayBeOn(off, f, false)).toBe(false);
    expect(mayBeOn(off, f, true)).toBe(true);
    expect(mayBeOn(withChoice(off, f, false, [1], true), f, false)).toBe(true);
    expect(mayBeOn(withTurnedOff(off, f, false, [1], 'cancelled'), f, false)).toBe(false);
  });

  it('TAB-2.8 닫힌 탭의 기록을 모든 기능에서 지우고, 바뀐 탭(tabs.onReplaced)으로 기록을 옮긴다', () => {
    const records = withChoice(withAllTabs(empty, f, false) ?? empty, f, false, [1, 2], true);
    expect(recordedTabs(withoutTab(records, 1), f)).toEqual([2]);
    const moved = withReplacedTab(records, 9, 2);
    expect(recordedTabs(moved, f)).toEqual([1, 9]);
    expect(withReplacedTab(records, 9, 7)).toEqual(records);
  });

  it('기록이 없는 기능도 다룬다: 기록이 없고, 고르거나 끄거나 알림을 남기면 그 기능의 기록이 생긴다', () => {
    expect(recordedTabs(empty, f)).toEqual([]);
    expect(mayBeOn(empty, f, false)).toBe(false);
    expect(withChoice(empty, f, false, [1], true)).toEqual({
      [f]: { allTabs: false, tabs: { '1': { choice: true, notice: null } } },
    });
    expect(withTurnedOff(empty, f, true, [1], 'cancelled')).toEqual({
      [f]: { allTabs: true, tabs: { '1': { choice: false, notice: 'cancelled' } } },
    });
    expect(withNotice(empty, f, false, 1, 'no-safe-point')).toEqual({
      [f]: { allTabs: false, tabs: { '1': { choice: null, notice: 'no-safe-point' } } },
    });
  });

  it('고르기와 끄기는 기록이 따르는 스위치 값으로 판단한다(받은 값과 달라도)', () => {
    const switchedOn = withAllTabs(empty, f, true) ?? empty;
    expect(withChoice(switchedOn, f, false, [1], true)).toEqual(switchedOn);
    expect(tabNotice(withTurnedOff(switchedOn, f, false, [1], 'x'), f, 1)).toBe('x');
    expect(tabIsOn(withTurnedOff(switchedOn, f, false, [1], 'x'), f, 1, true)).toBe(false);
  });

  it('바뀐 탭에 옮길 기록이 없으면 새 탭의 자리를 만들지 않는다', () => {
    const records = withChoice(withAllTabs(empty, f, false) ?? empty, f, false, [1], true);
    expect(Object.keys(withReplacedTab(records, 9, 7)[f]?.tabs ?? {})).toEqual(['1']);
  });

  it('받은 기록을 고치지 않는다', () => {
    const records = withAllTabs(empty, f, true) ?? empty;
    const frozen = JSON.stringify(records);
    withChoice(records, f, true, [1], false);
    withNotice(records, f, true, 1, 'x');
    withTurnedOff(records, f, true, [1], 'x');
    expect(JSON.stringify(records)).toBe(frozen);
  });

  it('결정 0043 표시는 기능 id의 목록이고, 없거나 모양이 틀리면 빈 목록이다', () => {
    expect(parseTabToggleHint([f])).toEqual([f]);
    expect(parseTabToggleHint(undefined)).toEqual([]);
    expect(parseTabToggleHint('x')).toEqual([]);
    expect(parseTabToggleHint(['a'.repeat(65)])).toEqual([]);
  });
});

describe('확장 화면의 기록 읽기(watchTabToggles)', () => {
  it('읽은 기록을 주고, 바뀌면 다시 준다. 바뀜이 읽기보다 먼저 오면 읽기는 버린다', async () => {
    const records = { [f]: { allTabs: false, tabs: { '1': { choice: true, notice: null } } } };
    const store = createFakeStore({ [tabTogglesKey]: records });
    const received: TabToggleRecords[] = [];
    const stop = watchTabToggles(store, {
      records: (next) => received.push(next),
      problem: () => undefined,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(received).toEqual([records]);
    await store.set({ [tabTogglesKey]: {} });
    expect(received).toEqual([records, {}]);
    stop();
    await store.set({ [tabTogglesKey]: records });
    expect(received).toHaveLength(2);
  });

  it('모양이 틀린 기록은 빈 기록으로 보이고, 읽지 못하면 알린다', async () => {
    const broken = createFakeStore({ [tabTogglesKey]: 'x' });
    const received: TabToggleRecords[] = [];
    watchTabToggles(broken, { records: (next) => received.push(next), problem: () => undefined });
    await Promise.resolve();
    await Promise.resolve();
    expect(received).toEqual([{}]);
    const problems: string[] = [];
    watchTabToggles(
      { get: () => Promise.reject(new Error('읽기 실패')), onChanged: () => () => undefined },
      { records: () => undefined, problem: (error) => problems.push(error.kind) },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(problems).toEqual(['platform']);
  });

  it('바뀜이 읽기 결과보다 먼저 오면 읽기 결과(옛 값일 수 있음)는 버린다', async () => {
    const old = { [f]: { allTabs: true, tabs: {} } };
    let resolveRead: (value: unknown) => void = () => undefined;
    let changed: (value: unknown) => void = () => undefined;
    const received: TabToggleRecords[] = [];
    watchTabToggles(
      {
        get: () =>
          new Promise((resolve) => {
            resolveRead = resolve;
          }),
        onChanged: (_key, listener) => {
          changed = listener;
          return () => undefined;
        },
      },
      { records: (next) => received.push(next), problem: () => undefined },
    );
    changed({});
    resolveRead(old);
    await Promise.resolve();
    await Promise.resolve();
    expect(received).toEqual([{}]);
  });

  it('그만둔 뒤에는 읽기 결과도 읽기 실패도 알리지 않고, 읽지 못하면 그 까닭을 알린다', async () => {
    const pending = () => {
      let settle: { resolve: (value: unknown) => void; reject: (error: Error) => void } = {
        resolve: () => undefined,
        reject: () => undefined,
      };
      const read = new Promise<unknown>((resolve, reject) => {
        settle = { resolve, reject };
      });
      return { store: { get: () => read, onChanged: () => () => undefined }, settle: () => settle };
    };
    const seen: unknown[] = [];
    const handlers = {
      records: (next: TabToggleRecords) => seen.push(next),
      problem: (error: unknown) => seen.push(error),
    };
    const resolved = pending();
    watchTabToggles(resolved.store, handlers)();
    resolved.settle().resolve({});
    const rejected = pending();
    watchTabToggles(rejected.store, handlers)();
    rejected.settle().reject(new Error('읽기 실패'));
    const failing = pending();
    watchTabToggles(failing.store, handlers);
    failing.settle().reject(new Error('읽기 실패'));
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    expect(seen).toEqual([appError('platform', '탭마다 켠 기능의 기록을 읽지 못했다.')]);
  });
});
