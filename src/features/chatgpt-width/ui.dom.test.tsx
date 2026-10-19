import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../../storage/index.ts';
import { ui } from './ui.tsx';

// 팝업에서 대화 열·작성란의 최대 너비를 정하는 숫자 칸(결정 0030). 팝업 없이 조각만 그린다. 저장된 설정과, 팝업이 넘기는
// 정했지만 아직 담기지 않은 값은 시험이 정한다. 정한 값을 보낼지와 응답·바뀜 알림의 차례는 팝업의 기억이 맞추므로
// ui/choices.test.ts와 연결 시험(tests/integration/popup-width.dom.test.ts)이 본다. ↑↓로 한 단계씩 바뀌는 것과 칸이 없어지기
// 전의 change는 실제 키 입력이라 확장 전체 시험(tests/e2e/chatgpt-width.spec.ts)이 본다.

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

async function show(
  snapshot: Snapshot,
  {
    disabled = false,
    chosen = new Map(),
  }: { disabled?: boolean; chosen?: ReadonlyMap<string, unknown> } = {},
) {
  const choose = vi.fn<(patch: Readonly<Record<string, unknown>>) => void>();
  const draw = (next: Snapshot, values: ReadonlyMap<string, unknown>) =>
    act(() => {
      render(ui.render(next, { chosen: values, disabled, choose }), container);
    });
  await draw(snapshot, chosen);
  const input = () => {
    const found = container.querySelector('input');
    if (found === null) throw new Error('숫자 칸이 없다.');
    return found;
  };
  return {
    choose,
    input,
    // 저장된 설정이나 정했지만 아직 담기지 않은 값이 바뀐 것처럼 다시 그린다.
    redraw: (next: Snapshot, values: ReadonlyMap<string, unknown> = new Map()) =>
      draw(next, values),
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

  it('결정 0037 팝업이 넘긴 정했지만 아직 담기지 않은 값이 있으면 저장된 값 대신 그것을 보인다', async () => {
    const field = await show(stored(1200), { chosen: new Map([['width', 1500]]) });
    expect(field.input().value).toBe('1500');
    await field.redraw(stored(1500));
    expect(field.input().value).toBe('1500');
    await field.redraw(stored(1800));
    expect(field.input().value).toBe('1800');
  });

  it('GPT-2.1 쓰는 동안은 정하지 않고, 정하면 범위 안의 정수만 팝업에 정한 값으로 넘긴다', async () => {
    const field = await show(stored(1200));
    await field.type('1500');
    expect(field.choose).not.toHaveBeenCalled();
    await field.commit();
    expect(field.choose.mock.calls).toEqual([[{ width: 1500 }]]);
    // 쓴 글을 거두고 팝업이 넘기는 값을 보인다.
    await field.redraw(stored(1200), new Map([['width', 1500]]));
    expect(field.input().value).toBe('1500');
    // 보낼지는 팝업이 정한다. 칸은 정할 때마다 넘긴다.
    await field.type('1500');
    await field.commit();
    expect(field.choose.mock.calls).toEqual([[{ width: 1500 }], [{ width: 1500 }]]);
  });

  it('범위 밖이거나 정수가 아니면 정하지 않고 이유를 칸에 잇는다', async () => {
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
    expect(field.choose).not.toHaveBeenCalled();
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
    expect(field.choose).not.toHaveBeenCalled();
  });

  it('쓰는 동안 저장된 값이 바뀌어도 쓴 글을 덮지 않는다', async () => {
    const field = await show(stored(1200));
    await field.type('1400');
    await field.redraw(stored(1800));
    expect(field.input().value).toBe('1400');
    expect(await field.escape()).toBe(true);
    expect(field.input().value).toBe('1800');
  });

  it('N-12 서비스 워커가 깨어나기 전에는 막는다', async () => {
    const field = await show(stored(1200), { disabled: true });
    expect(field.input().disabled).toBe(true);
  });
});
