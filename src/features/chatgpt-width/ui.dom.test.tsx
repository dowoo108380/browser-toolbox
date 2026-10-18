import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../../storage/index.ts';
import { ui } from './ui.tsx';

// 팝업에서 대화 열·작성란의 최대 너비를 정하는 숫자 칸(결정 0030, 0036). 팝업 없이 조각만 그린다. 저장된 설정과 그 세대
// 번호(revision), 저장의 응답은 시험이 정한다. ↑↓로 한 단계씩 바뀌는 것은 실제 키 입력이라 확장 전체 시험
// (tests/e2e/chatgpt-width.spec.ts)이 본다.

const container = document.createElement('div');
document.body.append(container);

afterEach(() => {
  render(null, container);
});

const stored = (width?: number): Snapshot => ({
  features: new Map(
    width === undefined ? [] : [['chatgpt-width', { enabled: true, width }] as const],
  ),
  sites: new Map(),
});

// 처음 그릴 때 저장된 설정의 세대 번호. 저장된 설정이 바뀔 때마다(다시 그리기) 1씩 는다고 본다.
const firstRevision = 1;

async function show(
  snapshot: Snapshot,
  { disabled = false, saved = true }: { disabled?: boolean; saved?: boolean } = {},
) {
  let revision: number | null = firstRevision;
  // 붙잡지 않은 저장은 곧바로 답한다. 저장했으면 그 값의 세대 번호는 지금 것의 다음이다.
  const save = vi.fn<(patch: Readonly<Record<string, unknown>>) => Promise<number | null>>(() =>
    Promise.resolve(saved ? (revision ?? 0) + 1 : null),
  );
  const draw = (next: Snapshot, at: number | null) =>
    act(() => {
      revision = at;
      render(ui.render(next, { revision: at, disabled, save }), container);
    });
  await draw(snapshot, revision);
  const input = () => {
    const found = container.querySelector('input');
    if (found === null) throw new Error('숫자 칸이 없다.');
    return found;
  };
  return {
    save,
    input,
    // 저장된 설정이 바뀐 것처럼 다시 그린다. 세대 번호를 주지 않으면 지금 것의 다음이다(null이면 기본값으로 대신 씀).
    redraw: (next: Snapshot, at: number | null = (revision ?? 0) + 1) => draw(next, at),
    // 글을 쓴다(input). 정하지는 않는다.
    type: (text: string) =>
      act(() => {
        input().value = text;
        input().dispatchEvent(new Event('input', { bubbles: true }));
      }),
    // 정한다(Enter, 초점을 옮김, ↑↓에 Chromium이 내는 change).
    commit: () =>
      act(() => {
        input().dispatchEvent(new Event('change', { bubbles: true }));
      }),
    escape: async () => {
      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      await act(() => {
        input().dispatchEvent(event);
      });
      return event.defaultPrevented;
    },
    // 저장 응답을 붙잡는다. 그동안 저장된 값은 다시 그리기 전까지 그대로다. 돌려준 함수는 index번째 저장에 답하고(저장한
    // 값의 세대 번호, 저장하지 못했으면 null) 그 결과를 받은 조각의 처리까지 끝낸다.
    holdSaves: () => {
      const answers: ((written: number | null) => void)[] = [];
      save.mockImplementation(
        () =>
          new Promise<number | null>((resolve) => {
            answers.push(resolve);
          }),
      );
      return (index: number, written: number | null) =>
        act(async () => {
          answers[index]?.(written);
          await Promise.resolve();
        });
    },
    error: () => container.querySelector('.error')?.textContent ?? null,
    describedBy: () => input().getAttribute('aria-describedby'),
  };
}

