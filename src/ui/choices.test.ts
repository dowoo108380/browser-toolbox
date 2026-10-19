import { describe, expect, it } from 'vitest';
import {
  type Ending,
  type Sent,
  accepted,
  answered,
  chose,
  chosenValues,
  noChoices,
} from './choices.ts';

// 화면 조각이 정한 값과 그 저장의 기억(결정 0036, 0037). 팝업 없이 너비 칸 하나를 흉내 낸다: 읽기 도우미가 받아들인
// 너비와 그 세대 번호, 칸이 정한 값, 저장의 응답(그 저장이 끝난 방법: 저장한 값의 세대 번호, 'unwritten', 'unknown')은
// 시험이 정한 차례로 온다.

const featureId = 'chatgpt-width';

function field(width = 1200, revision: number | null = 1) {
  let choices = accepted(noChoices, revision);
  let stored = { enabled: true, width };
  const sent: Sent[] = [];
  return {
    // 칸에 보이는 너비.
    shown: () => chosenValues(choices, featureId).get('width') ?? stored.width,
    // 너비를 정한다. 저장을 보냈으면 참이다.
    choose: (next: number) => {
      const result = chose(choices, featureId, stored, { width: next });
      if (result === null) return false;
      choices = result.choices;
      sent.push(result.sent);
      return true;
    },
    // index번째로 보낸 저장의 응답이 온다.
    answer: (index: number, ending: Ending) => {
      const which = sent[index];
      if (which === undefined) throw new Error(`${String(index)}번째 저장이 없다.`);
      choices = answered(choices, which, ending);
    },
    // 읽기 도우미가 저장된 너비(없으면 기본값)와 그 세대 번호를 받아들였다(null이면 기본값으로 대신 씀).
    accept: (next: number | undefined, at: number | null) => {
      stored = { enabled: true, width: next ?? 1200 };
      choices = accepted(choices, at);
    },
    sent: () => sent.map(({ patch }) => patch),
  };
}

