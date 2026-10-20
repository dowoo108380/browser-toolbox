import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../../storage/index.ts';
import { ui } from './ui.tsx';

// 팝업에서 claude.ai의 대화 열·작성란의 최대 너비를 정하는 숫자 칸(결정 0030, 0039). 칸의 동작(쓰는 동안, 정할 때, Esc, 쓰는
// 동안 바뀐 값)은 함께 쓰는 ui의 NumberField이고 GPT-2의 칸 시험(features/chatgpt-width/ui.dom.test.tsx)이 자세히 본다. 여기서는
// 이 기능이 그 칸에 준 것(값, 이름, 범위, 문구, 넘기는 설정 키)을 본다. 키보드만으로 정하는 것은 확장 전체 시험
// (tests/e2e/claude-width.spec.ts)이 본다.

const container = document.createElement('div');
document.body.append(container);

afterEach(() => {
  render(null, container);
});

const stored = (width?: number): Snapshot => ({
  features: new Map(
    width === undefined ? [] : [['claude-width', { enabled: true, width }] as const],
  ),
  sites: new Map(),
});

async function show(snapshot: Snapshot) {
  const choose = vi.fn<(patch: Readonly<Record<string, unknown>>) => void>();
  await act(() => {
    render(ui.render(snapshot, { chosen: new Map(), disabled: false, choose }), container);
  });
  const input = () => {
    const found = container.querySelector('input');
    if (found === null) throw new Error('숫자 칸이 없다.');
    return found;
  };
  const enter = (text: string) =>
    act(() => {
      input().value = text;
      input().dispatchEvent(new Event('input', { bubbles: true }));
      input().dispatchEvent(new Event('change', { bubbles: true }));
    });
  return { choose, input, enter };
}

describe('CLD-1 팝업의 너비 칸(결정 0030, 0039)', () => {
  it('CLD-1 기대 동작 1 저장된 너비(없으면 처음 1200)를 보이고, 이름과 범위와 claude.ai의 안내가 칸에 이어져 있다', async () => {
    const field = await show(stored());
    expect(field.input().value).toBe('1200');
    expect(field.input().id).toBe('claude-width-width');
    expect(field.input().labels?.[0]?.textContent).toBe('최대 너비(px)');
    expect([field.input().min, field.input().max, field.input().step]).toEqual([
      '640',
      '3840',
      '10',
    ]);
    const hint = document.getElementById(field.input().getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toBe('640–3840 사이의 정수. 바꾸면 열린 claude.ai 탭에 바로 걸린다.');
    render(null, container);
    expect((await show(stored(1700))).input().value).toBe('1700');
  });

  it('CLD-1.1 정하면 범위 안의 정수만 이 기능의 너비로 넘기고, 범위 밖이면 이유를 보인다', async () => {
    const field = await show(stored(1200));
    await field.enter('1500');
    expect(field.choose.mock.calls).toEqual([[{ width: 1500 }]]);
    await field.enter('3841');
    expect(field.choose).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.error')?.textContent).toBe(
      '640–3840 사이의 정수만 쓸 수 있어 저장하지 않았다. Esc를 누르면 저장된 값으로 돌아간다.',
    );
    expect(field.input().getAttribute('aria-describedby')?.split(' ')[0]).toBe(
      'claude-width-width-error',
    );
  });
});
