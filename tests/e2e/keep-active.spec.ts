import { readFileSync } from 'node:fs';
import path from 'node:path';
import { elementTimeoutMs, pageElementAttribute } from '../../src/dom/index.ts';
import { chatgptWidth } from '../../src/features/chatgpt-width/feature.ts';
import {
  attached,
  blankUrl,
  closeTab,
  expect,
  expectActiveLike,
  featureId,
  pageUrl,
  popupStates,
  pressInList,
  problemRecords,
  recorder,
  setAllTabs,
  stateText,
  test,
  turn,
  updateSettings,
  waitAttached,
} from './support/keep-active.ts';
import { type RawChromium, type RawTab, launchRawChromium } from './support/raw-chromium.ts';

// 페이지 활성 상태 유지(TAB-2, 결정 0041·0042·0043)를 빌드한 확장과 진짜 보임·초점으로 본다(support/raw-chromium.ts).
// 사용자가 다른 창이나 프로그램으로 초점을 옮기는 것(TAB-2.17), 다른 창에 가려지는 것(TAB-2.18), 디버깅 안내 막대의
// 취소(TAB-2.7)는 화면 없는 Chromium에서 만들 수 없어 수동 절차(tests/manual/keep-active.md)와 통합 시험이 본다.
// 오래 걸리는 시험(타이머, 가짜 입력)은 keep-active-long.spec.ts에 있다.

// 자리 비움 판단(TAB-2.9): 숨김이나 초점 없음이 5초 이어지면. 입력 없음은 이 파일의 시험보다 길게 둔다.
const away = { hiddenMs: 5000, idleMs: 600_000 };

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

// 시험 페이지를 열어 그 창의 활성 탭으로 둔다.
async function openViewed(raw: RawChromium, url = pageUrl): Promise<RawTab> {
  const tab = await raw.open(url);
  await raw.activate(tab);
  return tab;
}

// 켜고 방패가 켜질 때까지 기다린 뒤 기록하는 코드를 넣는다(최상위와 다른 사이트의 iframe).
async function turnOnAndRecord(raw: RawChromium, tab: RawTab) {
  await turn(raw, [tab], true);
  const page = recorder(raw, tab);
  await page.waitShield(true, { frame: true });
  await page.install(away);
  await page.installInFrame();
  return page;
}

const windowState = (raw: RawChromium, tab: RawTab) =>
  raw.sw(async (id) => (await chrome.windows.get(id)).state, tab.windowId);

const setWindowState = async (raw: RawChromium, tab: RawTab, state: 'minimized' | 'normal') => {
  await raw.sw(
    async ([id, next]) => {
      await chrome.windows.update(id, { state: next });
    },
    [tab.windowId, state] as const,
  );
};

const autoDiscardable = (raw: RawChromium, tab: RawTab) =>
  raw.sw(async (id) => (await chrome.tabs.get(id)).autoDiscardable, tab.tabId);

const navigate = async (raw: RawChromium, tab: RawTab, url: string) => {
  await raw.sw(
    async ([id, to]) => {
      await chrome.tabs.update(id, { url: to });
    },
    [tab.tabId, url] as const,
  );
};

test('TAB-2.1 TAB-2.9 TAB-2.16 켜고 다른 탭으로 가면 페이지와 다른 사이트의 iframe이 계속 보이고 초점이 있으며 초점·보임이 바뀐 이벤트가 없고 자리 비움으로 판단하지 않는다. 돌아오면 디버거가 떨어진다', async ({
  raw,
}) => {
  const tab = await openViewed(raw);
  const page = await turnOnAndRecord(raw, tab);
  // 보는 탭에는 디버거를 붙이지 않는다.
  expect(await attached(raw, tab)).toBe(false);
  const other = await openViewed(raw, blankUrl);
  await waitAttached(raw, tab, true);
  expect(await attached(raw, other)).toBe(false);
  // 자리 비움의 기준(5초)보다 오래 둔다.
  await sleep(8000);
  const top = await page.read();
  expectActiveLike(top);
  expect(top.away).toEqual([]);
  expectActiveLike(await page.readFrame());
  await raw.activate(tab);
  await waitAttached(raw, tab, false);
  expectActiveLike(await page.read());
});