describe('결정 0036 결정 0037 화면 조각이 정한 값과 그 저장', () => {
  it('보이는 값과 다른 값만 보내고, 응답을 기다리는 동안과 보이는 설정이 그 저장을 담기 전까지 정한 값을 보인다', () => {
    const width = field(1200, 1);
    expect(width.choose(1200)).toBe(false);
    expect(width.choose(1500)).toBe(true);
    expect(width.shown()).toBe(1500);
    // 정한 값과 같은 값은 다시 보내지 않는다.
    expect(width.choose(1500)).toBe(false);
    width.answer(0, 2);
    expect(width.shown()).toBe(1500);
    width.accept(1500, 2);
    expect(width.shown()).toBe(1500);
    expect(width.choose(1500)).toBe(false);
    // 저장이 담긴 뒤 다른 화면이 바꾼 값은 따른다.
    width.accept(1800, 3);
    expect(width.shown()).toBe(1800);
    expect(width.sent()).toEqual([{ width: 1500 }]);
  });

  it('COM-3 기대 동작 3 저장 응답을 기다리는 동안 바꿨다가 되돌리면 되돌린 값도 보내고, 앞 저장이 먼저 담겨도 마지막으로 정한 값을 보인다', () => {
    const width = field(1200, 1);
    width.choose(1500);
    expect(width.choose(1200)).toBe(true);
    expect(width.shown()).toBe(1200);

    width.answer(0, 2);
    width.accept(1500, 2);
    expect(width.shown()).toBe(1200);
    expect(width.choose(1200)).toBe(false);

    // 마지막 응답이 와도 보이는 설정(세대 2)이 마지막 저장(세대 3)을 담기 전에는 정한 값이다.
    width.answer(1, 3);
    expect(width.shown()).toBe(1200);
    width.accept(1200, 3);
    expect(width.shown()).toBe(1200);
    width.accept(1800, 4);
    expect(width.shown()).toBe(1800);
    expect(width.sent()).toEqual([{ width: 1500 }, { width: 1200 }]);
  });

  it('COM-3 기대 동작 3 저장이 바뀜 알림까지 온 뒤 응답이 늦는 사이 다른 화면이 바꾸면, 마지막 응답 때 최신 저장값을 보이고 앞에 정한 값을 다시 정하면 보낸다', () => {
    const width = field(1200, 1);
    width.choose(1500);
    width.accept(1500, 2);
    width.accept(1800, 3);
    expect(width.shown()).toBe(1500);

    width.answer(0, 2);
    expect(width.shown()).toBe(1800);
    expect(width.choose(1500)).toBe(true);
  });

  it('COM-3 기대 동작 3 저장 응답이 바뀜 알림보다 먼저 오면 그 알림까지 정한 값을 보이고, 그보다 먼저 쓰인 다른 화면의 값에는 흔들리지 않는다', () => {
    const width = field(1200, 1);
    width.choose(1500);
    // 다른 화면이 1800을 먼저 썼고(세대 2) 이 칸의 저장이 그 뒤에 저장되었다(세대 3).
    width.answer(0, 3);
    expect(width.shown()).toBe(1500);
    width.accept(1800, 2);
    expect(width.shown()).toBe(1500);
    // 그사이 보이는 설정과 같은 값으로 되돌려도 보낸다.
    expect(width.choose(1800)).toBe(true);
    width.answer(1, 4);
    width.accept(1500, 3);
    expect(width.shown()).toBe(1800);
    width.accept(1800, 4);
    expect(width.shown()).toBe(1800);
    expect(width.choose(1800)).toBe(false);
  });

  it('응답의 차례가 바뀌어도(뒤 저장의 응답이 먼저) 세대 번호가 가장 큰 저장이 담길 때까지 그 값을 보인다', () => {
    const width = field(1200, 1);
    width.choose(1500);
    width.choose(1300);
    width.answer(1, 3);
    width.answer(0, 2);
    expect(width.shown()).toBe(1300);
    width.accept(1500, 2);
    expect(width.shown()).toBe(1300);
    width.accept(1300, 3);
    expect(width.shown()).toBe(1300);
    width.accept(1800, 4);
    expect(width.shown()).toBe(1800);
  });

  it('COM-3 기대 동작 3 앞 저장이 실패해도 그 뒤에 정한 값을 보이고, 마지막 저장이 실패하면 저장된 값으로 돌아간다', () => {
    const width = field(1200, 1);
    width.choose(1500);
    width.choose(1600);
    width.answer(0, 'unwritten');
    expect(width.shown()).toBe(1600);
    width.answer(1, 'unwritten');
    expect(width.shown()).toBe(1200);
    expect(width.choose(1200)).toBe(false);
  });

  it('COM-3 기대 동작 3 마지막 저장이 실패하면, 앞 저장이 아직 담기지 않았을 때는 그 값으로, 담겼으면 저장된 값으로 돌아간다', () => {
    const width = field(1200, 1);
    width.choose(1500);
    width.choose(1600);
    width.answer(0, 2);
    width.answer(1, 'unwritten');
    expect(width.shown()).toBe(1500);
    width.accept(1500, 2);
    expect(width.shown()).toBe(1500);
    width.accept(1700, 3);
    expect(width.shown()).toBe(1700);
  });

  it('기본값으로 대신 쓰는 동안(세대 번호 없음)은 저장된 값을 보이고, 그 뒤 고쳐 쓴 값의 세대 번호가 앞 저장보다 작아도 따른다', () => {
    const width = field(1200, 1);
    width.choose(1500);
    width.answer(0, 2);
    expect(width.shown()).toBe(1500);
    width.accept(undefined, null);
    expect(width.shown()).toBe(1200);
    // 시계가 뒤로 간 채 고쳐 쓴 값(세대 1).
    width.accept(1300, 1);
    expect(width.shown()).toBe(1300);
  });

  it('결정 0036 응답을 기다리는 동안 기본값으로 대신 쓰게 되면 칸은 저장된 값을 보이고, 그 전에 보낸 저장의 성공이 시계가 뒤로 간 채 고쳐 쓴 값 뒤에 와도 버리며, 앞에 정한 값을 다시 정하면 보낸다', () => {
    // 저장값 1200·세대 1000에서 1500을 보내고 응답을 기다린다.
    const width = field(1200, 1000);
    width.choose(1500);
    width.accept(undefined, null);
    expect(width.shown()).toBe(1200);
    // 시계가 뒤로 간 채 고쳐 쓴 값(세대 100). 그 뒤 앞 저장의 성공(세대 1001)이 늦게 온다.
    width.accept(1200, 100);
    expect(width.shown()).toBe(1200);
    width.answer(0, 1001);
    expect(width.shown()).toBe(1200);

    expect(width.choose(1500)).toBe(true);
    expect(width.shown()).toBe(1500);
    width.answer(1, 101);
    expect(width.shown()).toBe(1500);
    width.accept(1500, 101);
    expect(width.shown()).toBe(1500);
    // 잊은 저장이 기다리는 수에 남지 않았다: 이 칸의 저장이 담긴 뒤 다른 화면이 바꾼 값을 따른다.
    width.accept(1800, 102);
    expect(width.shown()).toBe(1800);
  });

  it('결정 0036 잊을 때 아직 담기지 않은 저장이 있었으면, 그 뒤에 보낸 저장이 될 때까지 정한 값은 보이는 값과 같아도 보낸다', () => {
    const width = field(1200, 1000);
    width.choose(1500);
    width.accept(undefined, null);
    width.accept(1200, 100);
    // 잊은 1500이 고쳐 쓴 값 뒤에 담길 수 있어, 보이는 1200과 같아도 보낸다. 실패하면 그대로다.
    expect(width.choose(1200)).toBe(true);
    width.answer(1, 'unwritten');
    expect(width.shown()).toBe(1200);
    expect(width.choose(1200)).toBe(true);
    width.answer(2, 101);
    width.accept(1200, 101);
    expect(width.choose(1200)).toBe(false);
    expect(width.sent()).toEqual([{ width: 1500 }, { width: 1200 }, { width: 1200 }]);
  });

  it('결정 0036 잊은 저장이 고쳐 쓴 값 뒤에 담기면 칸은 그 값을 보이고, 그 뒤 정한 값은 보이는 값과 견준다', () => {
    const width = field(1200, 1000);
    width.choose(1500);
    width.accept(undefined, null);
    // 서비스 워커가 손상을 읽은 뒤 1500을 저장했다(그 값이 고쳐 쓴 값이다).
    width.accept(1500, 100);
    width.answer(0, 100);
    expect(width.shown()).toBe(1500);
    expect(width.choose(1200)).toBe(true);
    width.answer(1, 101);
    width.accept(1200, 101);
    expect(width.choose(1200)).toBe(false);
  });

  it('결정 0036 잊을 때 보낸 저장이 모두 담겼으면 그 뒤에는 보이는 값과 같은 값을 보내지 않는다', () => {
    const width = field(1200, 1);
    width.choose(1500);
    width.answer(0, 2);
    width.accept(1500, 2);
    width.accept(undefined, null);
    expect(width.shown()).toBe(1200);
    expect(width.choose(1200)).toBe(false);
  });

  it('결정 0036 기본값으로 대신 쓰는 동안 보낸 저장은 응답이 와도 고쳐 쓴 값이 그것을 담을 때까지 그 값을 보이고, 실패하면 저장된 값이다', () => {
    const width = field(1200, null);
    width.choose(1500);
    width.answer(0, 7);
    expect(width.shown()).toBe(1500);
    // 고쳐 쓴 값(세대 5)은 이 저장보다 앞이다.
    width.accept(1200, 5);
    expect(width.shown()).toBe(1500);
    width.accept(1500, 7);
    width.accept(1800, 8);
    expect(width.shown()).toBe(1800);

    const failed = field(1200, null);
    failed.choose(1500);
    failed.answer(0, 'unwritten');
    expect(failed.shown()).toBe(1200);
  });

  it('기능과 설정 항목마다 따로 센다. 정한 값 가운데 하나라도 보이는 값과 다르면 함께 보낸다', () => {
    let choices = accepted(noChoices, 1);
    const stored = { enabled: true, width: 1200, size: 3 };
    const first = chose(choices, 'a', stored, { width: 1500 });
    if (first === null) throw new Error('보내야 한다.');
    choices = first.choices;
    expect(chosenValues(choices, 'a')).toEqual(new Map([['width', 1500]]));
    // 다른 기능과 다른 설정 항목은 저장된 값을 보인다.
    expect(chosenValues(choices, 'b')).toEqual(new Map());
    expect(chose(choices, 'b', stored, { width: 1200 })).toBeNull();

    // 같은 값(width)과 다른 값(size)을 함께 정하면 둘 다 보낸다.
    const both = chose(choices, 'a', stored, { width: 1500, size: 4 });
    expect(both?.sent.patch).toEqual({ width: 1500, size: 4 });
    if (both === null) throw new Error('보내야 한다.');
    choices = answered(both.choices, first.sent, 2);
    expect(chosenValues(choices, 'a')).toEqual(
      new Map([
        ['width', 1500],
        ['size', 4],
      ]),
    );
    choices = answered(choices, both.sent, 3);
    choices = accepted(choices, 2);
    // 세대 2는 첫 저장(width)만 담았다. 둘째 저장(세대 3)의 두 값은 아직 보인다.
    expect(chosenValues(choices, 'a')).toEqual(
      new Map([
        ['width', 1500],
        ['size', 4],
      ]),
    );
    choices = accepted(choices, 3);
    expect(chosenValues(choices, 'a')).toEqual(new Map());
  });

  it('결정 0036 알 수 없게 끝난 저장 뒤에는 칸이 저장된 값을 보이고, 그 값을 다시 정해도 보내며, 그 뒤에 보낸 저장이 되면 다시 보이는 값과 견준다', () => {
    const width = field(1200, 1);
    width.choose(1500);
    width.answer(0, 'unknown');
    expect(width.shown()).toBe(1200);
    // 앞의 1500이 나중에 저장될 수 있어 보이는 1200과 같아도 보낸다. 그 저장이 실패하거나 알 수 없게 끝나도 그대로다.
    expect(width.choose(1200)).toBe(true);
    width.answer(1, 'unwritten');
    expect(width.choose(1200)).toBe(true);
    width.answer(2, 'unknown');
    expect(width.choose(1200)).toBe(true);
    width.answer(3, 2);
    width.accept(1200, 2);
    expect(width.choose(1200)).toBe(false);
    expect(width.sent()).toEqual([
      { width: 1500 },
      { width: 1200 },
      { width: 1200 },
      { width: 1200 },
    ]);
  });

  it('결정 0036 저장하지 않음으로 끝난 저장 뒤에는 보이는 값과 같은 값을 보내지 않는다', () => {
    const width = field(1200, 1);
    width.choose(1500);
    width.answer(0, 'unwritten');
    expect(width.shown()).toBe(1200);
    expect(width.choose(1200)).toBe(false);
  });

  it('결정 0036 알 수 없게 끝난 저장이 나중에 담기면 칸은 그 값을 보이고, 그 뒤에 보낸 저장이 될 때까지는 같은 값도 보낸다(담긴 것이 그 저장인지 가를 수 없다)', () => {
    const width = field(1200, 1);
    width.choose(1500);
    width.answer(0, 'unknown');
    width.accept(1500, 2);
    expect(width.shown()).toBe(1500);
    expect(width.choose(1500)).toBe(true);
    width.answer(1, 3);
    width.accept(1500, 3);
    expect(width.choose(1500)).toBe(false);
  });

  it('결정 0036 응답보다 바뀜 알림이 먼저 와 담긴 뒤 알 수 없게 끝나면 칸은 저장된 값(그 저장의 값)을 보인다', () => {
    const width = field(1200, 1);
    width.choose(1500);
    width.accept(1500, 2);
    expect(width.shown()).toBe(1500);
    width.answer(0, 'unknown');
    expect(width.shown()).toBe(1500);
    expect(width.choose(1500)).toBe(true);
  });

  it('결정 0036 알 수 없게 끝난 저장보다 뒤에 보낸 저장이 되면, 두 응답이 어느 차례로 와도 그 뒤로는 보이는 값과 견준다', () => {
    for (const unknownFirst of [true, false]) {
      const width = field(1200, 1);
      width.choose(1500);
      width.choose(1300);
      if (unknownFirst) width.answer(0, 'unknown');
      width.answer(1, 3);
      if (!unknownFirst) width.answer(0, 'unknown');
      // 1500은 1300보다 먼저 저장되었거나 끝내 저장되지 않는다. 칸은 1300이 담길 때까지 그 값이다.
      expect(width.shown()).toBe(1300);
      width.accept(1300, 3);
      expect(width.choose(1300)).toBe(false);
    }
  });

  it('결정 0036 알 수 없게 끝난 저장보다 앞에 보낸 저장의 성공이 늦게 와도 알 수 없음은 남는다', () => {
    const width = field(1200, 1);
    width.choose(1500);
    width.choose(1300);
    // 뒤 저장(1300)이 먼저 알 수 없게 끝나고, 앞 저장(1500)의 성공이 늦게 온다.
    width.answer(1, 'unknown');
    width.answer(0, 2);
    expect(width.shown()).toBe(1500);
    width.accept(1500, 2);
    // 1300이 아직 저장될 수 있어 보이는 1500과 같아도 보낸다.
    expect(width.choose(1500)).toBe(true);
  });

  it('결정 0036 알 수 없게 끝난 저장이 있던 항목은 기본값으로 대신 써 잊은 뒤에도, 그 뒤에 보낸 저장이 될 때까지 같은 값을 보낸다', () => {
    const width = field(1200, 1);
    width.choose(1500);
    width.answer(0, 'unknown');
    width.accept(undefined, null);
    width.accept(1200, 2);
    expect(width.choose(1200)).toBe(true);
    width.answer(1, 3);
    width.accept(1200, 3);
    expect(width.choose(1200)).toBe(false);
  });

  it('결정 0036 잊은 저장의 응답은 알 수 없음이나 저장하지 않음으로 와도 버리고, 잊을 때 정한 늘 보내기는 그 뒤에 보낸 저장이 될 때까지 남는다', () => {
    for (const ending of ['unknown', 'unwritten'] as const) {
      const width = field(1200, 1);
      width.choose(1500);
      width.accept(undefined, null);
      width.accept(1200, 2);
      width.answer(0, ending);
      expect(width.shown()).toBe(1200);
      expect(width.choose(1200)).toBe(true);
      width.answer(1, 3);
      width.accept(1200, 3);
      expect(width.choose(1200)).toBe(false);
    }
  });

  it('결정 0036 기본값으로 대신 쓰는 동안 보낸 저장이 알 수 없게 끝나면 칸은 저장된 값을 보이고 같은 값도 보낸다', () => {
    const width = field(1200, null);
    width.choose(1500);
    width.answer(0, 'unknown');
    expect(width.shown()).toBe(1200);
    width.accept(1200, 5);
    expect(width.choose(1200)).toBe(true);
  });

  it('결정 0036 함께 정한 항목이 알 수 없게 끝나면 모두 늘 보내고, 그 뒤에 보낸 저장에 든 항목만 다시 보이는 값과 견준다', () => {
    let choices = accepted(noChoices, 1);
    const stored = { enabled: true, width: 1200, size: 3 };
    const both = chose(choices, 'a', stored, { width: 1500, size: 4 });
    if (both === null) throw new Error('보내야 한다.');
    choices = answered(both.choices, both.sent, 'unknown');
    const width = chose(choices, 'a', stored, { width: 1200 });
    if (width === null) throw new Error('보내야 한다.');
    expect(chose(choices, 'a', stored, { size: 3 })).not.toBeNull();
    choices = answered(width.choices, width.sent, 2);
    choices = accepted(choices, 2);
    expect(chose(choices, 'a', stored, { width: 1200 })).toBeNull();
    expect(chose(choices, 'a', stored, { size: 3 })).not.toBeNull();
    // 다른 기능은 흔들리지 않는다.
    expect(chose(choices, 'b', stored, { size: 3 })).toBeNull();
  });
});
