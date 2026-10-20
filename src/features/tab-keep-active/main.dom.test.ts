import { afterEach, describe, expect, it } from 'vitest';
import { armDetail, armEventName } from './core/shield.ts';
import { installShield } from './main.ts';

// 페이지 쪽 방패(TAB-2 기대 동작 4, 결정 0041). 시험마다 같은 출처의 새 iframe에 싣는다(그 창의 Document 원형을 바꾸므로).
// 창이 초점을 잃은 신호는 시험 문서(바깥)의 입력란으로 초점을 옮겨 만든다. 그러면 iframe의 창에 신뢰된 blur가 오고 그 문서의
// hasFocus()가 거짓이 된다(실제 Chrome이 창이 초점을 잃을 때와 같은 신호, 2026-10-21 실험). 실제로 숨김이 되는 것(신뢰된
// visibilitychange)은 이 시험 브라우저에서 만들 수 없어 확장 전체 시험이 본다.

const retireEventName = 'browser-toolbox:retire';
const frames: HTMLIFrameElement[] = [];
const outside = document.createElement('input');
document.body.append(outside);

afterEach(() => {
  for (const frame of frames.splice(0)) frame.remove();
});

interface Shielded {
  readonly window: Window;
  readonly prototype: object;
  readonly events: string[];
  readonly input: HTMLInputElement;
  readonly arm: (on: boolean) => void;
}

// 방패를 실은 iframe. events는 페이지가 받은 창의 blur·focus와 visibilitychange, 입력란의 focusout이다(페이지가 방패 뒤에 건 듣기).
async function shielded(): Promise<Shielded> {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  frames.push(frame);
  const typed = frame.contentWindow;
  if (typed === null) throw new Error('iframe의 창이 없다.');
  const prototype: unknown = Reflect.get(Reflect.get(typed, 'Document') ?? {}, 'prototype');
  if (typeof prototype !== 'object' || prototype === null) throw new Error('Document 원형이 없다.');
  installShield(typed, prototype, retireEventName);
  const events: string[] = [];
  const doc = typed.document;
  const input = doc.createElement('input');
  doc.body.append(input);
  typed.addEventListener('blur', (event) => {
    if (event.target === typed) events.push(`blur:${String(event.isTrusted)}`);
  });
  typed.addEventListener('focus', (event) => {
    if (event.target === typed) events.push(`focus:${String(event.isTrusted)}`);
  });
  typed.onblur = () => events.push('onblur');
  doc.addEventListener('visibilitychange', (event) => {
    events.push(`visibilitychange:${String(event.isTrusted)}`);
  });
  input.addEventListener('focusout', () => events.push('focusout'));
  await Promise.resolve();
  return {
    window: typed,
    prototype,
    events,
    input,
    arm: (on) => {
      doc.dispatchEvent(new CustomEvent(armEventName, { detail: armDetail(on) }));
    },
  };
}

// 초점을 iframe의 입력란에 두었다가 바깥 문서로 옮긴다(iframe의 창이 초점을 잃음).
function leave(page: Shielded) {
  page.input.focus();
  outside.focus();
}

describe('페이지 쪽 방패', () => {
  it('켜지 않으면 아무것도 바꾸지 않는다: 창의 blur가 페이지에 닿고 hasFocus는 실제 값이다', async () => {
    const page = await shielded();
    page.input.focus();
    page.events.length = 0;
    outside.focus();
    expect(page.events).toContain('blur:true');
    expect(page.window.document.hasFocus()).toBe(false);
  });

  it('TAB-2.17 켜면 창이 초점을 잃어도 페이지는 blur를 받지 않고(듣기, 속성 처리기 모두) 초점이 있고 보인다고 읽는다', async () => {
    const page = await shielded();
    page.input.focus();
    page.arm(true);
    page.events.length = 0;
    outside.focus();
    expect(page.events.filter((event) => event.startsWith('blur') || event === 'onblur')).toEqual(
      [],
    );
    expect(page.window.document.hasFocus()).toBe(true);
    expect(page.window.document.visibilityState).toBe('visible');
    expect(page.window.document.hidden).toBe(false);
  });

  it('TAB-2.1 켜진 동안 창이 다시 초점을 얻어도(신뢰된 focus) 페이지에 전하지 않는다. 페이지는 초점을 잃은 적이 없다', async () => {
    const page = await shielded();
    page.arm(true);
    leave(page);
    page.events.length = 0;
    page.input.focus();
    expect(page.window.document.hasFocus()).toBe(true);
    expect(page.events.filter((event) => event.startsWith('focus:'))).toEqual([]);
  });

  it('입력란의 초점 이벤트와 페이지가 직접 보낸 blur는 막지 않는다', async () => {
    const page = await shielded();
    page.arm(true);
    page.input.focus();
    page.events.length = 0;
    outside.focus();
    expect(page.events).toContain('focusout');
    page.window.dispatchEvent(new FocusEvent('blur'));
    expect(page.events).toContain('blur:false');
  });

  it('끄면 원래 함수와 접근자로 돌아가고, 페이지가 마지막으로 본 것과 실제가 다르면 그 이벤트를 한 번 보낸다', async () => {
    const page = await shielded();
    const { prototype } = page;
    const original = Object.getOwnPropertyDescriptor(prototype, 'hasFocus');
    const visibility = Object.getOwnPropertyDescriptor(prototype, 'visibilityState');
    page.input.focus();
    page.arm(true);
    outside.focus();
    page.events.length = 0;
    page.arm(false);
    expect(Object.getOwnPropertyDescriptor(prototype, 'hasFocus')).toEqual(original);
    expect(Object.getOwnPropertyDescriptor(prototype, 'visibilityState')).toEqual(visibility);
    expect(page.window.document.hasFocus()).toBe(false);
    expect(page.events).toEqual(['blur:false', 'onblur']);
  });

  it('켤 때 페이지가 초점을 잃었다고 보고 있으면 focus를 보내 다시 읽게 한다', async () => {
    const page = await shielded();
    leave(page);
    page.events.length = 0;
    page.arm(true);
    expect(page.events).toEqual(['focus:false']);
    expect(page.window.document.hasFocus()).toBe(true);
  });

  it('켜진 동안 페이지가 다시 바꿔 끼운 것은 끌 때 그대로 둔다', async () => {
    const page = await shielded();
    page.arm(true);
    const own = () => false;
    Object.defineProperty(page.prototype, 'hasFocus', {
      configurable: true,
      writable: true,
      value: own,
    });
    page.arm(false);
    expect(Reflect.get(page.prototype, 'hasFocus')).toBe(own);
  });

  it('결정 0008 물러남 이벤트를 받으면 확인 없이 끈다. 그 뒤에 다시 켤 수 있다', async () => {
    const page = await shielded();
    page.input.focus();
    page.arm(true);
    page.window.document.dispatchEvent(new CustomEvent(retireEventName, { detail: 'token' }));
    page.events.length = 0;
    outside.focus();
    expect(page.events).toContain('blur:true');
    page.arm(true);
    expect(page.window.document.hasFocus()).toBe(true);
  });

  it('모양이 맞지 않는 켜기 지시는 버린다', async () => {
    const page = await shielded();
    leave(page);
    page.window.document.dispatchEvent(new CustomEvent(armEventName, { detail: 'on' }));
    page.window.document.dispatchEvent(new CustomEvent(armEventName, { detail: { on: true } }));
    expect(page.window.document.hasFocus()).toBe(false);
  });
});
