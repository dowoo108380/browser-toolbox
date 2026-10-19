import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { settingsUpdate } from '../../src/contracts/index.ts';
import { chatgptWidth } from '../../src/features/chatgpt-width/feature.ts';
import { ui } from '../../src/features/chatgpt-width/ui.tsx';
import { mediaSpeed } from '../../src/features/media-speed/feature.ts';
import { createFakeStore } from '../../src/platform/fake.ts';
import { type KeyValueStore, type Requester, chromeRequester } from '../../src/platform/index.ts';
import { settingsFormat, settingsKey } from '../../src/storage/index.ts';
import {
  type TestBackgroundOptions,
  startTestBackground,
  startTestBackgroundOnRuntime,
} from '../support/background.ts';
import { renderTestPopup, switchOf } from '../support/popup.ts';

// 팝업에서 GPT-2의 너비를 정하는 길(결정 0030)을 실제 모듈끼리 연결해 본다. 팝업, GPT-2의 숫자 칸, 서비스 워커(라우터,
// 설정 쓰기), 읽기 도우미는 실제 코드이고, 가짜는 저장소와 메시지 통로뿐이다. 통로가 설정 바꾸기나 그 응답을, 팝업이 듣는
// 저장소가 바뀜 알림을 붙잡아, 저장의 응답과 바뀜 알림이 늦거나 다른 차례로 오는 동안의 조작을 본다. 다른 화면(다른 팝업,
// 설정 페이지)의 저장은 같은 서비스 워커에 붙잡지 않고 보낸다. 기능은 실제 팝업처럼 미디어와 ChatGPT 범주에 하나씩 있다.

