import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { settingsUpdate } from '../../src/contracts/index.ts';
import { chatgptWidth } from '../../src/features/chatgpt-width/feature.ts';
import { ui } from '../../src/features/chatgpt-width/ui.tsx';
import { createFakeStore } from '../../src/platform/fake.ts';
import { settingsKey } from '../../src/storage/index.ts';
import { startTestBackground } from '../support/background.ts';
import { renderTestPopup, switchOf } from '../support/popup.ts';

// 팝업에서 GPT-2의 너비를 정하는 길(결정 0030)을 실제 모듈끼리 연결해 본다. 팝업, GPT-2의 숫자 칸, 서비스 워커(라우터,
// 설정 쓰기)는 실제 코드이고, 가짜는 저장소와 메시지 통로뿐이다. 통로가 설정 바꾸기를 붙잡아, 저장의 응답과 바뀜 알림이
// 늦게 오는 동안의 조작을 본다.

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) {
    render(null, container);
    container.remove();
  }
});

async function openPopup() {
  const store = createFakeStore();
  // 붙잡은 설정 바꾸기. 놓으면 받은 차례대로 서비스 워커에 닿는다.
  const held: (() => void)[] = [];
  const request = startTestBackground({
    store,
    features: [chatgptWidth],
    startTime: 1_790_000_000_000,
    deliver: (type, send) =>
      type === settingsUpdate.type
        ? new Promise((resolve, reject) => {
            held.push(() => {
              send().then(resolve, reject);
            });
          })
        : send(),
  });
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  await renderTestPopup(container, { store, request, features: [chatgptWidth], uiParts: [ui] });
  const field = () => {
    const found = container.querySelector<HTMLInputElement>('#chatgpt-width-width');
    if (found === null) throw new Error('너비 칸이 없다.');
    return found;
  };
  // 범주를 그리고 서비스 워커가 깨어나 칸을 쓸 수 있을 때까지 기다린다(결정 0023, N-12).
  await vi.waitFor(() => {
    expect(switchOf(container, chatgptWidth.id)).not.toBeNull();
    expect(field().disabled).toBe(false);
  });
  return {
    field,
    // 칸에 쓰고 정한다(Enter나 초점을 옮김에 Chromium이 내는 change).
    choose: (text: string) =>
      act(() => {
        field().value = text;
        field().dispatchEvent(new Event('input', { bubbles: true }));
        field().dispatchEvent(new Event('change', { bubbles: true }));
      }),
    heldCount: () => held.length,
    // 붙잡은 설정 바꾸기 가운데 먼저 온 것을 놓는다.
    release: () =>
      act(() => {
        held.shift()?.();
      }),
    storedWidth: (): unknown => {
      const settings = store.peek(settingsKey);
      if (typeof settings !== 'object' || settings === null || !('features' in settings))
        return null;
      const { features } = settings;
      if (typeof features !== 'object' || features === null) return null;
      const item: unknown = Reflect.get(features, chatgptWidth.id);
      return typeof item === 'object' && item !== null && 'width' in item ? item.width : null;
    },
  };
}

describe('GPT-2 팝업의 너비 칸과 늦은 저장(결정 0030)', () => {
  it('COM-3 기대 동작 3 저장 응답을 붙잡은 채 바꿨다가 되돌리면 되돌린 값이 저장되고, 앞 저장이 끝나도 칸은 마지막으로 정한 값이다', async () => {
    const popup = await openPopup();
    expect(popup.field().value).toBe('1200');
    await popup.choose('1500');
    await popup.choose('1200');
    expect(popup.heldCount()).toBe(2);
    expect(popup.field().value).toBe('1200');

    await popup.release();
    await vi.waitFor(() => {
      expect(popup.storedWidth()).toBe(1500);
    });
    expect(popup.field().value).toBe('1200');

    await popup.release();
    await vi.waitFor(() => {
      expect(popup.storedWidth()).toBe(1200);
    });
    expect(popup.field().value).toBe('1200');
  });
});
