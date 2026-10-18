import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { settingsUpdate } from '../../src/contracts/index.ts';
import { chatgptWidth } from '../../src/features/chatgpt-width/feature.ts';
import { ui } from '../../src/features/chatgpt-width/ui.tsx';
import { createFakeStore } from '../../src/platform/fake.ts';
import type { KeyValueStore } from '../../src/platform/index.ts';
import { settingsKey } from '../../src/storage/index.ts';
import { startTestBackground } from '../support/background.ts';
import { renderTestPopup, switchOf } from '../support/popup.ts';

// 팝업에서 GPT-2의 너비를 정하는 길(결정 0030)을 실제 모듈끼리 연결해 본다. 팝업, GPT-2의 숫자 칸, 서비스 워커(라우터,
// 설정 쓰기), 읽기 도우미는 실제 코드이고, 가짜는 저장소와 메시지 통로뿐이다. 통로가 설정 바꾸기나 그 응답을, 팝업이 듣는
// 저장소가 바뀜 알림을 붙잡아, 저장의 응답과 바뀜 알림이 늦거나 다른 차례로 오는 동안의 조작을 본다. 다른 화면(다른 팝업,
// 설정 페이지)의 저장은 같은 서비스 워커에 붙잡지 않고 보낸다.

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) {
    render(null, container);
    container.remove();
  }
});

// 마이크로태스크를 몇 차례 흘려 보낸다(붙잡지 않은 응답과 알림이 팝업에 닿는다).
async function settle() {
  await act(async () => {
    for (let step = 0; step < 20; step += 1) await Promise.resolve();
  });
}

// 팝업의 설정 바꾸기에서 붙잡을 것: 서비스 워커에 닿는 것('delivery'), 서비스 워커는 곧바로 저장하고 그 응답만('response'),
// 붙잡지 않음('none').
async function openPopup(hold: 'delivery' | 'response' | 'none') {
  const store = createFakeStore();
  // 붙잡은 설정 바꾸기(또는 그 응답). 놓으면 받은 차례대로 서비스 워커에 닿는다(응답이 팝업에 간다).
  const held: (() => void)[] = [];
  // 다른 화면이 보내는 설정 바꾸기는 붙잡지 않는다.
  let fromOtherScreen = false;
  const request = startTestBackground({
    store,
    features: [chatgptWidth],
    startTime: 1_790_000_000_000,
    deliver: (type, send) => {
      if (type !== settingsUpdate.type || fromOtherScreen || hold === 'none') return send();
      if (hold === 'delivery') {
        return new Promise((resolve, reject) => {
          held.push(() => {
            send().then(resolve, reject);
          });
        });
      }
      return send().then(
        (response) =>
          new Promise((resolve) => {
            held.push(() => {
              resolve(response);
            });
          }),
      );
    },
  });
  // 팝업이 듣는 저장소. 붙잡기 시작하면 바뀜 알림을 온 차례대로 모아 두었다가 하나씩 놓는다.
  let holdingNotices = false;
  const notices: (() => void)[] = [];
  const popupStore: KeyValueStore = {
    get: (key) => store.get(key),
    set: (items) => store.set(items),
    onChanged: (key, listener) =>
      store.onChanged(key, (value) => {
        if (holdingNotices) {
          notices.push(() => {
            listener(value);
          });
        } else listener(value);
      }),
  };
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  await renderTestPopup(container, {
    store: popupStore,
    request,
    features: [chatgptWidth],
    uiParts: [ui],
  });
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
    // 붙잡은 설정 바꾸기(또는 응답) 가운데 먼저 온 것을 놓는다.
    release: () =>
      act(() => {
        held.shift()?.();
      }),
    // 이제부터 팝업이 듣는 바뀜 알림을 붙잡는다.
    holdNotices: () => {
      holdingNotices = true;
    },
    heldNotices: () => notices.length,
    // 붙잡은 바뀜 알림 가운데 먼저 온 것을 놓는다.
    releaseNotice: async () => {
      await act(() => {
        notices.shift()?.();
      });
      await settle();
    },
    // 다른 화면이 같은 기능의 너비를 바꾼다(붙잡지 않는다).
    otherScreen: (width: number) =>
      act(async () => {
        fromOtherScreen = true;
        const answer = request(settingsUpdate, { featureId: chatgptWidth.id, patch: { width } });
        fromOtherScreen = false;
        expect((await answer).ok).toBe(true);
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
    const popup = await openPopup('delivery');
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

  it('COM-3 기대 동작 3 저장이 바뀜 알림까지 온 뒤 응답이 늦는 사이 다른 화면이 바꾸면, 마지막 응답 때 칸이 최신 저장값을 보이고 앞에 정한 값을 다시 정하면 저장한다', async () => {
    const popup = await openPopup('response');
    await popup.choose('1500');
    await vi.waitFor(() => {
      expect(popup.storedWidth()).toBe(1500);
    });
    await vi.waitFor(() => {
      expect(popup.heldCount()).toBe(1);
    });
    await popup.otherScreen(1800);
    expect(popup.storedWidth()).toBe(1800);
    // 응답을 기다리는 동안은 마지막으로 정한 값을 보인다.
    expect(popup.field().value).toBe('1500');

    await popup.release();
    await vi.waitFor(() => {
      expect(popup.field().value).toBe('1800');
    });
    await popup.choose('1500');
    await vi.waitFor(() => {
      expect(popup.heldCount()).toBe(1);
    });
    await popup.release();
    await vi.waitFor(() => {
      expect(popup.storedWidth()).toBe(1500);
    });
    expect(popup.field().value).toBe('1500');
  });

  it('COM-3 기대 동작 3 저장 응답이 바뀜 알림보다 먼저 오면 그 알림까지 정한 값을 보이고, 그사이 되돌린 값도 저장하며, 앞 저장의 늦은 알림에 칸이 되돌아가지 않는다', async () => {
    const popup = await openPopup('none');
    popup.holdNotices();
    await popup.choose('1500');
    await settle();
    // 저장과 응답은 끝났고 팝업이 보는 저장된 값은 아직 1200이다.
    expect(popup.storedWidth()).toBe(1500);
    expect(popup.heldNotices()).toBe(1);
    expect(popup.field().value).toBe('1500');

    // 팝업이 보는 저장된 값과 같은 1200으로 되돌려도 저장한다.
    await popup.choose('1200');
    await settle();
    expect(popup.storedWidth()).toBe(1200);
    expect(popup.field().value).toBe('1200');

    // 앞 저장(1500)의 늦은 바뀜 알림이 와도 칸은 마지막으로 저장한 값이다.
    await popup.releaseNotice();
    expect(popup.field().value).toBe('1200');
    await popup.releaseNotice();
    expect(popup.field().value).toBe('1200');

    // 저장이 끝난 뒤 다른 화면이 바꾼 값은 따른다.
    await popup.otherScreen(1800);
    await popup.releaseNotice();
    expect(popup.field().value).toBe('1800');
  });
});