describe('GPT-2 팝업의 너비 칸(결정 0030)', () => {
  it('저장된 너비(없으면 기본 1200)를 보이고, 이름과 범위가 칸에 이어져 있다', async () => {
    const field = await show(stored());
    expect(field.input().value).toBe('1200');
    expect(field.input().labels?.[0]?.textContent).toBe('최대 너비(px)');
    expect([field.input().min, field.input().max, field.input().step]).toEqual([
      '640',
      '3840',
      '10',
    ]);
    const hint = document.getElementById(field.describedBy() ?? '');
    expect(hint?.textContent).toBe(
      '640–3840 사이의 정수. 바꾸면 열린 chatgpt.com 탭에 바로 걸린다.',
    );
    await field.redraw(stored(1600));
    expect(field.input().value).toBe('1600');
  });

  it('GPT-2.1 쓰는 동안은 저장하지 않고, 정하면 범위 안의 정수만 저장한다', async () => {
    const field = await show(stored(1200));
    await field.type('1500');
    expect(field.save).not.toHaveBeenCalled();
    await field.commit();
    expect(field.save).toHaveBeenCalledWith({ width: 1500 });
    // 저장한 값이 돌아오기 전에는 쓴 글을, 돌아온 뒤에는 저장된 값을 보인다.
    expect(field.input().value).toBe('1500');
    await field.redraw(stored(1500));
    expect(field.input().value).toBe('1500');
    // 저장된 값과 같은 값은 다시 보내지 않는다.
    await field.commit();
    expect(field.save).toHaveBeenCalledTimes(1);
  });

  it('범위 밖이거나 정수가 아니면 저장하지 않고 이유를 칸에 잇는다', async () => {
    const field = await show(stored(1200));
    for (const text of ['639', '3841', '1200.5', '', '1e3']) {
      await field.type(text);
      await field.commit();
      expect(field.error(), text).toBe(
        '640–3840 사이의 정수만 쓸 수 있어 저장하지 않았다. Esc를 누르면 저장된 값으로 돌아간다.',
      );
      expect(field.input().getAttribute('aria-invalid'), text).toBe('true');
      expect(field.describedBy()?.split(' ')[0], text).toBe('chatgpt-width-width-error');
    }
    expect(field.save).not.toHaveBeenCalled();
    // 다시 쓰기 시작하면 이유를 거둔다.
    await field.type('15');
    expect(field.error()).toBeNull();
    expect(field.input().getAttribute('aria-invalid')).toBe('false');
  });

  it('Esc는 쓰던 글을 버리고 저장된 값으로 돌아간다. 쓰던 글이 없으면 Esc를 가로채지 않는다', async () => {
    const field = await show(stored(1200));
    expect(await field.escape()).toBe(false);
    await field.type('500');
    await field.commit();
    expect(await field.escape()).toBe(true);
    expect(field.input().value).toBe('1200');
    expect(field.error()).toBeNull();
    await field.type('1400');
    expect(await field.escape()).toBe(true);
    expect(field.input().value).toBe('1200');
    expect(field.save).not.toHaveBeenCalled();
  });

  it('COM-3 기대 동작 3 저장 응답을 기다리는 동안 바꿨다가 되돌리면 되돌린 값도 저장해, 마지막으로 정한 값이 남는다', async () => {
    const field = await show(stored(1200));
    const answer = field.holdSaves();
    await field.type('1500');
    await field.commit();
    await field.type('1200');
    await field.commit();
    expect(field.save.mock.calls).toEqual([[{ width: 1500 }], [{ width: 1200 }]]);
    expect(field.input().value).toBe('1200');

    // 앞 저장이 먼저 끝나 저장된 값이 잠깐 1500이 되어도 칸은 마지막으로 정한 값을 보인다.
    await answer(0, 2);
    await field.redraw(stored(1500), 2);
    expect(field.input().value).toBe('1200');
    // 마지막으로 정한 값과 같은 값은 다시 보내지 않는다.
    await field.type('1200');
    await field.commit();
    expect(field.save).toHaveBeenCalledTimes(2);

    // 마지막 응답이 와도 저장된 값(세대 2)이 마지막 저장(세대 3)을 담기 전에는 정한 값이다.
    await answer(1, 3);
    expect(field.input().value).toBe('1200');
    await field.redraw(stored(1200), 3);
    expect(field.input().value).toBe('1200');
    // 저장이 끝난 뒤 다른 화면이 바꾼 값은 따른다.
    await field.redraw(stored(1800), 4);
    expect(field.input().value).toBe('1800');
  });

  it('COM-3 기대 동작 3 결정 0036 저장이 바뀜 알림까지 온 뒤 응답이 늦는 사이 다른 화면이 바꾸면, 마지막 응답 때 최신 저장값을 보이고 앞에 정한 값을 다시 정하면 보낸다', async () => {
    const field = await show(stored(1200));
    const answer = field.holdSaves();
    await field.type('1500');
    await field.commit();
    // 이 칸의 저장(세대 2)이 담긴 알림, 이어 다른 화면이 바꾼 값(세대 3)의 알림이 응답보다 먼저 온다.
    await field.redraw(stored(1500), 2);
    await field.redraw(stored(1800), 3);
    expect(field.input().value).toBe('1500');

    await answer(0, 2);
    expect(field.input().value).toBe('1800');
    await field.type('1500');
    await field.commit();
    expect(field.save.mock.calls).toEqual([[{ width: 1500 }], [{ width: 1500 }]]);
  });

  it('COM-3 기대 동작 3 결정 0036 응답이 바뀜 알림보다 먼저 오면 그 알림까지 정한 값을 보이고, 그보다 먼저 쓰인 다른 화면의 값에는 흔들리지 않는다', async () => {
    const field = await show(stored(1200));
    const answer = field.holdSaves();
    await field.type('1500');
    await field.commit();
    // 다른 화면이 1800을 먼저 썼고(세대 2) 이 칸의 저장이 그 뒤에 저장되었다(세대 3). 응답이 두 알림보다 먼저 온다.
    await answer(0, 3);
    expect(field.input().value).toBe('1500');
    await field.redraw(stored(1800), 2);
    expect(field.input().value).toBe('1500');
    await field.redraw(stored(1500), 3);
    expect(field.input().value).toBe('1500');
    // 저장된 값과 같은 값은 다시 보내지 않는다.
    await field.commit();
    expect(field.save).toHaveBeenCalledTimes(1);
  });

  it('결정 0036 응답의 차례가 바뀌어도(뒤 저장의 응답이 먼저) 세대 번호가 가장 큰 저장이 담길 때까지 그 값을 보인다', async () => {
    const field = await show(stored(1200));
    const answer = field.holdSaves();
    await field.type('1500');
    await field.commit();
    await field.type('1300');
    await field.commit();
    await answer(1, 3);
    await answer(0, 2);
    expect(field.input().value).toBe('1300');
    await field.redraw(stored(1500), 2);
    expect(field.input().value).toBe('1300');
    await field.redraw(stored(1300), 3);
    expect(field.input().value).toBe('1300');
    await field.redraw(stored(1800), 4);
    expect(field.input().value).toBe('1800');
  });

  it('결정 0036 기본값으로 대신 쓰는 동안(세대 번호 없음)은 저장된 값을 보이고, 그 뒤 고쳐 쓴 값의 세대 번호가 앞 저장보다 작아도 따른다', async () => {
    const field = await show(stored(1200));
    const answer = field.holdSaves();
    await field.type('1500');
    await field.commit();
    await answer(0, 2);
    expect(field.input().value).toBe('1500');
    await field.redraw(stored(), null);
    expect(field.input().value).toBe('1200');
    // 시계가 뒤로 간 채 고쳐 쓴 값(세대 1).
    await field.redraw(stored(1300), 1);
    expect(field.input().value).toBe('1300');
  });

  it('COM-3 기대 동작 3 앞 저장이 실패해도 그 뒤에 정한 값을 보이고, 마지막 저장이 실패하면 저장된 값으로 돌아간다', async () => {
    const field = await show(stored(1200));
    const answer = field.holdSaves();
    await field.type('1500');
    await field.commit();
    await field.type('1600');
    await field.commit();
    await answer(0, null);
    expect(field.input().value).toBe('1600');
    await answer(1, null);
    expect(field.input().value).toBe('1200');
  });

  it('COM-3 기대 동작 3 결정 0036 마지막 저장이 실패하면, 앞 저장이 아직 담기지 않았을 때는 그 값으로, 담겼으면 저장된 값으로 돌아간다', async () => {
    const field = await show(stored(1200));
    const answer = field.holdSaves();
    await field.type('1500');
    await field.commit();
    await field.type('1600');
    await field.commit();
    await answer(0, 2);
    await answer(1, null);
    expect(field.input().value).toBe('1500');
    await field.redraw(stored(1500), 2);
    expect(field.input().value).toBe('1500');
    await field.redraw(stored(1700), 3);
    expect(field.input().value).toBe('1700');
  });

  it('COM-3 기대 동작 3 저장하지 못하면 저장된 값으로 돌아간다', async () => {
    const field = await show(stored(1200), { saved: false });
    await field.type('1500');
    await field.commit();
    await vi.waitFor(() => {
      expect(field.input().value).toBe('1200');
    });
  });

  it('N-12 서비스 워커가 깨어나기 전에는 막는다', async () => {
    const field = await show(stored(1200), { disabled: true });
    expect(field.input().disabled).toBe(true);
  });
});
