import { describe, expect, it } from 'vitest';
import * as v from './schema.ts';

// 검증 어휘가 앞의 판(zod/mini)과 같게 맞춘 규칙(결정 0028). 저장되는 값과 메시지 전체의 받아들임·거절은
// tests/integration/schema-acceptance.test.ts의 표가 지키고, 여기서는 그 규칙의 경계를 하나씩 본다.

const accepts = (schema: v.Schema, value: unknown) => v.safeParse(schema, value).success;

class Point {
  readonly x = 1;
}

describe('결정 0028 기록(record)은 보통 객체만 받는다', () => {
  const schema = v.record(v.string(), v.unknown());

  it.each([
    ['빈 객체', {}],
    ['키가 있는 객체', { a: 1 }],
    ['원형이 없는 객체', Object.create(null)],
    ['constructor 키가 수인 객체', { constructor: 1 }],
    ['constructor 키가 객체인 객체', { constructor: {} }],
    ['constructor 키가 Object인 객체', { constructor: Object }],
  ])('받는다: %s', (_name, value) => {
    expect(accepts(schema, value)).toBe(true);
  });

  it.each([
    ['배열', []],
    ['키를 가진 배열', Object.assign([], { a: 1 })],
    ['클래스로 만든 객체', new Point()],
    ['Map', new Map()],
    ['Date', new Date(0)],
    ['원형의 생성자가 바뀐 객체', { constructor: Point }],
    [
      '생성자의 원형이 객체가 아님',
      { constructor: Object.assign(() => undefined, { prototype: 1 }) },
    ],
    ['null', null],
    ['문자열', 'a'],
  ])('받지 않는다: %s', (_name, value) => {
    expect(accepts(schema, value)).toBe(false);
  });
});

describe('결정 0028 객체(object, looseObject)는 배열을 받지 않는다', () => {
  it.each([
    ['object', v.object({})],
    ['looseObject', v.looseObject({})],
  ])('%s', (_name, schema) => {
    expect(accepts(schema, {})).toBe(true);
    expect(accepts(schema, new Point())).toBe(true);
    expect(accepts(schema, [])).toBe(false);
    expect(accepts(schema, null)).toBe(false);
  });
});

describe('결정 0028 글자 수(maxLength)는 코드 포인트로 센다', () => {
  const one = v.pipe(v.string(), v.maxLength(1));
  // 대리 문자는 파일에 어떻게 저장되든 같게 보이도록 UTF-16 단위로 만든다.
  const units = (...codes: number[]) => String.fromCharCode(...codes);

  it.each([
    ['빈 글', ''],
    ['한 글자', '가'],
    ['가장 낮은 대리 문자 쌍', units(0xd800, 0xdc00)],
    ['가장 높은 대리 문자 쌍', units(0xdbff, 0xdfff)],
    ['짝 없는 높은 대리 문자', units(0xd800)],
    ['짝 없는 낮은 대리 문자', units(0xdc00)],
  ])('한 글자로 센다: %s', (_name, text) => {
    expect(accepts(one, text)).toBe(true);
  });

  it.each([
    ['두 글자', '가나'],
    ['높은 대리 문자보다 하나 아래와 낮은 대리 문자', units(0xd7ff, 0xdc00)],
    ['높은 대리 문자보다 하나 위와 낮은 대리 문자', units(0xdc00, 0xdc00)],
    ['높은 대리 문자와 낮은 대리 문자보다 하나 아래', units(0xd800, 0xdbff)],
    ['높은 대리 문자와 낮은 대리 문자보다 하나 위', units(0xd800, 0xe000)],
    ['순서가 바뀐 쌍', units(0xdc00, 0xd800)],
    ['글자와 대리 문자 쌍', units(0x61, 0xd83d, 0xde00)],
    ['대리 문자 쌍과 글자', units(0xd83d, 0xde00, 0x61)],
  ])('두 글자로 센다: %s', (_name, text) => {
    expect(accepts(one, text)).toBe(false);
  });
});

describe('결정 0028 수', () => {
  it('number는 유한한 수만 받는다', () => {
    expect(accepts(v.number(), 1.5)).toBe(true);
    expect(accepts(v.number(), Number.POSITIVE_INFINITY)).toBe(false);
    expect(accepts(v.number(), Number.NaN)).toBe(false);
  });

  it('int는 안전한 정수만 받는다', () => {
    expect(accepts(v.int(), Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(accepts(v.int(), -Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(accepts(v.int(), 2 ** 53)).toBe(false);
    expect(accepts(v.int(), 1.5)).toBe(false);
  });
});
