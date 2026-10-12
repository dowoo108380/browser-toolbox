import { describe, expect, it } from 'vitest';
import { oldStored, stored, twoVersionFormat } from '../../tests/support/settings.ts';
import { classify, migrateToCurrent, settingsFormat } from './format.ts';

describe('형식 버전으로 먼저 나눈다(결정 0011 읽는 쪽 계약 2)', () => {
  it('키가 없으면 없음이다', () => {
    expect(classify(undefined, settingsFormat)).toEqual({ kind: 'missing' });
  });

  it.each([
    ['객체가 아님', 'settings'],
    ['null', null],
    ['배열', [1]],
    ['version 없음', { revision: 3, features: {}, sites: {} }],
    ['version이 문자열', { version: '1', revision: 3, features: {}, sites: {} }],
    ['version이 0', { version: 0, revision: 3, features: {}, sites: {} }],
    ['version이 정수가 아님', { version: 1.5, revision: 3, features: {}, sites: {} }],
  ])('버전을 알 수 없으면 전체 손상이다: %s', (_name, raw) => {
    expect(classify(raw, settingsFormat)).toEqual({ kind: 'corrupt' });
  });

  it.each([
    ['revision 없음', { version: 1, features: {}, sites: {} }],
    ['revision이 0', { version: 1, revision: 0, features: {}, sites: {} }],
    ['features가 배열', { version: 1, revision: 3, features: [], sites: {} }],
    ['sites 없음', { version: 1, revision: 3, features: {} }],
  ])('같은 버전에서 구조가 틀리면 전체 손상이다: %s', (_name, raw) => {
    expect(classify(raw, settingsFormat)).toEqual({ kind: 'corrupt' });
  });

  it('같은 버전이고 구조가 맞으면 지금 형식이다', () => {
    expect(classify(stored(7, { a: { enabled: true } }), settingsFormat)).toEqual({
      kind: 'current',
      value: stored(7, { a: { enabled: true } }),
    });
  });

  it.each([
    ['구조가 같음', { version: 2, revision: 3, features: {}, sites: {} }],
    ['features가 배열', { version: 2, revision: 3, features: [], sites: {} }],
    ['revision과 sites 없음', { version: 2, settings: { anything: true } }],
    ['revision이 문자열', { version: 9, revision: 'x', features: 'y' }],
  ])('COM-3.8 더 새 버전은 구조가 달라도 손상이 아니다: %s', (_name, raw) => {
    expect(classify(raw, settingsFormat)).toEqual({ kind: 'newer', version: raw.version });
  });

  it('COM-3.7 옛 버전은 지금 구조로 검사하지 않는다', () => {
    const old = oldStored(5, { sample: { enabled: true } });
    expect(classify(old, twoVersionFormat)).toEqual({ kind: 'older', version: 1, value: old });
  });
});

describe('옛 형식 이전', () => {
  it('COM-3.7 구조가 다른 옛 버전을 그 버전의 경로로 이전하고 revision을 옮긴다', () => {
    expect(
      migrateToCurrent(1, oldStored(5, { sample: { enabled: true } }), twoVersionFormat),
    ).toEqual({ version: 2, revision: 5, features: { sample: { enabled: true } }, sites: {} });
  });

  it('COM-3.7 그 버전의 구조로도 틀린 옛 값은 전체 손상이다', () => {
    expect(migrateToCurrent(1, { version: 1, rev: 'x' }, twoVersionFormat)).toBe('corrupt');
  });

  it('이전 함수가 없으면 결함으로 드러낸다', () => {
    expect(() => migrateToCurrent(1, {}, { ...twoVersionFormat, migrations: new Map() })).toThrow();
  });
});