test('TAB-2.2 창을 최소화해도 페이지가 보이고 초점이 있으며 이벤트가 없다. 되살리면 디버거가 떨어진다', async ({
  raw,
}) => {
  const tab = await openViewed(raw);
  const page = await turnOnAndRecord(raw, tab);
  await setWindowState(raw, tab, 'minimized');
  await waitAttached(raw, tab, true);
  await sleep(8000);
  const record = await page.read();
  expectActiveLike(record);
  expect(record.away).toEqual([]);
  expectActiveLike(await page.readFrame());
  await setWindowState(raw, tab, 'normal');
  await waitAttached(raw, tab, false);
  expectActiveLike(await page.read());
});

test('TAB-2.5 TAB-2.21 끄면 디버거와 방패가 떨어지고 비우기가 원래 값으로 돌아오며, 다른 탭으로 가면 시험 페이지가 숨겨졌다고 기록한다', async ({
  raw,
}) => {
  const tab = await openViewed(raw);
  expect(await autoDiscardable(raw, tab)).toBe(true);
  const page = await turnOnAndRecord(raw, tab);
  expect(await autoDiscardable(raw, tab)).toBe(false);
  await turn(raw, [tab], false);
  await page.waitShield(false, { frame: true });
  expect(await autoDiscardable(raw, tab)).toBe(true);
  await openViewed(raw, blankUrl);
  await expect.poll(async () => (await page.read()).visibility).toBe('hidden');
  const record = await page.read();
  expect(record.events).toContainEqual({ type: 'visibilitychange', state: 'hidden' });
  expect(record.painting).toBe(false);
  expect(await attached(raw, tab)).toBe(false);
});

test('TAB-2.16 켜진 탭이 보는 탭이면 전체 화면 요청이 창 전체를 채운다. 다른 탭에 갔다가 돌아온 뒤에도 같다', async ({
  raw,
}) => {
  const tab = await openViewed(raw);
  await turnOnAndRecord(raw, tab);
  // 초점 흉내가 켜진 탭이면 Chrome이 탭 안에서만 전체 화면으로 하고 창은 normal로 남는다(2026-10-21 실험, 결정 0041).
  const fullscreen = async () => {
    await raw.evaluate(
      tab,
      async () => {
        await document.documentElement.requestFullscreen();
      },
      null,
      { userGesture: true },
    );
    await expect.poll(() => windowState(raw, tab)).toBe('fullscreen');
    expect(
      await raw.evaluate(tab, () => document.fullscreenElement === document.documentElement, null),
    ).toBe(true);
    await raw.evaluate(tab, () => document.exitFullscreen(), null);
    await expect.poll(() => windowState(raw, tab)).toBe('normal');
  };
  expect(await attached(raw, tab)).toBe(false);
  await fullscreen();
  await openViewed(raw, blankUrl);
  await waitAttached(raw, tab, true);
  await raw.activate(tab);
  await waitAttached(raw, tab, false);
  await fullscreen();
});

test('TAB-2.4 디버거를 붙일 수 없는 탭(다른 확장의 화면이 든 페이지)을 켠 뒤 보지 않는 탭이 되면 꺼지고 팝업에 이유가 보인다', async ({
  raw,
}) => {
  const otherId = await raw.loadOtherExtension(
    path.resolve(import.meta.dirname, '..', 'fixtures', 'other-extension'),
  );
  const tab = await openViewed(raw);
  // 비밀번호 관리자 같은 다른 확장이 페이지에 화면을 넣은 것과 같다.
  await raw.evaluate(
    tab,
    (src) =>
      new Promise<null>((resolve) => {
        const frame = document.createElement('iframe');
        frame.src = src;
        frame.addEventListener('load', () => {
          resolve(null);
        });
        document.body.append(frame);
      }),
    `chrome-extension://${otherId}/frame.html`,
  );
  await turn(raw, [tab], true);
  await popupStates(raw, (states) => {
    expect(states[String(tab.tabId)]).toBe(stateText.on);
  });
  await openViewed(raw, blankUrl);
  await popupStates(raw, (states) => {
    expect(states[String(tab.tabId)]).toBe(stateText.notice('attach-failed', false));
  });
  // 꺼진 채로 남는다. 돌아왔다가 다시 떠나도 붙이지 않는다.
  await raw.activate(tab);
  await openViewed(raw, blankUrl);
  await sleep(1000);
  expect(await attached(raw, tab)).toBe(false);
  await popupStates(raw, (states) => {
    expect(states[String(tab.tabId)]).toBe(stateText.notice('attach-failed', false));
  });
});

