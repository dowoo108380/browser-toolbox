import { describe, expect, it } from 'vitest';
import { oldStored, specs, stored, twoVersionFormat } from '../../tests/support/settings.ts';
import { settingsFormat } from './format.ts';
import {
  checkFinal,
  checkSize,
  nextRevision,
  normalize,
  settingsSize,
  settingsSizeLimit,
} from './write.ts';

describe('쓰기 전에 지금 형식의 값을 만든다', () => {
  it('설정이 없으면 기본 설정에서 시작한다', () => {
    expect(normalize(undefined, settingsFormat, specs)).toEqual({
      ok: true,
      value: { value: stored(0), repairs: [{ kind: 'missing' }] },
    });
  });

  it('전체 손상이면 기본 설정에서 시작한다', () => {
    expect(normalize({ version: 1 }, settingsFormat, specs)).toEqual({
      ok: true,
      value: { value: stored(0), repairs: [{ kind: 'corrupt' }] },
    });
  });

  it('COM-3.8 더 새 버전이면 구조가 달라도 손대지 않고 거절한다', () => {
    const result = normalize({ version: 2, settings: [] }, settingsFormat, specs);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('unavailable');
  });

  it('COM-3.7 구조가 다른 옛 버전을 이전한다', () => {
    expect(normalize(oldStored(5, { other: { enabled: true } }), twoVersionFormat, specs)).toEqual({
      ok: true,
      value: {
        value: { version: 2, revision: 5, features: { other: { enabled: true } }, sites: {} },
        repairs: [{ kind: 'migrated', from: 1 }],
      },
    });
  });

  it('결정 0011 이전 함수는 항목 손상을 고치거나 버리지 않고 넘기고, 지금 형식의 항목 검증이 알아본다', () => {
    const old = oldStored(5, { sample: { enabled: 'no' }, other: { enabled: true } });
    expect(normalize(old, twoVersionFormat, specs)).toEqual({
      ok: true,
      value: {
        value: { version: 2, revision: 5, features: { other: { enabled: true } }, sites: {} },
        repairs: [
          { kind: 'migrated', from: 1 },
          { kind: 'corruptItems', features: ['sample'], sites: [] },
        ],
      },
    });
  });

  it('COM-3.7 그 버전의 구조로도 틀린 옛 값은 설정 전체의 손상이다', () => {
    expect(normalize({ version: 1, rev: 'x' }, twoVersionFormat, specs)).toEqual({
      ok: true,
      value: {
        value: { version: 2, revision: 0, features: {}, sites: {} },
        repairs: [{ kind: 'corrupt' }],
      },
    });
  });

  it('COM-3.4 손상 항목만 지우고, 모르는 기능의 항목은 그대로 둔다', () => {
    const raw = stored(4, {
      sample: { enabled: 'yes' },
      other: { enabled: true },
      'future-feature': { anything: 1 },
    });
    expect(normalize(raw, settingsFormat, specs)).toEqual({
      ok: true,
      value: {
        value: stored(4, { other: { enabled: true }, 'future-feature': { anything: 1 } }),
        repairs: [{ kind: 'corruptItems', features: ['sample'], sites: [] }],
      },
    });
  });

  it('COM-3.4 결정 0017 손상된 사이트 항목만 지우고, 그 사이트의 다른 항목과 모르는 기능의 사이트 항목은 그대로 둔다', () => {
    const raw = stored(
      4,
      { other: { enabled: true } },
      {
        'a.test': { sample: { rules: 'x' }, other: { kept: true }, 'future-feature': [1] },
        'b.test': 'x',
        'c.test': { sample: { rules: ['#ad'], note: '새 판이 더한 필드' } },
        'd.test': { sample: { rules: [1] } },
      },
    );
    expect(normalize(raw, settingsFormat, specs)).toEqual({
      ok: true,
      value: {
        // 남는 항목은 스키마를 거친 값이 아니라 저장된 값 그대로다(새 판이 더한 필드도 남는다).
        // 항목이 모두 빠진 사이트는 빈 객체로 남는다.
        value: stored(
          4,
          { other: { enabled: true } },
          {
            'a.test': { other: { kept: true }, 'future-feature': [1] },
            'c.test': { sample: { rules: ['#ad'], note: '새 판이 더한 필드' } },
            'd.test': {},
          },
        ),
        repairs: [
          {
            kind: 'corruptItems',
            features: [],
            sites: [
              { host: 'a.test', featureId: 'sample' },
              { host: 'b.test', featureId: null },
              { host: 'd.test', featureId: 'sample' },
            ],
          },
        ],
      },
    });
  });

  it('고칠 것이 없으면 그대로다', () => {
    const raw = stored(4, { other: { enabled: true } });
    expect(normalize(raw, settingsFormat, specs)).toEqual({
      ok: true,
      value: { value: raw, repairs: [] },
    });
  });
});

describe('세대 번호(결정 0011)', () => {
  const now = 1_790_000_000_000;

  it('바꾸기 전 값을 읽을 수 없으면 지금 시각이다', () => {
    expect(nextRevision(0, now)).toBe(now);
  });

  it('지금 시각이 더 크면 지금 시각이다', () => {
    expect(nextRevision(now - 5000, now)).toBe(now);
  });

  it('같은 밀리초에 다시 써도 앞의 값보다 크다', () => {
    expect(nextRevision(now, now)).toBe(now + 1);
  });

  it('시계가 뒤로 가도 바꾸기 전 값보다 크다', () => {
    expect(nextRevision(now, now - 60_000)).toBe(now + 1);
  });
});

