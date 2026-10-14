import { describe, expect, it } from 'vitest';
import { specs, stored } from '../../tests/support/settings.ts';
import { createFakeLocalStore } from '../platform/fake.ts';
import { appError, err, ok } from '../shared/index.ts';
import {
  type RepairScope,
  type SettingsReaderHandlers,
  type Snapshot,
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
  // 참이면 설정 저장이 늘 실패한다(COM-3.3).
  readonly failWrites?: boolean;
  // 참이면 복구 알림을 남기지 못한다(결정 0016).
  readonly failNotice?: boolean;
}

function setup(initial?: unknown, { failWrites = false, failNotice = false }: SetupOptions = {}) {
  const fake = createFakeLocalStore(initial === undefined ? {} : { [settingsKey]: initial });
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
      set: async (values) => {
        if (failWrites) throw new Error('quota');
        events.push('write');
        written.push(structuredClone(values[settingsKey]));
        await fake.set(values);
      },
    },
    now: clock.now,
    sleep: clock.sleep,
    format: settingsFormat,
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

  it('COM-3.3 저장이 실패하면 실패를 알리고 저장된 설정은 그대로다', async () => {
    const { settings, store } = setup(stored(5), { failWrites: true });
    const result = await settings.updateFeature('other', { enabled: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('platform');
    expect(store.peek(settingsKey)).toEqual(stored(5));
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
          const parsed = definition.value.safeParse(null);
          return Promise.resolve(
            parsed.success ? ok(parsed.data) : err(appError('unexpected', '응답 형식')),
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