test('TAB-2.8 탭을 닫으면 그 탭의 디버거 연결과 탭 상태가 남지 않는다', async ({ raw }) => {
  const tab = await openViewed(raw);
  await turnOnAndRecord(raw, tab);
  await openViewed(raw, blankUrl);
  await waitAttached(raw, tab, true);
  await closeTab(raw, tab);
  const left = () =>
    raw.sw(async (id) => {
      const key = `"${String(id)}"`;
      const { tabToggles } = await chrome.storage.session.get('tabToggles');
      const { keepActiveLedger } = await chrome.storage.local.get('keepActiveLedger');
      return [
        (await chrome.debugger.getTargets()).some((target) => target.tabId === id),
        JSON.stringify(tabToggles ?? {}).includes(key),
        JSON.stringify(keepActiveLedger ?? {}).includes(key),
      ];
    }, tab.tabId);
  await expect.poll(left).toEqual([false, false, false]);
});

test('TAB-2.19 TAB-2.24 팝업의 탭 목록에서 탭 둘을 골라 켜면 둘 다 켜지고 하나를 골라 끄면 그것만 꺼진다. 웹 페이지가 아닌 탭에는 이유가 보이고, 확장 아이콘은 바뀌지 않는다', async ({
  raw,
}) => {
  const first = await openViewed(raw);
  const second = await raw.open(pageUrl);
  const internal = await raw.open('chrome://version/');
  const popup = await raw.popup();
  await pressInList(popup, [first, second], '고른 탭 켜기');
  await popupStates(raw, (states) => {
    expect(states[String(first.tabId)]).toBe(stateText.on);
    expect(states[String(second.tabId)]).toBe(stateText.on);
    expect(states[String(internal.tabId)]).toBe(stateText.notWeb(false));
  });
  // 보지 않는 탭(second)에만 디버거가 붙는다. 확장 아이콘의 배지와 제목은 그대로다.
  await waitAttached(raw, second, true);
  expect(await attached(raw, first)).toBe(false);
  for (const tab of [first, second]) {
    expect(
      await raw.sw(
        async (tabId) => [
          await chrome.action.getBadgeText({ tabId }),
          await chrome.action.getTitle({ tabId }),
        ],
        tab.tabId,
      ),
    ).toEqual(['', 'Browser Toolbox']);
  }
  await pressInList(popup, [second], '고른 탭 끄기');
  await popupStates(raw, (states) => {
    expect(states[String(first.tabId)]).toBe(stateText.on);
    expect(states[String(second.tabId)]).toBe(stateText.off);
  });
  await waitAttached(raw, second, false);
  await closeTab(raw, popup.tab);
});

test('TAB-2.20 "모든 탭" 스위치를 켜면 열린 탭과 그 뒤에 연 탭이 켜지고 TAB-2.1이 성립한다. 켜진 동안 끈 탭은 꺼진 채이고, 끄면 모두 꺼진다', async ({
  raw,
}) => {
  const first = await openViewed(raw);
  const second = await raw.open(pageUrl);
  await setAllTabs(raw, true);
  const later = await raw.open(pageUrl);
  await popupStates(raw, (states) => {
    for (const tab of [first, second, later]) expect(states[String(tab.tabId)]).toBe(stateText.on);
  });
  const page = recorder(raw, later);
  await page.waitShield(true, { frame: true });
  await raw.activate(later);
  await page.install(away);
  await raw.activate(first);
  await waitAttached(raw, later, true);
  await sleep(6000);
  expectActiveLike(await page.read());
  await turn(raw, [second], false);
  await popupStates(raw, (states) => {
    expect(states[String(second.tabId)]).toBe(stateText.off);
    expect(states[String(later.tabId)]).toBe(stateText.on);
  });
  await setAllTabs(raw, false);
  await popupStates(raw, (states) => {
    for (const tab of [first, second, later]) expect(states[String(tab.tabId)]).toBe(stateText.off);
  });
  await waitAttached(raw, later, false);
});