describe('최종 값 검증(결정 0011 "쓰기")', () => {
  it('지금 형식이고 아는 기능의 항목이 맞으면 통과한다. 모르는 기능의 항목은 보지 않는다', () => {
    const value = stored(5, { other: { enabled: true }, 'future-feature': { anything: 1 } });
    expect(checkFinal(value, settingsFormat, specs)).toEqual({ ok: true, value });
  });

  it('revision이 Number.MAX_SAFE_INTEGER에서 더 올라간 값은 쓰지 않는다', () => {
    const next = stored(nextRevision(Number.MAX_SAFE_INTEGER, 1_790_000_000_000));
    const result = checkFinal(next, settingsFormat, specs);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('unexpected');
  });

  it('아는 기능의 항목이 틀리면 쓰지 않는다', () => {
    expect(checkFinal(stored(5, { other: { enabled: 1 } }), settingsFormat, specs).ok).toBe(false);
  });

  it('결정 0017 사이트 항목도 읽는 쪽과 같은 기준으로 본다', () => {
    const check = (sites: Record<string, unknown>) =>
      checkFinal(stored(5, {}, sites), settingsFormat, specs).ok;
    expect(
      check({ 'a.test': { sample: { rules: ['#ad'] }, 'future-feature': 'x', other: 1 } }),
    ).toBe(true);
    expect(check({ 'a.test': { sample: { rules: 'x' } } })).toBe(false);
    expect(check({ 'a.test': null })).toBe(false);
  });
});

describe('COM-3.9 크기 한도', () => {
  // features 안의 문자열 하나로 크기를 맞춘 설정을 만든다.
  function withSize(bytes: number, character = 'a') {
    const empty = stored(1_790_000_000_000, { other: { enabled: true, note: '' } });
    const base = settingsSize(empty);
    const unit = new TextEncoder().encode(character).length;
    const note = character.repeat(Math.floor((bytes - base) / unit));
    return stored(1_790_000_000_000, { other: { enabled: true, note } });
  }

  it('한도까지는 저장한다', () => {
    const next = withSize(settingsSizeLimit);
    expect(settingsSize(next)).toBe(settingsSizeLimit);
    expect(checkSize(next, stored(1), stored(1)).ok).toBe(true);
  });

  it('한도에서 1바이트 넘으면 저장하지 않고 지금 크기를 알린다', () => {
    const next = withSize(settingsSizeLimit + 1);
    expect(settingsSize(next)).toBe(settingsSizeLimit + 1);
    const result = checkSize(next, stored(1), stored(1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('limit');
      expect(result.error.message).toContain(String(settingsSize(stored(1))));
    }
  });

  it('한도를 넘은 상태에서도 줄이는 저장은 한다', () => {
    const big = withSize(settingsSizeLimit + 300);
    const smaller = withSize(settingsSizeLimit + 100);
    expect(checkSize(smaller, big, big).ok).toBe(true);
  });

  it('한도를 넘은 상태에서 크기가 같은 저장은 한다', () => {
    const big = withSize(settingsSizeLimit + 300);
    expect(checkSize(big, big, big).ok).toBe(true);
  });

  it('한글은 UTF-8 바이트로 센다', () => {
    // 한 글자 3바이트. 문자열 길이로 세면 한도의 3분의 1 남짓이라 통과해 버린다.
    const next = withSize(settingsSizeLimit + 3, '가');
    expect(JSON.stringify(next).length).toBeLessThan(settingsSizeLimit);
    expect(checkSize(next, stored(1), stored(1)).ok).toBe(false);
  });

  it('지금은 저장된 값이다: 손상 항목을 지운 값보다 커져도 저장된 값보다 크지 않으면 하고, 알리는 크기도 저장된 값이다', () => {
    const storedValue = withSize(settingsSizeLimit + 300);
    const repaired = withSize(settingsSizeLimit + 100);
    expect(checkSize(withSize(settingsSizeLimit + 300), storedValue, repaired).ok).toBe(true);
    const result = checkSize(withSize(settingsSizeLimit + 301), storedValue, repaired);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain(String(settingsSize(storedValue)));
      expect(result.error.message).not.toContain(String(settingsSize(repaired)));
    }
  });

  it('결정 0011 같은 쓰기에 섞인 형식 이전으로 커진 만큼은 막지 않는다. 알리는 크기는 저장된 값이다', () => {
    // 저장된 옛 값(여기서는 크기만 본다)과, 그것을 이전해 한도를 넘게 커진 값.
    const storedOld = withSize(settingsSizeLimit - 100);
    const migrated = withSize(settingsSizeLimit + 300);
    expect(checkSize(withSize(settingsSizeLimit + 300), storedOld, migrated).ok).toBe(true);
    const result = checkSize(withSize(settingsSizeLimit + 301), storedOld, migrated);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain(String(settingsSize(storedOld)));
      expect(result.error.message).not.toContain(String(settingsSize(migrated)));
    }
  });

  it('저장된 값이 없으면 지금 크기는 0이다', () => {
    expect(settingsSize(undefined)).toBe(0);
  });
});
