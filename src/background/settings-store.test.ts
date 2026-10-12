import { describe, expect, it } from 'vitest';
import { specs, stored } from '../../tests/support/settings.ts';
import { createFakeLocalStore } from '../platform/fake.ts';
import type { LocalStore } from '../platform/index.ts';
import { settingsFormat, settingsKey } from '../storage/index.ts';
import type { Problem } from './problems.ts';
import { createSettingsStore } from './settings-store.ts';

const t = 1_790_000_000_000;

function setup(initial?: unknown) {
  const store = createFakeLocalStore(initial === undefined ? {} : { [settingsKey]: initial });
  const problems: Problem[] = [];
  const settings = createSettingsStore({
    store,
    now: () => t,
    format: settingsFormat,
    features: specs,
    record: (problem) => problems.push(problem),
  });
  return { settings, store, problems };
}

describe('설정 바꾸기', () => {
  it('바꾼 필드만 바꾸고 revision을 지금 시각으로 정한다', async () => {
    const { settings, store } = setup(
      stored(5, { sample: { enabled: true, step: 0.5, label: 'a' } }),
    );
    const result = await settings.updateFeature('sample', { label: 'b' });
    expect(result).toEqual({ ok: true, value: { revision: t } });
    expect(store.peek(settingsKey)).toEqual(
      stored(t, { sample: { enabled: true, step: 0.5, label: 'b' } }),
    );
  });

  it('없던 기능은 기본값에서 시작한다', async () => {
    const { settings, store } = setup(stored(5));
    await settings.updateFeature('sample', { enabled: true });
    expect(store.peek(settingsKey)).toEqual(
      stored(t, { sample: { enabled: true, step: 0.1, label: '' } }),
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
      stored(t + 2, {
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
    const { settings, store, problems } = setup(stored(5, { sample: { enabled: 'no' } }));
    expect((await settings.updateFeature('other', { enabled: true })).ok).toBe(true);
    expect(store.peek(settingsKey)).toEqual(stored(t, { other: { enabled: true } }));
    expect(problems).toEqual([{ featureId: 'sample', kind: 'unexpected' }]);
  });

  it('COM-3.8 같은 형식에서 모르는 기능의 항목은 다른 기능을 바꿔도 그대로 남고 손상으로 기록하지 않는다', async () => {
    const { settings, store, problems } = setup(stored(5, { 'future-feature': { mode: 3 } }));
    expect((await settings.updateFeature('other', { enabled: true })).ok).toBe(true);
    expect(store.peek(settingsKey)).toEqual(
      stored(t, { 'future-feature': { mode: 3 }, other: { enabled: true } }),
    );
    expect(problems).toEqual([]);
  });

  it('COM-3.3 저장이 실패하면 실패를 알리고 저장된 설정은 그대로다', async () => {
    const fake = createFakeLocalStore({ [settingsKey]: stored(5) });
    const failing: LocalStore = { ...fake, set: () => Promise.reject(new Error('quota')) };
    const settings = createSettingsStore({
      store: failing,
      now: () => t,
      format: settingsFormat,
      features: specs,
      record: () => undefined,
    });
    const result = await settings.updateFeature('other', { enabled: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('platform');
    expect(fake.peek(settingsKey)).toEqual(stored(5));
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
  it('처음 설치면 기본 설정을 지금 시각의 revision으로 쓴다', async () => {
    const { settings, store, problems } = setup();
    expect(await settings.ensureReady()).toEqual({ ok: true, value: null });
    expect(store.peek(settingsKey)).toEqual(stored(t));
    expect(problems).toEqual([]);
  });

  it('전체 손상이면 기본 설정으로 고쳐 쓰고 한 번 기록한다', async () => {
    const { settings, store, problems } = setup({ version: 'x' });
    await settings.ensureReady();
    await settings.ensureReady();
    expect(store.peek(settingsKey)).toEqual(stored(t));
    expect(problems).toEqual([{ featureId: null, kind: 'unexpected' }]);
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