test('TAB-2.22 켜진 탭이 보지 않는 탭인 채 다른 페이지로 가도 TAB-2.1이 성립하고, Chrome 내부 화면에서는 이유를 보이며 쉬다가 웹 페이지로 돌아오면 다시 성립한다', async ({
  raw,
}) => {
  const tab = await openViewed(raw);
  await turn(raw, [tab], true);
  await openViewed(raw, blankUrl);
  await waitAttached(raw, tab, true);
  // 새 문서에서 방패가 켜진 뒤 기록해 TAB-2.1을 본다(다른 사이트로 가면 iframe은 같은 사이트가 되어 최상위만 본다).
  const checkActiveLike = async (url: string) => {
    await expect
      .poll(() => raw.evaluate(tab, () => [location.href, document.readyState], null))
      .toEqual([url, 'complete']);
    const page = recorder(raw, tab);
    await page.waitShield(true);
    await page.install(away);
    await sleep(6000);
    const record = await page.read();
    expectActiveLike(record);
    expect(record.away).toEqual([]);
  };
  const otherSite = `${pageUrl.replace('127.0.0.1', 'insecure.test')}?next`;
  await navigate(raw, tab, otherSite);
  await checkActiveLike(otherSite);
  await navigate(raw, tab, 'chrome://version/');
  await popupStates(raw, (states) => {
    expect(states[String(tab.tabId)]).toBe(stateText.notWeb(true));
  });
  expect(await attached(raw, tab)).toBe(false);
  await navigate(raw, tab, pageUrl);
  await waitAttached(raw, tab, true);
  await checkActiveLike(pageUrl);
});

test('TAB-2.25 켜진 탭이 분할 보기로 활성 탭과 나란히 놓이면 디버거가 붙지 않고, 분할 보기 밖의 탭이 활성이 되면 붙어 TAB-2.1이 성립한다', async ({
  raw,
}) => {
  const tab = await openViewed(raw);
  const partner = await raw.open(blankUrl);
  const page = await turnOnAndRecord(raw, tab);
  const pair: [number, number] = [tab.tabId, partner.tabId];
  await raw.sw(async (ids) => {
    await chrome.tabs.createSplit(ids);
  }, pair);
  await raw.activate(partner);
  await sleep(1000);
  expect(await attached(raw, tab)).toBe(false);
  // 분할 보기의 활성이 아닌 쪽은 보이지만 초점이 없다. 켜진 탭은 페이지 쪽 방패가 초점이 있다고 답하고 blur를 막는다.
  expectActiveLike(await page.read());
  await openViewed(raw, blankUrl);
  await waitAttached(raw, tab, true);
  await sleep(6000);
  const behind = await page.read();
  expectActiveLike(behind);
  expect(behind.away).toEqual([]);
});

