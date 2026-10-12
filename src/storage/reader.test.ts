import { describe, expect, it } from 'vitest';
import { oldStored, specs, stored, twoVersionFormat } from '../../tests/support/settings.ts';
import { type SettingsFormat, settingsFormat } from './format.ts';
import { type ReaderEffect, type ReaderState, initialReaderState, receive } from './reader.ts';

// 받은 값을 차례로 넣고, 마지막 상태와 그동안의 할 일을 돌려준다.
function run(values: readonly unknown[], format: SettingsFormat = settingsFormat) {
  let state: ReaderState = initialReaderState;
  const effects: ReaderEffect[] = [];
  for (const value of values) {
    const step = receive(state, value, format, specs);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
}

// 기능이 지금 쓰는 설정(other 기능의 켜짐 여부)
function otherEnabled(state: ReaderState): unknown {
  return state.snapshot?.features.get('other');
}

const t = 1_790_000_000_000;

describe('한 시점의 값만 쓴다', () => {
  it('처음 받은 지금 형식의 값을 적용한다', () => {
    const { state, effects } = run([stored(t, { other: { enabled: true } })]);
    expect(state.accepted).toBe(t);
    expect(otherEnabled(state)).toEqual({ enabled: true });
    expect(effects.map((effect) => effect.kind)).toEqual(['apply']);
  });

  it('COM-4.8 바뀜 알림이 읽기 결과보다 먼저 와도 옛 값으로 돌아가지 않는다', () => {
    const before = stored(t, { other: { enabled: false } });
    const after = stored(t + 1, { other: { enabled: true } });
    const { state } = run([after, before]);
    expect(state.accepted).toBe(t + 1);
    expect(otherEnabled(state)).toEqual({ enabled: true });
  });

  it('같은 revision을 다시 받으면 아무것도 하지 않는다', () => {
    const value = stored(t, { other: { enabled: true } });
    expect(run([value, value]).effects.map((effect) => effect.kind)).toEqual(['apply']);
  });
});

describe('COM-3.10 전체 손상 뒤 복구', () => {
  // 손상 직전에 쓴 값(T), 그 값을 쓰기 전에 보낸 읽기의 결과(T-1), 손상 값, 고쳐 쓴 값(지금 시각).
  const beforeRead = stored(t - 1, { other: { enabled: false } });
  const lastBefore = stored(t, { other: { enabled: true } });
  const corrupt = { version: 1, features: {}, sites: {} };
  const recovered = stored(t + 60_000);
  const nextChange = stored(t + 60_001, { other: { enabled: true } });
  const secondChange = stored(t + 60_002, { other: { enabled: false } });

  it('손상이면 기본값과 알림, 서비스 워커에 준비를 부탁한다', () => {
    const { state, effects } = run([beforeRead, corrupt]);
    expect(state.accepted).toBeNull();
    expect(otherEnabled(state)).toBeUndefined();
    expect(effects.slice(1)).toEqual([
      { kind: 'apply', snapshot: { features: new Map(), sites: {} } },
      { kind: 'corrupt', items: 'all' },
      { kind: 'ensureReady' },
    ]);
  });

  it('늦게 온 손상 전 읽기 결과와 바뀜 알림을 받아들이지 않고, 그 뒤 정상 변경은 모두 반영한다', () => {
    const { state } = run([
      beforeRead,
      corrupt,
      recovered,
      beforeRead,
      lastBefore,
      nextChange,
      secondChange,
    ]);
    expect(state.accepted).toBe(t + 60_002);
    expect(otherEnabled(state)).toEqual({ enabled: false });
  });

  it('늦게 온 손상 전 바뀜 알림만 보아도 그 뒤 정상 변경이 버려지지 않는다', () => {
    const { state } = run([beforeRead, corrupt, recovered, lastBefore, nextChange]);
    expect(state.accepted).toBe(t + 60_001);
    expect(otherEnabled(state)).toEqual({ enabled: true });
  });

  it('손상 직전 값의 바뀜 알림이 고쳐 쓴 값보다 먼저 와도 마지막에는 고쳐 쓴 값이다', () => {
    const { state } = run([beforeRead, corrupt, lastBefore, recovered]);
    expect(state.accepted).toBe(t + 60_000);
    expect(otherEnabled(state)).toBeUndefined();
  });

  it('손상 값이 그 뒤에 쓴 정상 값보다 늦게 와도 다시 읽은 값으로 돌아간다', () => {
    // 고쳐 쓴 뒤의 정상 값을 받은 다음 늦은 손상 값이 오고, 다시 읽으니 같은 정상 값이다.
    const { state } = run([recovered, nextChange, corrupt, nextChange]);
    expect(state.accepted).toBe(t + 60_001);
    expect(otherEnabled(state)).toEqual({ enabled: true });
  });

  it('시계가 뒤로 간 뒤의 복구 값도 받아들인다(결정 0011의 한계 밖)', () => {
    const recoveredBehind = stored(t - 3_600_000);
    const { state } = run([lastBefore, corrupt, recoveredBehind]);
    expect(state.accepted).toBe(t - 3_600_000);
  });
});

describe('형식 버전', () => {
  it('설정이 없으면 서비스 워커에 준비를 부탁하고 기능을 시작하지 않는다', () => {
    const { state, effects } = run([undefined]);
    expect(state.snapshot).toBeNull();
    expect(effects).toEqual([{ kind: 'ensureReady' }]);
  });

  it('COM-3.7 옛 형식은 손상 알림 없이 이전을 기다리고, 이전된 값으로 시작한다', () => {
    const migrated = { version: 2, revision: t, features: { other: { enabled: true } }, sites: {} };
    const { state, effects } = run(
      [oldStored(5, { other: { enabled: true } }), migrated],
      twoVersionFormat,
    );
    expect(effects.map((effect) => effect.kind)).toEqual(['ensureReady', 'apply']);
    expect(otherEnabled(state)).toEqual({ enabled: true });
  });

  it('COM-3.8 구조가 다른 더 새 형식을 보면 기능을 멈추고 그 뒤로 아무것도 받아들이지 않는다', () => {
    const { state, effects } = run([
      stored(t, { other: { enabled: true } }),
      { version: 2, settings: [] },
      stored(t + 1),
    ]);
    expect(state.snapshot).toBeNull();
    expect(state.newer).toBe(2);
    expect(effects.map((effect) => effect.kind)).toEqual(['apply', 'newer']);
  });
});

describe('COM-3.4 항목 손상', () => {
  it('손상 항목만 기본값으로 쓰고 알린다. 모르는 기능의 항목은 손상이 아니다', () => {
    const { state, effects } = run([
      stored(t, { sample: { enabled: 1 }, other: { enabled: true }, 'future-feature': {} }),
    ]);
    expect(state.snapshot?.features.has('sample')).toBe(false);
    expect(otherEnabled(state)).toEqual({ enabled: true });
    expect(effects).toContainEqual({ kind: 'corrupt', items: ['sample'] });
  });
});
