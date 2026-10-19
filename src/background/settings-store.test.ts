import { v } from '../contracts/index.ts';
import { describe, expect, it } from 'vitest';
import { specs, stored } from '../../tests/support/settings.ts';
import { createFakeStore } from '../platform/fake.ts';
import { appError, err, ok } from '../shared/index.ts';
import {
  type RepairScope,
  type SettingsFormat,
  type SettingsReaderHandlers,
  type Snapshot,
  currentStructure,
  settingsFormat,
  settingsKey,
  startSettingsReader,
} from '../storage/index.ts';
import type { Problem } from './problems.ts';
import { createSettingsStore } from './settings-store.ts';

const t = 1_790_000_000_000;

function revisionOf(value: unknown): number {
  if (typeof value === 'object' && value !== null && 'revision' in value) {
    if (typeof value.revision === 'number') return value.revision;
  }
  throw new Error('revision이 없는 값이다.');
}

// 가짜 시계. 기다릴 때만 흐른다. 그래서 연달아 쓰는 일이 모두 같은 밀리초에 일어나는 가장 나쁜 경우가 된다.
function fakeClock(start = t) {
  const clock = {
    time: start,
    now: () => clock.time,
    sleep: (ms: number) => {
      clock.time += ms;
      return Promise.resolve();
    },
  };
  return clock;
}

interface SetupOptions {
  // 참이면 설정 읽기가 늘 실패한다.
  readonly failReads?: boolean;
  // 참이면 설정 저장이 늘 실패한다(COM-3.3).
  readonly failWrites?: boolean;
  // 참이면 복구 알림을 남기지 못한다(결정 0016).
  readonly failNotice?: boolean;
  readonly format?: SettingsFormat;
}

function setup(
  initial?: unknown,
  {
    failReads = false,
    failWrites = false,
    failNotice = false,
    format = settingsFormat,
  }: SetupOptions = {},
) {
  const fake = createFakeStore(initial === undefined ? {} : { [settingsKey]: initial });
  const problems: Problem[] = [];
  const notices: RepairScope[] = [];
  // 복구 알림과 설정 쓰기가 일어난 순서.
  const events: string[] = [];
  const clock = fakeClock();
  // 쓴 값을 차례로 모은다.
  const written: unknown[] = [];
  const settings = createSettingsStore({
    store: {
      ...fake,
      get: async (key) => {
        if (failReads) throw new Error('read');
        return fake.get(key);
      },
      set: async (values) => {
        if (failWrites) throw new Error('quota');
        events.push('write');
        written.push(structuredClone(values[settingsKey]));
        await fake.set(values);
      },
    },
    now: clock.now,
    sleep: clock.sleep,
    format,
    features: specs,
    record: (problem) => problems.push(problem),
    noticeRepair: (scope) => {
      if (failNotice) return Promise.resolve(err(appError('platform', '알림 저장 실패')));
      events.push('notice');
      notices.push(scope);
      return Promise.resolve(ok(null));
    },
  });
  return { settings, store: fake, problems, notices, events, clock, written };
}

