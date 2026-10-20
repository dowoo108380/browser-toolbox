import { describe, expect, it } from 'vitest';
import { type Step, runMachine } from './machine.ts';

// 사건은 이름표, 상태는 받은 사건의 차례, 할 일은 [사건, 차례]다.
interface Event {
  readonly name: string;
}
const record = (state: readonly string[], event: Event): Step<readonly string[], string> => ({
  state: [...state, event.name],
  effects: [`${event.name}:1`, `${event.name}:2`],
});

describe('상태 기계 도우미(runMachine)', () => {
  it('사건마다 전이한 상태를 남기고 그 할 일을 차례로 한다', () => {
    const done: string[] = [];
    const machine = runMachine<readonly string[], Event, string>([], record, (effect) => {
      done.push(effect);
    });
    machine.dispatch({ name: 'a' });
    machine.dispatch({ name: 'b' });
    expect(machine.state()).toEqual(['a', 'b']);
    expect(done).toEqual(['a:1', 'a:2', 'b:1', 'b:2']);
  });

  it('할 일 도중에 넣은 사건은 지금 사건의 할 일을 모두 마친 뒤 처리한다(run-to-completion)', () => {
    const done: string[] = [];
    const machine = runMachine<readonly string[], Event, string>([], record, (effect) => {
      done.push(effect);
      if (effect === 'a:1') machine.dispatch({ name: 'b' });
    });
    machine.dispatch({ name: 'a' });
    expect(done).toEqual(['a:1', 'a:2', 'b:1', 'b:2']);
    expect(machine.state()).toEqual(['a', 'b']);
  });

  it('할 일이 던져도 다음 사건은 다시 처리한다', () => {
    const done: string[] = [];
    const machine = runMachine<readonly string[], Event, string>([], record, (effect) => {
      if (effect === 'a:1') throw new Error('할 일 실패');
      done.push(effect);
    });
    expect(() => {
      machine.dispatch({ name: 'a' });
    }).toThrow('할 일 실패');
    machine.dispatch({ name: 'b' });
    expect(done).toEqual(['b:1', 'b:2']);
    expect(machine.state()).toEqual(['a', 'b']);
  });
});