test('TAB-2.23 COM-7.6 COM-7 기대 동작 2 확장을 다시 불러오면 탭마다 켠 탭이 꺼지고 비우기가 원래 값으로 돌아오며, 새로 고치기 전의 탭은 지금 탭이 아니어도 탭 목록에 새로 고쳐야 한다는 이유가 보인다. "모든 탭" 스위치를 켜 두었으면 다시 불러온 뒤와 브라우저를 다시 켠 뒤에도 열린 탭이 켜짐이고, 새로 고치면 이유가 사라진다', async ({
  raw,
}, testInfo) => {
  const tab = await openViewed(raw);
  await turn(raw, [tab], true);
  await openViewed(raw, blankUrl);
  await waitAttached(raw, tab, true);
  await raw.reloadExtension();
  // 열린 탭에는 새 판의 실행 틀이 없다(COM-7). 팝업을 연 탭이 아니어도 그 까닭이 보인다.
  await popupStates(raw, (states) => {
    expect(states[String(tab.tabId)]).toBe(stateText.reload(false));
  });
  await waitAttached(raw, tab, false);
  expect(await autoDiscardable(raw, tab)).toBe(true);
  await setAllTabs(raw, true);
  await waitAttached(raw, tab, true);
  await raw.reloadExtension();
  await popupStates(raw, (states) => {
    expect(states[String(tab.tabId)]).toBe(stateText.reload(true));
  });
  await waitAttached(raw, tab, true);
  // 새로 고치면 새 판의 실행 틀이 돌아 까닭이 사라진다.
  await raw.sw(async (id) => {
    await chrome.tabs.reload(id);
  }, tab.tabId);
  await recorder(raw, tab).waitShield(true);
  await popupStates(raw, (states) => {
    expect(states[String(tab.tabId)]).toBe(stateText.on);
  });
  // 브라우저를 다시 켠다(같은 프로필). 스위치는 설정이라 남는다.
  await raw.close();
  const restarted = await launchRawChromium(testInfo.outputPath('profile'));
  try {
    const reopened = await restarted.open(pageUrl);
    await restarted.activate(await restarted.open(blankUrl));
    await popupStates(restarted, (states) => {
      expect(states[String(reopened.tabId)]).toBe(stateText.on);
    });
    await waitAttached(restarted, reopened, true);
    await recorder(restarted, reopened).waitShield(true);
    expect(
      await restarted.sw(async (id) => {
        const { settings } = await chrome.storage.local.get('settings');
        return JSON.stringify(settings).includes(`"${id}"`);
      }, featureId),
    ).toBe(true);
  } finally {
    await restarted.close();
  }
});

test('COM-7.5 켜진 보는 탭에서 서비스 워커가 쉬다 멈춰도, 다른 탭으로 가면 서비스 워커가 깨어나 디버거를 붙이고 TAB-2.1이 성립한다', async ({
  raw,
}) => {
  const tab = await openViewed(raw);
  const other = await raw.open(blankUrl);
  const page = await turnOnAndRecord(raw, tab);
  await raw.stopServiceWorkers();
  // 서비스 워커를 거치지 않고 탭을 바꾼다. Chrome의 사건(tabs.onActivated)이 서비스 워커를 깨운다.
  await raw.activate(other);
  await waitAttached(raw, tab, true);
  await sleep(6000);
  expectActiveLike(await page.read());
});

// 대화 화면에 대화 열이 없는 chatgpt.com(사이트가 화면을 바꿈, GPT-2.5). 로그인하지 않은 화면의 시험 페이지에서 대화 열의
// 단서를 뺀다.
function chatgptWithoutThread(): string {
  const html = readFileSync(
    path.join(import.meta.dirname, '..', 'fixtures', 'chatgpt.html'),
    'utf8',
  );
  const thread = '<ol aria-label="Conversation" data-conversation-transcript>';
  if (!html.includes(thread)) throw new Error('시험 페이지에 대화 열이 없다.');
  return html.replace(thread, '<ol aria-label="Conversation">');
}

// 페이지에서 돈다. 확장이 넣은 스타일 요소(너비 규칙)가 있는지.
function hasPageStyle(attribute: string): boolean {
  return document.querySelector(`style[${attribute}]`) !== null;
}

