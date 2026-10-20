import { afterEach, describe, expect, it } from 'vitest';
import { v } from '../../contracts/index.ts';
import { createScope } from '../../dom/index.ts';
import { type AppError, type Result, appError, err, ok } from '../../shared/index.ts';
import type { Snapshot } from '../../storage/index.ts';
import { armEventName, nativeDetail, nativeEventName, parseArm } from './core/shield.ts';
import { hiddenCommand, pointCommand } from './feature.ts';
import { page } from './page.ts';

// 페이지 활성 상태 유지의 페이지 쪽(TAB-2, 결정 0041). 실행 틀이 이 탭에서 켜졌다고 할 때 시작한다.

const closers: (() => void)[] = [];
const emptySnapshot: Snapshot = { features: new Map(), sites: new Map() };

afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function start(topFrame: boolean) {
  const scope = createScope({ window, onError: () => undefined, isLive: () => true });
  closers.push(scope.close);
  const arms: boolean[] = [];
  const listen = (event: Event) => {
    const on = event instanceof CustomEvent ? parseArm(event.detail) : null;
    if (on !== null) arms.push(on);
  };
  document.addEventListener(armEventName, listen);
  closers.push(() => {
    document.removeEventListener(armEventName, listen);
  });
  const sent: unknown[] = [];
  // 서비스 워커 쪽이 보낸 명령에 답하는 함수(실행 틀처럼 내용을 그 명령의 스키마로 검증해 넘긴다).
  const answers = new Map<string, (payload: unknown) => Result<unknown, AppError>>();
  page.start(emptySnapshot, {
    window,
    document,
    scope,
    topFrame,
    find: () => {
      throw new Error('외부 화면 요소를 찾지 않는다.');
    },
    verify: () => {
      throw new Error('외부 화면 요소를 확인하지 않는다.');
    },
    send: (command, payload) => {
      sent.push({ name: command.name, payload });
      const value = v.safeParse(command.value, null);
      return Promise.resolve(value.success ? ok(value.output) : err(appError('unexpected', '답')));
    },
    answer: (command, handle) => {
      answers.set(command.name, (payload) => {
        const parsed = v.safeParse(command.payload, payload);
        return parsed.success ? handle(parsed.output) : err(appError('invalid-input', '내용'));
      });
    },
  });
  return { scope, arms, sent, answers };
}

describe('페이지 활성 상태 유지의 페이지 쪽', () => {
  it('TAB-2 기대 동작 4 시작하면 이 문서의 방패를 켜고, 범위가 닫히면 끈다(모든 프레임)', () => {
    const top = start(true);
    expect(top.arms).toEqual([true]);
    top.scope.close();
    expect(top.arms).toEqual([true, false]);
    const inner = start(false);
    expect(inner.arms).toEqual([true]);
  });

  it('TAB-2.18 최상위 프레임은 방패가 알린 실제 숨김을 서비스 워커 쪽에 넘긴다. 모양이 틀린 알림은 버린다', async () => {
    const top = start(true);
    document.dispatchEvent(new CustomEvent(nativeEventName, { detail: nativeDetail(true) }));
    document.dispatchEvent(new CustomEvent(nativeEventName, { detail: 'hidden' }));
    await Promise.resolve();
    expect(top.sent).toEqual([{ name: hiddenCommand.name, payload: { hidden: true } }]);
  });

  it('TAB-2.11 최상위 프레임은 가짜 입력을 보낼 안전한 두 점으로 답한다. 지난번 두 점이 안전하면 그대로다', () => {
    const top = start(true);
    const answer = top.answers.get(pointCommand.name);
    if (answer === undefined) throw new Error('점을 묻는 명령에 답하지 않는다.');
    const first = answer({ keep: null });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value).toHaveProperty('pair.first');
    const keep = { first: { x: 5, y: 5 }, second: { x: 6, y: 5 } };
    expect(answer({ keep })).toEqual(ok({ pair: keep }));
  });

  it('iframe에서는 방패만 켜고 숨김을 넘기거나 점에 답하지 않는다', async () => {
    const inner = start(false);
    document.dispatchEvent(new CustomEvent(nativeEventName, { detail: nativeDetail(true) }));
    await Promise.resolve();
    expect(inner.sent).toEqual([]);
    expect(inner.answers.size).toBe(0);
  });
});