// 서비스 워커의 시계가 시작하는 시각(ms).
const startTime = 1_790_000_000_000;
const features = [mediaSpeed, chatgptWidth];
// 실제 요청 도우미의 기본 제한 시간(아키텍처 7장 "비동기, 제한 시간, 취소").
const requestTimeoutMs = 5000;

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) {
    render(null, container);
    container.remove();
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// 마이크로태스크를 몇 차례 흘려 보낸다(붙잡지 않은 응답과 알림이 팝업에 닿는다).
async function settle() {
  await act(async () => {
    for (let step = 0; step < 20; step += 1) await Promise.resolve();
  });
}

// 팝업이 너비 칸을 없앴다가 다시 만드는 길: 다른 범주로 갔다 돌아옴, 검색했다 지움.
type Way = 'category' | 'search';
const ways: readonly { readonly way: Way; readonly name: string }[] = [
  { way: 'category', name: '다른 범주로 갔다 돌아와' },
  { way: 'search', name: '검색했다 지워' },
];

// 팝업의 설정 바꾸기에서 붙잡을 것: 서비스 워커에 닿는 것('delivery'), 서비스 워커는 곧바로 저장하고 그 응답만('response'),
// 붙잡지 않음('none'). settings는 처음 저장된 설정이다(없으면 서비스 워커가 기본 설정을 쓴다). via는 팝업이 요청을 보내는
// 길이다: 요청 도우미를 흉내 낸 함수('test'), 실제 요청 도우미와 그것이 부르는 chrome.runtime의 가짜('chrome', 제한 시간과
// 응답 검증까지 실제 코드).
async function openPopup(
  hold: 'delivery' | 'response' | 'none',
  settings?: unknown,
  via: 'test' | 'chrome' = 'test',
) {
  const store = createFakeStore(settings === undefined ? {} : { [settingsKey]: settings });
  // 붙잡은 설정 바꾸기(또는 그 응답). 놓으면 받은 차례대로 서비스 워커에 닿는다(응답이 팝업에 간다).
  const held: (() => void)[] = [];
  // 다른 화면이 보내는 설정 바꾸기는 붙잡지 않는다.
  let fromOtherScreen = false;
  const background: TestBackgroundOptions = {
    store,
    features,
    startTime,
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
  };
  let request: Requester;
  if (via === 'chrome') {
    startTestBackgroundOnRuntime(background);
    request = chromeRequester();
  } else {
    request = startTestBackground(background);
  }
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
    features,
    uiParts: [ui],
  });
  const field = () => {
    const found = container.querySelector<HTMLInputElement>('#chatgpt-width-width');
    if (found === null) throw new Error('너비 칸이 없다.');
    return found;
  };
  const tab = (name: string) => {
    const found = [...container.querySelectorAll<HTMLElement>('[role=tab]')].find(
      (element) => element.textContent === name,
    );
    if (found === undefined) throw new Error(`범주 ${name}이 없다.`);
    return found;
  };
  const search = (query: string) =>
    act(() => {
      const input = container.querySelector<HTMLInputElement>('[role=combobox]');
      if (input === null) throw new Error('검색 칸이 없다.');
      input.value = query;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
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
    // 다른 범주로 가거나 검색해 팝업이 너비 칸을 없애게 하고(leave), 돌아와 다시 만들게 한다(back).
    leave: async (way: Way) => {
      if (way === 'category') {
        await act(() => {
          tab('미디어').click();
        });
      } else {
        await search('너비');
      }
      expect(container.querySelector('#chatgpt-width-width')).toBeNull();
    },
    back: async (way: Way) => {
      if (way === 'category') {
        await act(() => {
          tab('ChatGPT').click();
        });
      } else {
        await search('');
      }
    },
    // 저장소 밖에서 설정 전체를 손상시킨다(개발자 도구로 고친 값). 팝업의 읽기 도우미가 보고 서비스 워커에 고쳐 쓰게 한다.
    corrupt: () =>
      act(() => {
        store.replace(settingsKey, 'broken');
      }),
    heldCount: () => held.length,
    // 팝업의 알림 줄.
    status: () => container.querySelector('[role=status]')?.textContent,
    // 실제 요청 도우미의 제한 시간이 지나게 가짜 시계를 돌린다(시험이 vi.useFakeTimers로 setTimeout을 바꿔 둔다).
    timeOut: () =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(requestTimeoutMs);
      }),
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
      const { features: items } = settings;
      if (typeof items !== 'object' || items === null) return null;
      const item: unknown = Reflect.get(items, chatgptWidth.id);
      // 항목이 없으면 기본값이다.
      if (item === undefined) return chatgptWidth.settings.defaults.width;
      return typeof item === 'object' && item !== null && 'width' in item ? item.width : null;
    },
    storedRevision: (): unknown => {
      const settings = store.peek(settingsKey);
      return typeof settings === 'object' && settings !== null && 'revision' in settings
        ? settings.revision
        : null;
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

  for (const { way, name } of ways) {
    it(`COM-3 기대 동작 3 결정 0037 저장을 붙잡은 채 ${name} 너비 칸이 다시 만들어져도 정한 값을 보이고, 되돌린 값도 저장해 마지막으로 정한 값이 남는다`, async () => {
      const popup = await openPopup('delivery');
      await popup.choose('1500');
      const before = popup.field();
      await popup.leave(way);
      await popup.back(way);
      expect(popup.field()).not.toBe(before);
      expect(popup.field().value).toBe('1500');

      await popup.choose('1200');
      expect(popup.heldCount()).toBe(2);
      await popup.release();
      await popup.release();
      await vi.waitFor(() => {
        expect(popup.storedWidth()).toBe(1200);
      });
      expect(popup.field().value).toBe('1200');
    });

    it(`COM-3 기대 동작 3 결정 0037 너비 칸이 없는 동안 저장 응답이 오고 바뀜 알림이 늦으면, ${name} 다시 만든 칸이 그 저장의 값을 보이고 되돌린 값도 저장한다`, async () => {
      const popup = await openPopup('response');
      popup.holdNotices();
      await popup.choose('1500');
      await vi.waitFor(() => {
        expect(popup.heldCount()).toBe(1);
      });
      await popup.leave(way);
      await popup.release();
      await settle();
      await popup.back(way);
      // 저장은 끝났고 팝업이 보는 저장된 값은 아직 1200이다.
      expect(popup.storedWidth()).toBe(1500);
      expect(popup.field().value).toBe('1500');

      await popup.choose('1200');
      await vi.waitFor(() => {
        expect(popup.heldCount()).toBe(1);
      });
      expect(popup.storedWidth()).toBe(1200);
      await popup.release();
      while (popup.heldNotices() > 0) await popup.releaseNotice();
      expect(popup.field().value).toBe('1200');
    });
  }

  it('COM-3 기대 동작 3 결정 0036 저장 응답을 기다리는 동안 설정 전체가 손상되면 칸은 저장된 값을 보이고, 시계가 뒤로 간 채 고쳐 쓴 뒤 앞 저장의 성공이 늦게 와도 그대로이며, 앞에 정한 값을 다시 정하면 저장한다', async () => {
    // 지금 시각보다 큰 세대 번호로 저장된 설정(그 뒤 시계가 뒤로 갔다). 손상을 고쳐 쓴 값의 세대 번호는 지금 시각이라 이
    // 칸이 손상 전에 저장한 것보다 작다(결정 0011 "세대 번호"의 한계).
    const ahead = startTime + 10_000_000_000;
    const popup = await openPopup('response', {
      version: settingsFormat.version,
      revision: ahead,
      features: {},
      sites: {},
    });
    await popup.choose('1500');
    await vi.waitFor(() => {
      expect(popup.heldCount()).toBe(1);
    });
    expect(popup.storedRevision()).toBe(ahead + 1);

    await popup.corrupt();
    await vi.waitFor(() => {
      expect(popup.storedRevision()).toBeTypeOf('number');
    });
    expect(popup.storedRevision()).toBeLessThan(ahead);
    expect(popup.storedWidth()).toBe(1200);
    await vi.waitFor(() => {
      expect(popup.field().value).toBe('1200');
    });

    // 손상 전에 보낸 저장의 성공(세대 번호 ahead + 1)이 늦게 와도 칸은 저장된 값이다.
    await popup.release();
    await settle();
    expect(popup.field().value).toBe('1200');

    await popup.choose('1500');
    await vi.waitFor(() => {
      expect(popup.heldCount()).toBe(1);
    });
    expect(popup.storedWidth()).toBe(1500);
    await popup.release();
    await settle();
    expect(popup.field().value).toBe('1500');
  });

  // 실제 요청 도우미의 제한 시간(5초)은 가짜 시계로 넘긴다. setTimeout만 바꾸므로 20초마다 깨우기는 실제 시계 그대로이고,
  // Preact가 효과를 부르는 때(그리기 뒤 setTimeout)는 act가 흘려 보내거나 vi.waitFor가 시계를 돌릴 때다. 이 시험이 보는
  // 칸의 값과 알림 줄은 효과 없이 그려진다.
  for (const way of [null, ...ways]) {
    const name = way === null ? '' : `${way.name}도 `;
    it(`COM-3 기대 동작 3 결정 0036 저장의 응답이 실제 요청 도우미의 제한 시간을 넘기면 저장했는지 알 수 없다고 알리고 ${name}칸은 저장된 값을 보이며, 그 값을 다시 정하면 보내 앞 저장이 늦게 저장되어도 마지막으로 정한 값이 남는다`, async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const popup = await openPopup('delivery', undefined, 'chrome');
      await popup.choose('1500');
      expect(popup.heldCount()).toBe(1);
      if (way !== null) await popup.leave(way.way);
      // 서비스 워커는 1500을 받아 두고(붙잡음) 아직 저장하지 않았다. 요청 도우미는 제한 시간이 지나 응답 없음으로 끝낸다.
      await popup.timeOut();
      if (way !== null) await popup.back(way.way);
      expect(popup.status()).toBe('확장의 응답이 없다. 잠시 뒤 다시 한다.');
      expect(popup.field().value).toBe('1200');

      // 보이는 값과 같은 1200도 보낸다. 앞의 1500이 아직 저장될 수 있기 때문이다.
      await popup.choose('1200');
      expect(popup.heldCount()).toBe(2);
      await popup.release();
      await settle();
      expect(popup.storedWidth()).toBe(1500);
      await popup.release();
      await settle();
      expect(popup.storedWidth()).toBe(1200);
      expect(popup.field().value).toBe('1200');
    });
  }

  it('COM-3 기대 동작 3 결정 0036 손상 전에 보낸 저장이 서비스 워커가 고쳐 쓴 뒤에 저장되어도, 그사이 보이는 기본값과 같은 값을 정하면 보내 마지막으로 정한 값이 남는다', async () => {
    const popup = await openPopup('delivery');
    await popup.choose('1500');
    expect(popup.heldCount()).toBe(1);
    await popup.corrupt();
    await vi.waitFor(() => {
      expect(popup.storedRevision()).toBeTypeOf('number');
    });
    await vi.waitFor(() => {
      expect(popup.field().value).toBe('1200');
    });

    // 잊은 1500이 고쳐 쓴 값 뒤에 담길 수 있어, 보이는 1200과 같은 값도 보낸다.
    await popup.choose('1200');
    expect(popup.heldCount()).toBe(2);
    await popup.release();
    await vi.waitFor(() => {
      expect(popup.storedWidth()).toBe(1500);
    });
    await popup.release();
    await vi.waitFor(() => {
      expect(popup.storedWidth()).toBe(1200);
    });
    await settle();
    expect(popup.field().value).toBe('1200');
  });
});
