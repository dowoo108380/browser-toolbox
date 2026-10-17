import * as valibot from 'valibot';

// 런타임 검증의 어휘(결정 0028). 저장소에서 valibot을 가져오는 곳은 이 파일 하나다(린터가 막는다). 다른 곳은 contracts의
// `v`로 스키마를 만들고(`v.object(...)`) 검증한다(`v.safeParse(schema, value)`의 `success`와 `output`).
//
// 대부분은 valibot의 것을 그대로 내보낸다. zod/mini에서 옮길 때 받아들이는 값이 달라지는 넷은 여기서 앞의 판과 같게 맞춘다.
// 같은 형식 버전이면 판이 바뀌어도 저장된 값을 같게 읽어야 하기 때문이다(결정 0021). `tests/integration/schema-acceptance.test.ts`가
// 지킨다.
// - object, looseObject: 배열을 객체로 받지 않는다(valibot은 배열도 객체로 받는다).
// - record: 보통 객체만 받는다. 배열, 클래스로 만든 객체, Map, Date는 받지 않는다.
// - maxLength: 글자를 UTF-16 단위가 아니라 코드 포인트로 센다(BMP 밖 글자 하나가 하나, 짝 없는 대리 문자도 하나).
// - number: 유한한 수만 받는다(valibot은 Infinity도 받는다). int는 안전한 정수(절댓값 2^53 미만)다.

export type { InferOutput } from 'valibot';

// 값을 검증해 Output을 내는 스키마. 받는 값은 무엇이든 된다(신뢰 경계에서 받은 값을 넘긴다).
export type Schema<Output = unknown> = valibot.GenericSchema<unknown, Output>;

export {
  array,
  boolean,
  literal,
  minValue,
  null,
  nullable,
  optional,
  parse,
  picklist,
  pipe,
  safeParse,
  string,
  union,
  unknown,
} from 'valibot';

function isObjectNotArray(input: unknown): input is object {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

// 보통 객체: 객체 리터럴, JSON에서 읽은 객체, 원형이 없는 객체. 원형의 생성자가 바뀐 객체(클래스, Map, Date)는 아니다.
// 다른 창(iframe)에서 만든 객체도 보통 객체로 본다(생성자의 원형에 isPrototypeOf가 제 것으로 있으면).
function isPlainObject(input: unknown): input is Readonly<Record<string, unknown>> {
  if (!isObjectNotArray(input)) return false;
  const constructor: unknown = Reflect.get(input, 'constructor');
  if (typeof constructor !== 'function') return true;
  const prototype: unknown = Reflect.get(constructor, 'prototype');
  return isObjectNotArray(prototype) && Object.hasOwn(prototype, 'isPrototypeOf');
}

const objectNotArray = valibot.custom<unknown>(isObjectNotArray);
const plainObject = valibot.custom<unknown>(isPlainObject);

export function object<const Entries extends valibot.ObjectEntries>(entries: Entries) {
  return valibot.pipe(objectNotArray, valibot.object(entries));
}

export function looseObject<const Entries extends valibot.ObjectEntries>(entries: Entries) {
  return valibot.pipe(objectNotArray, valibot.looseObject(entries));
}

export function record<
  const Key extends valibot.GenericSchema<string, string>,
  const Value extends valibot.GenericSchema,
>(key: Key, value: Value) {
  return valibot.pipe(plainObject, valibot.record(key, value));
}

// 코드 포인트의 수. 짝이 맞는 대리 문자 둘이 하나다.
function codePoints(text: string): number {
  let count = text.length;
  for (let index = 0; index < text.length - 1; index += 1) {
    const high = text.charCodeAt(index);
    const low = text.charCodeAt(index + 1);
    if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
      count -= 1;
      index += 1;
    }
  }
  return count;
}

export function maxLength(limit: number) {
  return valibot.check((text: string) => codePoints(text) <= limit);
}

export function number() {
  return valibot.pipe(valibot.number(), valibot.finite());
}

export function int() {
  return valibot.pipe(valibot.number(), valibot.safeInteger());
}
