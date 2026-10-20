import path from 'node:path';
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
  recorder,
  setAllTabs,
  stateText,
  test,
  turn,
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

test('TAB-2.23 COM-7.6 확장을 다시 불러오면 탭마다 켠 탭이 꺼지고 비우기가 원래 값으로 돌아온다. "모든 탭" 스위치를 켜 두었으면 다시 불러온 뒤와 브라우저를 다시 켠 뒤에도 열린 탭이 켜짐이다', async ({
  raw,
}, testInfo) => {
  const tab = await openViewed(raw);
  await turn(raw, [tab], true);
  await openViewed(raw, blankUrl);
  await waitAttached(raw, tab, true);
  await raw.reloadExtension();
  await popupStates(raw, (states) => {
    expect(states[String(tab.tabId)]).toBe(stateText.off);
  });
  await waitAttached(raw, tab, false);
  expect(await autoDiscardable(raw, tab)).toBe(true);
  await setAllTabs(raw, true);
  await waitAttached(raw, tab, true);
  await raw.reloadExtension();
  await popupStates(raw, (states) => {
    expect(states[String(tab.tabId)]).toBe(stateText.on);
  });
  await waitAttached(raw, tab, true);
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
