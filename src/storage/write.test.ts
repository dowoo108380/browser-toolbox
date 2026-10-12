import { describe, expect, it } from 'vitest';
import { oldStored, specs, stored, twoVersionFormat } from '../../tests/support/settings.ts';
import { settingsFormat } from './format.ts';
import { checkSize, nextRevision, normalize, settingsSize, settingsSizeLimit } from './write.ts';

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
        repairs: [{ kind: 'corruptItems', items: ['sample'] }],
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
    expect(checkSize(next, stored(1)).ok).toBe(true);
  });

  it('한도에서 1바이트 넘으면 저장하지 않고 지금 크기를 알린다', () => {
    const next = withSize(settingsSizeLimit + 1);
    expect(settingsSize(next)).toBe(settingsSizeLimit + 1);
    const result = checkSize(next, stored(1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('limit');
      expect(result.error.message).toContain(String(settingsSize(stored(1))));
    }
  });

  it('한도를 넘은 상태에서도 줄이는 저장은 한다', () => {
    const big = withSize(settingsSizeLimit + 300);
    const smaller = withSize(settingsSizeLimit + 100);
    expect(checkSize(smaller, big).ok).toBe(true);
  });

  it('한글은 UTF-8 바이트로 센다', () => {
    // 한 글자 3바이트. 문자열 길이로 세면 한도의 3분의 1 남짓이라 통과해 버린다.
    const next = withSize(settingsSizeLimit + 3, '가');
    expect(JSON.stringify(next).length).toBeLessThan(settingsSizeLimit);
    expect(checkSize(next, stored(1)).ok).toBe(false);
  });
});