describe('설정 바꾸기', () => {
  it('바꾼 필드만 바꾸고 revision을 읽은 뒤의 시각으로 정한다', async () => {
    const { settings, store } = setup(
      stored(5, { sample: { enabled: true, step: 0.5, label: 'a' } }),
    );
    const result = await settings.updateFeature('sample', { label: 'b' });
    expect(result).toEqual({ ok: true, value: { revision: t + 1 } });
    expect(store.peek(settingsKey)).toEqual(
      stored(t + 1, { sample: { enabled: true, step: 0.5, label: 'b' } }),
    );
  });

  it('없던 기능은 기본값에서 시작한다', async () => {
    const { settings, store } = setup(stored(5));
    await settings.updateFeature('sample', { enabled: true });
    expect(store.peek(settingsKey)).toEqual(
      stored(t + 1, { sample: { enabled: true, step: 0.1, label: '' } }),
    );
  });

  it('COM-3.6 같은 기능의 다른 필드를 거의 동시에 바꿔도 둘 다 남는다', async () => {
    const { settings, store } = setup(stored(5));
    await Promise.all([
      settings.updateFeature('sample', { enabled: true }),
      settings.updateFeature('sample', { label: '두 번째' }),
      settings.updateFeature('other', { enabled: true }),
    ]);
    expect(store.peek(settingsKey)).toEqual(
      stored(t + 3, {
        sample: { enabled: true, step: 0.1, label: '두 번째' },
        other: { enabled: true },
      }),
    );
  });

  it('모르는 기능이나 틀린 값은 저장하지 않는다', async () => {
    const { settings, store } = setup(stored(5));
    expect((await settings.updateFeature('nothing', { enabled: true })).ok).toBe(false);
    const wrong = await settings.updateFeature('sample', { step: 'fast' });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.kind).toBe('invalid-input');
    expect(store.peek(settingsKey)).toEqual(stored(5));
  });

  it('COM-3.4 손상 항목이 있어도 다른 기능을 바꿀 수 있고, 손상 항목은 기본값이 되며 기록된다', async () => {
    const { settings, store, problems, notices, events } = setup(
      stored(5, { sample: { enabled: 'no' } }),
    );
    expect((await settings.updateFeature('other', { enabled: true })).ok).toBe(true);
    expect(store.peek(settingsKey)).toEqual(stored(t + 1, { other: { enabled: true } }));
    expect(problems).toEqual([{ featureId: 'sample', kind: 'unexpected' }]);
    // 고쳐 쓰기 전에 사용자에게 보일 복구 알림을 남긴다(결정 0016).
    expect(notices).toEqual([{ whole: false, features: ['sample'], sites: [] }]);
    expect(events).toEqual(['notice', 'write']);
  });

  it('COM-3.4 결정 0017 손상된 사이트 항목이 있어도 다른 기능을 바꿀 수 있고, 그 사이트 항목만 지우며 사이트 이름 없이 기록한다', async () => {
    const { settings, store, problems, notices } = setup(
      stored(
        5,
        {},
        {
          'a.test': { sample: { rules: 'x' }, 'future-feature': { mode: 1 } },
          'b.test': 7,
          'c.test': { sample: { rules: ['#ad'] } },
        },
      ),
    );
    expect((await settings.updateFeature('other', { enabled: true })).ok).toBe(true);
    expect(store.peek(settingsKey)).toEqual(
      stored(
        t + 1,
        { other: { enabled: true } },
        { 'a.test': { 'future-feature': { mode: 1 } }, 'c.test': { sample: { rules: ['#ad'] } } },
      ),
    );
    expect(notices).toEqual([
      {
        whole: false,
        features: [],
        sites: [
          { host: 'a.test', featureId: 'sample' },
          { host: 'b.test', featureId: null },
        ],
      },
    ]);
    // 문제 기록에는 사이트 이름을 넣지 않는다(COM-5 기대 동작 3).
    expect(problems).toEqual([
      { featureId: 'sample', kind: 'unexpected' },
      { featureId: null, kind: 'unexpected' },
    ]);
  });

  it('결정 0016 복구 알림을 남기지 못하면 손상을 고치지도 바꾸지도 않는다', async () => {
    const value = stored(5, { sample: { enabled: 'no' } });
    const { settings, store, problems } = setup(value, { failNotice: true });
    const result = await settings.updateFeature('other', { enabled: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('platform');
    expect(store.peek(settingsKey)).toEqual(value);
    expect(problems).toEqual([]);
  });

  it('COM-3.8 같은 형식에서 모르는 기능의 항목은 다른 기능을 바꿔도 그대로 남고 손상으로 기록하지 않는다', async () => {
    const { settings, store, problems } = setup(stored(5, { 'future-feature': { mode: 3 } }));
    expect((await settings.updateFeature('other', { enabled: true })).ok).toBe(true);
    expect(store.peek(settingsKey)).toEqual(
      stored(t + 1, { 'future-feature': { mode: 3 }, other: { enabled: true } }),
    );
    expect(problems).toEqual([]);
  });

  it('결정 0022 이 판이 모르는 필드(같은 형식의 더 새 판이 더한 것)는 그 기능을 바꿔도 그대로 남고, 요청에 든 모르는 필드는 저장하지 않는다', async () => {
    const newer = { enabled: true, step: 0.5, label: 'a', savedFuturePreference: { mode: 2 } };
    const { settings, store, problems, notices } = setup(stored(5, { sample: newer }));
    const result = await settings.updateFeature('sample', { label: 'b', unknownInRequest: 1 });
    expect(result).toEqual({ ok: true, value: { revision: t + 1 } });
    expect(store.peek(settingsKey)).toEqual(stored(t + 1, { sample: { ...newer, label: 'b' } }));
    expect(problems).toEqual([]);
    expect(notices).toEqual([]);
  });

  it('COM-3.3 저장이 실패하면 실패를 알리고 저장된 설정은 그대로다', async () => {
    const { settings, store } = setup(stored(5), { failWrites: true });
    const result = await settings.updateFeature('other', { enabled: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('platform');
    expect(store.peek(settingsKey)).toEqual(stored(5));
  });

  it('결정 0036 unexpected가 아닌 실패로 답하는 길에서는 설정을 쓰지 않는다(팝업은 저장하지 않음으로 본다)', async () => {
    const cases = [
      ['모르는 기능', setup(stored(5)), 'nothing', { enabled: true }],
      ['틀린 값', setup(stored(5)), 'sample', { step: 'fast' }],
      ['읽지 못함', setup(stored(5), { failReads: true }), 'sample', { enabled: true }],
      ['더 새 형식', setup({ version: 2, settings: {} }), 'other', { enabled: true }],
      [
        '복구 알림을 남기지 못함',
        setup(stored(5, { sample: { enabled: 'no' } }), { failNotice: true }),
        'other',
        { enabled: true },
      ],
      ['쓰지 못함', setup(stored(5), { failWrites: true }), 'other', { enabled: true }],
    ] as const;
    for (const [name, { settings, written }, featureId, patch] of cases) {
      const result = await settings.updateFeature(featureId, patch);
      expect({
        name,
        failed: !result.ok && result.error.kind !== 'unexpected',
        written,
      }).toEqual({ name, failed: true, written: [] });
    }
  });

  it('COM-3.8 더 새 형식이면 거절하고 저장된 값을 바꾸지 않는다', async () => {
    const newer = { version: 2, settings: { sample: 1 } };
    const { settings, store } = setup(newer);
    const result = await settings.updateFeature('other', { enabled: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('unavailable');
    expect(store.peek(settingsKey)).toEqual(newer);
  });
});

describe('준비(ensureReady)', () => {
  it('결정 0011 고쳐 쓰기는 크기 한도와 상관없이 한다(한도를 넘은 설정의 손상 항목도 고친다)', async () => {
    const big = { note: 'a'.repeat(300_000) };
    const { settings, store } = setup(
      stored(5, { sample: { enabled: 'no' }, 'future-feature': big }),
    );
    expect(await settings.ensureReady()).toEqual({ ok: true, value: null });
    expect(store.peek(settingsKey)).toEqual(stored(t + 1, { 'future-feature': big }));
  });

  it('처음 설치면 기본 설정을 읽은 뒤의 시각을 revision으로 쓰고, 손상이 아니므로 알리지 않는다', async () => {
    const { settings, store, problems, notices } = setup();
    expect(await settings.ensureReady()).toEqual({ ok: true, value: null });
    expect(store.peek(settingsKey)).toEqual(stored(t + 1));
    expect(problems).toEqual([]);
    expect(notices).toEqual([]);
  });

  it('전체 손상이면 복구 알림을 남긴 뒤 기본 설정으로 고쳐 쓰고 한 번 기록한다', async () => {
    const { settings, store, problems, notices, events } = setup({ version: 'x' });
    await settings.ensureReady();
    await settings.ensureReady();
    expect(store.peek(settingsKey)).toEqual(stored(t + 1));
    expect(problems).toEqual([{ featureId: null, kind: 'unexpected' }]);
    expect(notices).toEqual([{ whole: true, features: [], sites: [] }]);
    expect(events).toEqual(['notice', 'write']);
  });

  it('COM-3.4 손상 항목만 기본값으로 고쳐 쓰고, 그 항목을 알린다', async () => {
    const { settings, store, notices } = setup(
      stored(5, { sample: { enabled: 'no' }, other: { enabled: true } }),
    );
    expect(await settings.ensureReady()).toEqual({ ok: true, value: null });
    expect(store.peek(settingsKey)).toEqual(stored(t + 1, { other: { enabled: true } }));
    expect(notices).toEqual([{ whole: false, features: ['sample'], sites: [] }]);
  });

  it('COM-3.4 결정 0017 손상된 사이트 항목만 고쳐 쓰고 알린다. 모르는 기능의 사이트 항목은 손상이 아니다', async () => {
    const { settings, store, notices, events } = setup(
      stored(5, {}, { 'a.test': [], 'b.test': { 'future-feature': 'x' } }),
    );
    expect(await settings.ensureReady()).toEqual({ ok: true, value: null });
    expect(store.peek(settingsKey)).toEqual(
      stored(t + 1, {}, { 'b.test': { 'future-feature': 'x' } }),
    );
    expect(notices).toEqual([
      { whole: false, features: [], sites: [{ host: 'a.test', featureId: null }] },
    ]);
    expect(events).toEqual(['notice', 'write']);
  });

  it('결정 0017 모르는 기능의 사이트 항목만 있으면 고칠 것이 없어 쓰지 않는다', async () => {
    const value = stored(5, {}, { 'a.test': { 'future-feature': 'x', other: [] } });
    const { settings, store, notices } = setup(value);
    await settings.ensureReady();
    expect(store.peek(settingsKey)).toEqual(value);
    expect(notices).toEqual([]);
  });

  it('결정 0016 복구 알림을 남기지 못하면 고쳐 쓰지 않고 실패를 돌려준다(다음 준비 때 다시 한다)', async () => {
    const value = { version: 'x' };
    const { settings, store, problems } = setup(value, { failNotice: true });
    const result = await settings.ensureReady();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('platform');
    expect(store.peek(settingsKey)).toEqual(value);
    expect(problems).toEqual([]);
  });

  it('고칠 것이 없으면 쓰지 않는다', async () => {
    const value = stored(5, { other: { enabled: true } });
    const { settings, store } = setup(value);
    await settings.ensureReady();
    expect(store.peek(settingsKey)).toEqual(value);
  });

  it('COM-3.8 구조가 다른 더 새 형식이면 쓰지 않는다', async () => {
    const newer = { version: 3, features: [], extra: true };
    const { settings, store } = setup(newer);
    expect(await settings.ensureReady()).toEqual({ ok: true, value: null });
    expect(store.peek(settingsKey)).toEqual(newer);
  });
});

describe('최종 값 검증(결정 0011 "쓰기")', () => {
  // revision이 더 올라갈 수 없는 값. 이 확장이 쓸 수 없는 값이다(손으로 고친 값).
  const exhausted = Number.MAX_SAFE_INTEGER;

  // 이 모듈은 unexpected를 돌려주기만 한다. 기록은 결과를 받는 쪽(라우터, 서비스 워커 시작)이 한다.
  it('설정 바꾸기: 다음 revision이 스키마 밖이면 쓰지 않고 unexpected를 돌려주며, 저장된 값은 그대로다', async () => {
    const value = stored(exhausted, { other: { enabled: true } });
    const { settings, store, problems } = setup(value);
    const result = await settings.updateFeature('other', { enabled: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('unexpected');
    expect(store.peek(settingsKey)).toEqual(value);
    expect(problems).toEqual([]);
  });

  it('고쳐 쓰기: 다음 revision이 스키마 밖이면 손상 항목을 고치지 않고 그대로 둔다', async () => {
    const value = stored(exhausted, { sample: { enabled: 'no' }, other: { enabled: true } });
    const { settings, store, problems } = setup(value);
    const result = await settings.ensureReady();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('unexpected');
    expect(store.peek(settingsKey)).toEqual(value);
    // 손상 항목은 고쳐 쓴 뒤에만 기록한다. 쓰지 못했으므로 아무것도 기록하지 않는다.
    expect(problems).toEqual([]);
  });
});

describe('COM-3.9 설정 바꾸기의 크기 한도는 지금 저장된 값과 비교한다(결정 0011 "크기 한도")', () => {
  // 요구사항의 정의대로 잰다: JSON으로 쓴 UTF-8 바이트 수, 한도 262,144(COM-3 기대 동작 8).
  const limit = 262_144;
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  // 저장된 값과 쓰는 값(t + 1)의 revision 자릿수를 같게 해, 크기 차이가 바꾼 내용에서만 나게 한다.
  const revision = t - 1000;
  const sample = (label: string) => ({ sample: { enabled: false, step: 0.1, label } });
  const longLabel = 'b'.repeat(200);

  // 한도 가까이 찬 사이트 규칙(a.test)과 손상된 사이트 항목(v.test)이 함께 저장된 값에서 기능 설정(sample의 label)을 늘린다.
  // 바꾼 값(next)은 손상 항목을 지운 값(repaired)보다 크고 한도를 넘는다. 저장된 값보다 몇 바이트 큰지(more)는 손상 항목의 길이로 맞춘다.
  // 항목이 모두 빠진 사이트는 빈 객체로 남는다(결정 0017).
  function nearLimit(more: number) {
    const sites = (rule: string, zTest: unknown) => ({
      'a.test': { sample: { rules: [rule] } },
      'v.test': zTest,
    });
    const rule = 'a'.repeat(limit - 100 - bytes(stored(t + 1, sample(''), sites('', {}))));
    const withCorrupt = (length: number) =>
      stored(revision, sample(''), sites(rule, { sample: { rules: 'x'.repeat(length) } }));
    const next = stored(t + 1, sample(longLabel), sites(rule, {}));
    const raw = withCorrupt(bytes(next) - more - bytes(withCorrupt(0)));
    return { raw, next, repaired: stored(revision, sample(''), sites(rule, {})) };
  }

  it.each([
    ['작아지는', -1],
    ['크기가 같은', 0],
  ])(
    '손상된 사이트 항목을 지우며 다른 설정을 바꾼 결과가 한도를 넘어도, 저장된 값보다 %s 저장은 한다',
    async (_name, more) => {
      const { raw, next, repaired } = nearLimit(more);
      expect(bytes(next)).toBeGreaterThan(limit);
      expect(bytes(next)).toBeGreaterThan(bytes(repaired));
      expect(bytes(next) - bytes(raw)).toBe(more);
      const { settings, store, notices, problems } = setup(raw);
      expect(await settings.updateFeature('sample', { label: longLabel })).toEqual({
        ok: true,
        value: { revision: t + 1 },
      });
      expect(store.peek(settingsKey)).toEqual(next);
      expect(notices).toEqual([
        { whole: false, features: [], sites: [{ host: 'v.test', featureId: 'sample' }] },
      ]);
      expect(problems).toEqual([{ featureId: 'sample', kind: 'unexpected' }]);
    },
  );

  it('저장된 값보다 커지면 하지 않고, 알리는 지금 크기는 손상 항목을 지운 값이 아니라 저장된 값의 크기다', async () => {
    const { raw, repaired } = nearLimit(1);
    const { settings, store, problems } = setup(raw);
    const result = await settings.updateFeature('sample', { label: longLabel });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('limit');
      expect(result.error.message).toContain(String(bytes(raw)));
      expect(result.error.message).not.toContain(String(bytes(repaired)));
    }
    expect(store.peek(settingsKey)).toEqual(raw);
    // 쓰지 못했으므로 손상 항목은 지우지 않았고 기록하지 않는다. 다음 준비 때 고친다.
    expect(problems).toEqual([]);
  });

  // 세대 번호의 이름만 rev에서 revision으로 바꾼 가짜 옛 형식 1. 이전하면 5바이트 커진다.
  const renamedOld = v.object({
    version: v.literal(1),
    rev: v.int(),
    features: v.record(v.string(), v.unknown()),
    sites: v.record(v.string(), v.unknown()),
  });
  const renamedFormat: SettingsFormat = {
    version: 2,
    structure: currentStructure(2),
    migrations: new Map([
      [
        1,
        {
          structure: renamedOld,
          migrate: (value: unknown) => {
            const { rev, ...rest } = v.parse(renamedOld, value);
            return { ...rest, version: 2, revision: rev };
          },
        },
      ],
    ]),
  };

  it('형식 이전으로 커지는 값에서 줄이는 저장은, 결과가 저장된 옛 값보다 커도 이전만 한 값보다 크지 않으면 한다', async () => {
    const old = (label: string) => ({
      version: 1,
      rev: revision,
      features: sample(label),
      sites: {},
    });
    // 이전한 값이 한도를 3바이트 넘게 label을 맞춘다. 저장된 옛 값은 그보다 5바이트 작아 한도 안이다.
    const length = limit + 3 - bytes({ version: 2, revision, features: sample(''), sites: {} });
    const raw = old('b'.repeat(length));
    expect(bytes(raw)).toBe(limit - 2);
    const { settings, store } = setup(raw, { format: renamedFormat });
    // label을 한 글자 줄인다. 결과는 한도와 저장된 옛 값보다 크지만 이전만 한 값보다 1바이트 작다.
    expect(await settings.updateFeature('sample', { label: 'b'.repeat(length - 1) })).toEqual({
      ok: true,
      value: { revision: t + 1 },
    });
    expect(store.peek(settingsKey)).toEqual({
      version: 2,
      revision: t + 1,
      features: sample('b'.repeat(length - 1)),
      sites: {},
    });
  });
});

describe('세대 번호: 쓰는 쪽이 만든 값을 읽는 쪽에 넣는다(결정 0011, COM-3.10)', () => {
  // 쓰는 쪽(이 모듈)이 실제로 쓴 값을 읽기 도우미에 원하는 순서로 전달한다.
  function reader(first: unknown) {
    let view = first;
    let deliver: (value: unknown) => void = () => undefined;
    const applied: Snapshot[] = [];
    const handlers: SettingsReaderHandlers = {
      apply: (snapshot) => applied.push(snapshot),
      corrupt: () => undefined,
      newer: () => undefined,
      problem: () => undefined,
    };
    startSettingsReader(
      {
        store: {
          get: () => Promise.resolve(view),
          onChanged: (_key, listener) => {
            deliver = listener;
            return () => undefined;
          },
        },
        // 준비 요청은 서비스 워커가 이미 고쳐 쓴 것처럼 바로 응답한다. 다시 읽으면 setView로 정한 값이다.
        request: (definition) => {
          const parsed = v.safeParse(definition.value, null);
          return Promise.resolve(
            parsed.success
              ? ok(parsed.output)
              : err({ ...appError('unexpected', '응답 형식'), answered: false }),
          );
        },
        format: settingsFormat,
        specs,
      },
      handlers,
    );
    return {
      // 저장소에 지금 있는 값(다시 읽으면 받는 값)을 정한다.
      setView: (value: unknown) => {
        view = value;
      },
      deliver: (value: unknown) => {
        deliver(value);
      },
      last: () => applied.at(-1)?.features,
    };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('같은 밀리초에 연달아 써도 revision은 쓴 시각을 넘지 않는다', async () => {
    const { settings, clock, written } = setup(stored(5));
    for (const enabled of [true, false, true]) await settings.updateFeature('other', { enabled });
    const revisions = written.map(revisionOf);
    expect(revisions).toEqual([t + 1, t + 2, t + 3]);
    expect(Math.max(...revisions)).toBeLessThanOrEqual(clock.now());
  });

  it('연달아 쓴 직후 같은 밀리초에 전체 손상을 고쳐 써도, 고쳐 쓴 값이 앞의 어떤 값보다 커서 늦게 온 옛 값을 버린다', async () => {
    const { settings, store, written } = setup(stored(5));
    await settings.updateFeature('other', { enabled: true });
    await settings.updateFeature('other', { enabled: false });
    await settings.updateFeature('sample', { label: '마지막' });
    const [first, second, last] = written;
    const page = reader(first);
    await settle();
    expect(page.last()?.get('other')).toEqual({ enabled: true });

    // 기능이 도는 중에 설정 전체가 손상되고, 서비스 워커가 고쳐 쓴다.
    const corrupt = { version: 1 };
    store.replace(settingsKey, corrupt);
    await settings.ensureReady();
    const recovered = written.at(-1);
    expect(recovered).toMatchObject({ features: {} });
    expect(revisionOf(recovered)).toBeGreaterThan(
      Math.max(...[first, second, last].map(revisionOf)),
    );

    // 손상 값을 받고 다시 읽으면 고쳐 쓴 값이다. 그 뒤 손상 전의 값이 늦게 온다.
    page.setView(recovered);
    page.deliver(corrupt);
    await settle();
    page.deliver(last);
    page.deliver(second);
    expect(page.last()).toEqual(new Map());

    // 그 뒤의 정상 변경은 받아들인다.
    await settings.updateFeature('other', { enabled: true });
    page.deliver(written.at(-1));
    expect(page.last()?.get('other')).toEqual({ enabled: true });
  });
});
