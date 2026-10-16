import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type FakeLocalStore, createFakeLocalStore } from '../../src/platform/fake.ts';
import { popupStateKey } from '../../src/storage/index.ts';
import { startTestBackground } from '../support/background.ts';
import { renderTestPopup } from '../support/popup.ts';
import { specs } from '../support/settings.ts';

// 팝업이 마지막으로 고른 범주(COM-2 기대 동작 5, 결정 0023)를 실제 모듈끼리 연결해 본다. 팝업(범주 목록, popup 읽기)과
// 서비스 워커(라우터, popup 쓰기)는 실제 코드이고, 가짜는 저장소와 메시지 통로뿐이다. 시험 기능은 미디어와 페이지
// 범주에 하나씩 있다.

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) {
    render(null, container);
    container.remove();
  }
});

async function openPopup(store: FakeLocalStore) {
  const request = startTestBackground({ store, features: specs, startTime: 1_790_000_000_000 });
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  await renderTestPopup(container, { store, request, features: specs });
  const selected = () =>
    container.querySelector('[role=tab][aria-selected=true]')?.textContent ?? null;
  await vi.waitFor(() => {
    expect(selected()).not.toBeNull();
  });
  return {
    selected,
    choose: (name: string) =>
      act(() => {
        [...container.querySelectorAll<HTMLElement>('[role=tab]')]
          .find((tab) => tab.textContent === name)
          ?.click();
      }),
    close: () => {
      render(null, container);
    },
  };
}

describe('COM-2 기대 동작 5 마지막으로 연 범주', () => {
  it('팝업을 닫았다 다시 열면 마지막으로 고른 범주로 열린다', async () => {
    const store = createFakeLocalStore();
    const first = await openPopup(store);
    expect(first.selected()).toBe('미디어');
    await first.choose('페이지');
    await vi.waitFor(() => {
      expect(store.peek(popupStateKey)).toEqual({ category: 'page' });
    });
    first.close();

    const again = await openPopup(store);
    expect(again.selected()).toBe('페이지');
  });

  it('남긴 값이 틀리거나 기능이 없는 범주면 첫 범주로 열고, 문제로 기록하지 않는다', async () => {
    for (const value of ['page', { category: 'youtube' }, { category: 'settings' }]) {
      const store = createFakeLocalStore({ [popupStateKey]: value });
      const popup = await openPopup(store);
      expect(popup.selected(), JSON.stringify(value)).toBe('미디어');
      expect(store.peek('problems'), JSON.stringify(value)).toBeUndefined();
      popup.close();
    }
  });
});