test('COM-6.1 COM-6.7 결정 0044 너비 기능과 함께 켠 뒤쪽 탭에서 숨은 채 시작한 찾기는 방패가 켜진 뒤 디버거로 보이게 되면 이어지고, 보인 때부터 15초 뒤 찾지 못함을 기록한다', async ({
  raw,
}) => {
  test.setTimeout(90_000);
  await raw.serve('https://chatgpt.com', chatgptWithoutThread());
  await updateSettings(raw, chatgptWidth.id, { enabled: true });
  // 뒤쪽 탭은 숨어 있다. 너비 규칙을 넣고 대화 열을 찾기 시작하지만, 보일 때까지 세지 않고 쉰다(COM-6.7).
  const tab = await raw.open('https://chatgpt.com/c/abc');
  await expect.poll(() => raw.evaluate(tab, hasPageStyle, pageElementAttribute)).toBe(true);
  expect(await raw.evaluate(tab, () => document.visibilityState, null)).toBe('hidden');
  // 숨은 동안 지난 시간은 세지 않는다. 세면 아래의 기록이 켠 때부터 15초보다 일찍 남는다.
  await sleep(3000);
  const turnedAt = Date.now();
  await turn(raw, [tab], true);
  const page = recorder(raw, tab);
  await page.waitShield(true);
  await waitAttached(raw, tab, true);
  // 초점 흉내로 실제로 보인다(화면을 그림). 페이지에는 방패가 그 바뀜을 숨겼다.
  await page.install();
  await expect.poll(async () => (await page.read()).painting).toBe(true);
  const expected = {
    featureId: chatgptWidth.id,
    kind: 'not-found',
    element: { id: 'chatgpt.thread', name: 'ChatGPT 대화 열' },
  };
  await expect
    .poll(() => problemRecords(raw), { timeout: elementTimeoutMs + 10_000 })
    .toEqual([{ ...expected, at: expect.any(Number) }]);
  const [record] = await problemRecords(raw);
  const at = typeof record === 'object' && record !== null && 'at' in record ? record.at : null;
  expect(typeof at === 'number' && at >= turnedAt + elementTimeoutMs).toBe(true);
});

// 페이지에서 돈다. 이 문서에 표식을 남긴다. 뒤로 가기에서 같은 표식이 보이면 뒤로·앞으로 캐시(bfcache)가 그 문서를 되살린
// 것이다(새로 실었으면 없다).
function markDocument(): null {
  Reflect.set(window, 'documentMark', 'before');
  return null;
}

function isMarked(): boolean {
  return Reflect.get(window, 'documentMark') === 'before';
}

// 같은 탭에서 다른 페이지로 가(앞 문서는 bfcache에 든다) away를 하고 뒤로 가기로 돌아온다. 돌아온 것이 bfcache에서 되살아난
// 그 문서인지 먼저 확인한다(이 시험이 보려는 것). 표식은 사용자가 누른 것으로 쳐서 남긴다. 사용자가 쓰지 않은 페이지는 Chrome이
// 뒤로 가기에서 건너뛴다(tabs.goBack이 "Cannot find a next page in history"로 거절함).
async function changeWhileCached(raw: RawChromium, tab: RawTab, away: () => Promise<void>) {
  await raw.evaluate(tab, markDocument, null, { userGesture: true });
  await navigate(raw, tab, blankUrl);
  await expect
    .poll(() => raw.evaluate(tab, () => [location.href, document.readyState], null))
    .toEqual([blankUrl, 'complete']);
  await away();
  await raw.sw(async (id) => {
    await chrome.tabs.goBack(id);
  }, tab.tabId);
  await expect.poll(() => raw.evaluate(tab, isMarked, null)).toBe(true);
}

test('결정 0043 TAB-2.5 켜진 탭에서 다른 페이지로 가 끈 뒤 뒤로 가기로 돌아오면, 뒤로·앞으로 캐시에서 되살아난 문서도 꺼져 방패가 없다', async ({
  raw,
}) => {
  const tab = await openViewed(raw);
  await turn(raw, [tab], true);
  const page = recorder(raw, tab);
  await page.waitShield(true);
  await changeWhileCached(raw, tab, async () => {
    await page.waitShield(true);
    await turn(raw, [tab], false);
    await page.waitShield(false);
  });
  await page.waitShield(false);
  await popupStates(raw, (states) => {
    expect(states[String(tab.tabId)]).toBe(stateText.off);
  });
});

test('결정 0043 꺼진 탭에서 다른 페이지로 가 켠 뒤 뒤로 가기로 돌아오면, 뒤로·앞으로 캐시에서 되살아난 문서도 켜져 방패가 있다', async ({
  raw,
}) => {
  const tab = await openViewed(raw);
  const page = recorder(raw, tab);
  await changeWhileCached(raw, tab, async () => {
    await turn(raw, [tab], true);
    await page.waitShield(true);
  });
  await page.waitShield(true);
  await popupStates(raw, (states) => {
    expect(states[String(tab.tabId)]).toBe(stateText.on);
  });
});
