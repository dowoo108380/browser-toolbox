import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  featureCommand,
  settingsUpdate,
  storageEnsureReady,
  tabStateGet,
  tabToggleSet,
} from '../../src/contracts/index.ts';
import { features } from '../../src/features/list.ts';
import { type FakeStore, createFakeStore } from '../../src/platform/fake.ts';
import type { Requester, Sender } from '../../src/platform/index.ts';
import { ok } from '../../src/shared/index.ts';
import {
  parseTabToggleHint,
  parseTabToggles,
  settingsKey,
  tabIsOn,
  tabNotice,
  tabToggleHintKey,
  tabTogglesKey,
} from '../../src/storage/index.ts';
import { startTestBackgroundFrom } from '../support/background.ts';
import { type FakeBrowser, createFakeBrowser } from '../support/fake-browser.ts';

// 페이지 활성 상태 유지(TAB-2)의 서비스 워커 쪽을 실제 모듈끼리 잇는다(quality 094): 서비스 워커(라우터, 설정 저장, 디버거 관리,
// 탭마다 켜고 끄기의 공용 부분)와 기능의 서비스 워커 쪽(features/tab-keep-active/background.ts). 가짜는 Chrome 경계뿐이다:
// 저장소, 탭·창·디버거(tests/support/fake-browser.ts), 시계(가짜 타이머). 페이지 쪽은 콘텐츠 스크립트가 보낼 요청으로 흉내 낸다.

const feature = 'tab-keep-active';
const ledgerKey = 'keepActiveLedger';

interface World {
  readonly browser: FakeBrowser;
  readonly store: FakeStore;
  readonly session: FakeStore;
  readonly popup: Requester;
  readonly from: (sender: Sender) => Requester;
}

// 몇 번의 약속 차례와 0ms 타이머를 흘린다(서비스 워커의 일은 여러 await를 거친다).
async function settle() {
  for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(0);
}

async function startWorld(
  browser = createFakeBrowser(),
  store = createFakeStore(),
  session = createFakeStore(),
): Promise<World> {
  const from = startTestBackgroundFrom({
    store,
    session,
    features,
    startTime: 1_790_000_000_000,
    browser,
  });
  const popup = from({ kind: 'extension' });
  await popup(storageEnsureReady, {});
  await settle();
  return { browser, store, session, popup, from };
}

// 창 1에 탭 셋: 1(활성, 보는 탭), 2, 3. 모두 웹 페이지다.
function threeTabs() {
  const browser = createFakeBrowser();
  browser.open({ id: 1, active: true });
  browser.open({ id: 2 });
  browser.open({ id: 3 });
  return browser;
}

const methods = (world: World, tabId: number) =>
  world.browser.commands.filter((call) => call.tabId === tabId).map((call) => call.method);

const ledger = (world: World) => world.store.peek(ledgerKey);

const records = (world: World) => parseTabToggles(world.session.peek(tabTogglesKey)) ?? {};

async function turn(world: World, tabIds: readonly number[], on: boolean) {
  expect(await world.popup(tabToggleSet, { featureId: feature, tabIds: [...tabIds], on })).toEqual(
    ok(null),
  );
  await settle();
}

async function setAllTabs(world: World, enabled: boolean) {
  const saved = await world.popup(settingsUpdate, { featureId: feature, patch: { enabled } });
  expect(saved.ok).toBe(true);
  // 설정의 바뀜 알림은 서비스 워커의 읽기 도우미로 돌아온다(가짜 저장소는 곧바로 알린다).
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TAB-2 보는 탭과 보지 않는 탭(결정 0041)', () => {
  it('TAB-2.16 TAB-2 기대 동작 5 보는 탭에서 켜면 디버거를 붙이지 않고, 비우기를 막으며 원래 값을 장부에 적는다', async () => {
    const world = await startWorld(threeTabs());
    await turn(world, [1], true);
    expect(world.browser.attached()).toEqual([]);
    expect(world.browser.tab(1)?.autoDiscardable).toBe(false);
    expect(ledger(world)).toEqual({ '1': { discardable: true } });
    expect(world.browser.pushes.at(-1)).toEqual({ tabId: 1, state: { on: [feature] } });
  });

  it('TAB-2.1 다른 탭으로 가면 붙여 초점을 흉내 내고 페이지를 활성 상태로 둔다. 돌아오면 초점 흉내를 끄고 뗀다', async () => {
    const world = await startWorld(threeTabs());
    await turn(world, [1], true);
    world.browser.activate(2);
    await settle();
    expect(world.browser.attached()).toEqual([1]);
    expect(methods(world, 1)).toEqual([
      'Emulation.setFocusEmulationEnabled',
      'Page.setWebLifecycleState',
    ]);
    world.browser.activate(1);
    await settle();
    expect(world.browser.attached()).toEqual([]);
    expect(world.browser.commands.at(-1)).toEqual({
      tabId: 1,
      method: 'Emulation.setFocusEmulationEnabled',
      params: { enabled: false },
    });
  });

  it('TAB-2.2 창을 최소화하면 붙이고, 되살리면 뗀다. 다른 창으로 옮겨 그 창의 활성 탭이 되면 뗀다', async () => {
    const world = await startWorld(threeTabs());
    await turn(world, [1], true);
    world.browser.minimize(1, true);
    await settle();
    expect(world.browser.attached()).toEqual([1]);
    world.browser.minimize(1, false);
    await settle();
    expect(world.browser.attached()).toEqual([]);
    world.browser.activate(2);
    await settle();
    expect(world.browser.attached()).toEqual([1]);
    world.browser.moveToWindow(1, 2);
    await settle();
    expect(world.browser.attached()).toEqual([]);
  });

  it('TAB-2.25 분할 보기로 활성 탭과 나란히 놓인 탭은 보는 탭이라 떼고, 다른 탭이 활성이 되거나 분할을 풀면 붙인다', async () => {
    const world = await startWorld(threeTabs());
    await turn(world, [2], true);
    expect(world.browser.attached()).toEqual([2]);
    world.browser.split([1, 2], 7);
    await settle();
    expect(world.browser.attached()).toEqual([]);
    // 분할 보기 안에서 활성 탭을 바꿔도 둘 다 나와 있다.
    world.browser.activate(2);
    await settle();
    world.browser.activate(1);
    await settle();
    expect(world.browser.attached()).toEqual([]);
    world.browser.activate(3);
    await settle();
    expect(world.browser.attached()).toEqual([2]);
    world.browser.activate(1);
    await settle();
    expect(world.browser.attached()).toEqual([]);
    world.browser.split([1, 2], null);
    await settle();
    expect(world.browser.attached()).toEqual([2]);
  });

  it('TAB-2.5 TAB-2.21 끄면 떼고 비우기를 원래 값으로 되돌린 뒤 장부에서 지운다. 탭에 꺼짐을 알린다', async () => {
    const world = await startWorld(threeTabs());
    await turn(world, [1, 2], true);
    expect(world.browser.attached()).toEqual([2]);
    await turn(world, [1, 2], false);
    expect(world.browser.attached()).toEqual([]);
    expect(world.browser.tab(1)?.autoDiscardable).toBe(true);
    expect(world.browser.tab(2)?.autoDiscardable).toBe(true);
    expect(ledger(world)).toEqual({});
    expect(world.browser.pushes.slice(-2)).toEqual([
      { tabId: 1, state: { on: [] } },
      { tabId: 2, state: { on: [] } },
    ]);
  });

  it('TAB-2.21 원래 비울 수 없게 되어 있던 탭은 끈 뒤에도 그대로다', async () => {
    const browser = createFakeBrowser();
    browser.open({ id: 1, active: true, autoDiscardable: false });
    const world = await startWorld(browser);
    await turn(world, [1], true);
    expect(ledger(world)).toEqual({ '1': { discardable: false } });
    await turn(world, [1], false);
    expect(world.browser.tab(1)?.autoDiscardable).toBe(false);
  });

  it('TAB-2.4 디버거를 붙이지 못하면 그 탭을 끄고 까닭을 남기며, 사용자가 다시 켤 때까지 다시 붙이지 않는다', async () => {
    const world = await startWorld(threeTabs());
    world.browser.refuse(2);
    await turn(world, [2], true);
    expect(tabNotice(records(world), feature, 2)).toBe('attach-failed');
    expect(world.browser.attached()).toEqual([]);
    expect(world.browser.tab(2)?.autoDiscardable).toBe(true);
    world.browser.activate(3);
    await settle();
    expect(world.browser.attached()).toEqual([]);
    expect(await world.from({ kind: 'content', tabId: 2, frameId: 0 })(tabStateGet, {})).toEqual(
      ok({ on: [] }),
    );
  });

  it('TAB-2.7 디버깅 안내 막대에서 취소하면 켜진 탭이 모두 꺼지고 까닭을 남기며 다시 붙이지 않는다', async () => {
    const world = await startWorld(threeTabs());
    await turn(world, [1, 2, 3], true);
    expect(world.browser.attached()).toEqual([2, 3]);
    world.browser.cancelDebugging();
    await settle();
    for (const tabId of [1, 2, 3]) {
      expect(tabNotice(records(world), feature, tabId)).toBe('cancelled');
    }
    world.browser.activate(2);
    await settle();
    expect(world.browser.attached()).toEqual([]);
    expect(world.browser.tab(1)?.autoDiscardable).toBe(true);
  });

  it('TAB-2.7 "모든 탭" 스위치가 켜져 있었으면 취소할 때 스위치도 끈다(새 탭에도 다시 붙이지 않는다)', async () => {
    const world = await startWorld(threeTabs());
    await setAllTabs(world, true);
    expect(world.browser.attached()).toEqual([2, 3]);
    world.browser.cancelDebugging();
    await settle();
    const settings = world.store.peek(settingsKey);
    expect(settings).toMatchObject({ features: { [feature]: { enabled: false } } });
    expect(tabNotice(records(world), feature, 2)).toBe('cancelled');
    world.browser.open({ id: 4 });
    await settle();
    expect(world.browser.attached()).toEqual([]);
  });

  it('TAB-2.8 탭을 닫으면 그 탭의 기록과 장부가 남지 않는다', async () => {
    const world = await startWorld(threeTabs());
    await turn(world, [2], true);
    world.browser.close(2);
    await settle();
    expect(records(world)[feature]?.tabs['2']).toBeUndefined();
    expect(ledger(world)).toEqual({});
    expect(world.browser.attached()).toEqual([]);
  });

  it('TAB-2.22 웹 페이지가 아닌 화면으로 이동하면 쉬고, 웹 페이지로 돌아오면 다시 붙인다', async () => {
    const world = await startWorld(threeTabs());
    await turn(world, [2], true);
    world.browser.navigate(2, 'chrome://version/');
    await settle();
    expect(world.browser.attached()).toEqual([]);
    expect(world.browser.tab(2)?.autoDiscardable).toBe(false);
    world.browser.navigate(2, 'https://example.test/next');
    await settle();
    expect(world.browser.attached()).toEqual([2]);
    expect(methods(world, 2).slice(-2)).toEqual([
      'Emulation.setFocusEmulationEnabled',
      'Page.setWebLifecycleState',
    ]);
  });

  it('TAB-2.22 이동하는 중에 Chrome이 붙이기를 거절해도(갈 곳이 Chrome 내부 화면) 끄지 않고, 다 실으면 쉬다가 웹 페이지로 돌아오면 붙인다', async () => {
    const world = await startWorld(threeTabs());
    await turn(world, [2], true);
    expect(world.browser.attached()).toEqual([2]);
    world.browser.startNavigation(2, 'chrome://version/');
    await settle();
    expect(world.browser.attached()).toEqual([]);
    expect(tabIsOn(records(world), feature, 2, false)).toBe(true);
    expect(tabNotice(records(world), feature, 2)).toBeNull();
    world.browser.finishNavigation(2);
    await settle();
    expect(world.browser.attached()).toEqual([]);
    expect(tabNotice(records(world), feature, 2)).toBeNull();
    world.browser.startNavigation(2, 'https://example.test/next');
    world.browser.finishNavigation(2);
    await settle();
    expect(world.browser.attached()).toEqual([2]);
  });

  it('Chrome이 탭을 바꾸면(tabs.onReplaced) 기록과 장부를 새 탭으로 옮겨 그대로 켜 둔다', async () => {
    const world = await startWorld(threeTabs());
    await turn(world, [2], true);
    world.browser.replace(9, 2);
    await settle();
    expect(ledger(world)).toEqual({ '9': { discardable: true } });
    expect(world.browser.attached()).toEqual([9]);
  });
});

describe('TAB-2 "모든 탭" 스위치(결정 0043)', () => {
  it('TAB-2.20 켜면 열린 탭과 그 뒤에 연 탭이 켜진다. 스위치가 켜진 동안 끈 탭은 꺼진 채이고, 스위치를 끄면 모두 꺼진다', async () => {
    const world = await startWorld(threeTabs());
    await setAllTabs(world, true);
    expect(world.browser.attached()).toEqual([2, 3]);
    expect(world.store.peek(tabToggleHintKey)).toEqual([feature]);
    world.browser.open({ id: 4 });
    await settle();
    expect(world.browser.attached()).toEqual([2, 3, 4]);
    expect(world.browser.tab(4)?.autoDiscardable).toBe(false);
    await turn(world, [3], false);
    expect(world.browser.attached()).toEqual([2, 4]);
    world.browser.activate(2);
    await settle();
    expect(world.browser.attached()).toEqual([1, 4]);
    await setAllTabs(world, false);
    expect(world.browser.attached()).toEqual([]);
    expect(records(world)[feature]).toEqual({ allTabs: false, tabs: {} });
    expect(world.store.peek(tabToggleHintKey)).toEqual([]);
    expect(world.browser.tab(4)?.autoDiscardable).toBe(true);
  });

  it('결정 0043 스위치를 바꾸면 모든 탭에 그 탭의 상태를 알린다', async () => {
    const world = await startWorld(threeTabs());
    const before = world.browser.pushes.length;
    await setAllTabs(world, true);
    expect(world.browser.pushes.slice(before)).toEqual([
      { tabId: 1, state: { on: [feature] } },
      { tabId: 2, state: { on: [feature] } },
      { tabId: 3, state: { on: [feature] } },
    ]);
  });
});

describe('TAB-2 서비스 워커의 다시 시작과 확장 다시 불러오기(결정 0038, COM-7)', () => {
  it('COM-7.5 서비스 워커가 다시 시작해도 켜진 탭은 그대로이고 보지 않는 탭에 다시 붙인다', async () => {
    const first = await startWorld(threeTabs());
    await turn(first, [1, 2], true);
    // 다음 서비스 워커: 같은 저장소(storage.session도 남음), 같은 Chrome(앞 연결도 남음).
    const second = await startWorld(first.browser, first.store, first.session);
    expect(second.browser.attached()).toEqual([2]);
    second.browser.activate(2);
    await settle();
    expect(second.browser.attached()).toEqual([1]);
  });

  it('COM-7.6 TAB-2.21 TAB-2.23 확장을 다시 불러오면 탭마다 켠 것은 꺼지고, 장부의 원래 값으로 되돌린다', async () => {
    const first = await startWorld(threeTabs());
    await turn(first, [1, 2], true);
    first.browser.extensionReloaded();
    const second = await startWorld(first.browser, first.store, createFakeStore());
    expect(second.browser.attached()).toEqual([]);
    expect(second.browser.tab(1)?.autoDiscardable).toBe(true);
    expect(second.browser.tab(2)?.autoDiscardable).toBe(true);
    expect(ledger(second)).toEqual({});
  });

  it('TAB-2.23 "모든 탭" 스위치를 켜 두었으면 다시 불러온 뒤에도 열린 탭이 켜진다', async () => {
    const first = await startWorld(threeTabs());
    await setAllTabs(first, true);
    first.browser.extensionReloaded();
    const second = await startWorld(first.browser, first.store, createFakeStore());
    expect(second.browser.attached()).toEqual([2, 3]);
    expect(second.browser.tab(1)?.autoDiscardable).toBe(false);
  });

  it('결정 0038 앞 서비스 워커가 장부를 쓴 뒤 비우기를 막기 전에 멈췄어도 다음 시작이 맞춘다', async () => {
    const browser = threeTabs();
    const store = createFakeStore();
    const session = createFakeStore();
    // 앞 서비스 워커는 장부와 탭마다의 기록을 썼고 Chrome 상태는 바꾸지 못했다.
    await store.set({ [ledgerKey]: { '2': { discardable: true } } });
    await session.set({
      [tabTogglesKey]: {
        [feature]: { allTabs: false, tabs: { '2': { choice: true, notice: null } } },
      },
    });
    const world = await startWorld(browser, store, session);
    expect(world.browser.tab(2)?.autoDiscardable).toBe(false);
    expect(world.browser.attached()).toEqual([2]);
  });

  it('결정 0038 끄는 기록을 쓴 뒤 되돌리기 전에 멈췄어도 다음 시작이 원래 값으로 되돌리고 남은 연결을 뗀다', async () => {
    const first = await startWorld(threeTabs());
    await turn(first, [2], true);
    // 끈 기록만 남고 Chrome 상태(연결, 비우기 막기)와 장부는 그대로인 채 멈췄다.
    await first.session.set({
      [tabTogglesKey]: { [feature]: { allTabs: false, tabs: {} } },
    });
    const second = await startWorld(first.browser, first.store, first.session);
    expect(second.browser.attached()).toEqual([]);
    expect(second.browser.tab(2)?.autoDiscardable).toBe(true);
    expect(ledger(second)).toEqual({});
  });
});

describe('TAB-2 가려진 창(결정 0041)', () => {
  const hidden = (world: World, tabId: number, frameId = 0) =>
    world.from({ kind: 'content', tabId, frameId })(featureCommand, {
      featureId: feature,
      name: 'hidden',
      payload: { hidden: true },
    });

  it('TAB-2.18 보는 탭인데 페이지가 숨김을 알리면(창이 가려짐) 붙이고, 그 창이 다시 초점을 얻으면 뗀다', async () => {
    const world = await startWorld(threeTabs());
    await turn(world, [1], true);
    world.browser.focus(1, false);
    expect(await hidden(world, 1)).toEqual(ok(null));
    await settle();
    expect(world.browser.attached()).toEqual([1]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(world.browser.attached()).toEqual([1]);
    world.browser.focus(1, true);
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(world.browser.attached()).toEqual([]);
  });

  it('TAB-2.2 창의 사건이 오지 않아도(화면 없는 Chrome의 최소화) 페이지가 숨김을 알리면 그 탭을 맞춘다', async () => {
    const world = await startWorld(threeTabs());
    await turn(world, [1], true);
    world.browser.minimize(1, true, false);
    expect(await hidden(world, 1)).toEqual(ok(null));
    await settle();
    expect(world.browser.attached()).toEqual([1]);
  });

  it('창에 초점이 있으면 숨김을 알려도 가려진 것으로 보지 않는다. 꺼진 탭과 iframe이 보낸 숨김은 받지 않는다', async () => {
    const world = await startWorld(threeTabs());
    await turn(world, [1], true);
    await hidden(world, 1);
    await settle();
    expect(world.browser.attached()).toEqual([]);
    world.browser.focus(1, false);
    const fromFrame = await hidden(world, 1, 3);
    expect(fromFrame.ok ? null : fromFrame.error.kind).toBe('permission');
    await hidden(world, 2);
    await settle();
    expect(world.browser.attached()).toEqual([]);
  });
});

describe('TAB-2 가짜 입력(TAB-2 기대 동작 7)', () => {
  const pair = { first: { x: 40, y: 50 }, second: { x: 41, y: 50 } };
  const inputs = (world: World, tabId: number) =>
    world.browser.commands
      .filter((call) => call.tabId === tabId && call.method === 'Input.dispatchMouseEvent')
      .map((call) => call.params);

  it('TAB-2.10 TAB-2.11 보지 않는 탭이 된 지 1분 뒤부터 1분마다 안전한 두 점으로 번갈아 마우스를 옮긴다', async () => {
    const world = await startWorld(threeTabs());
    const asked: unknown[] = [];
    world.browser.answerCommands((tabId, message) => {
      asked.push({ tabId, ...message });
      return { delivery: 'delivered', value: { pair } };
    });
    await turn(world, [1], true);
    world.browser.activate(2);
    await settle();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(inputs(world, 1)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(inputs(world, 1)).toEqual([{ type: 'mouseMoved', x: 40, y: 50 }]);
    expect(asked).toEqual([
      { tabId: 1, featureId: feature, name: 'point', payload: { keep: null } },
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(inputs(world, 1)).toEqual([
      { type: 'mouseMoved', x: 40, y: 50 },
      { type: 'mouseMoved', x: 41, y: 50 },
    ]);
    expect(asked.at(-1)).toMatchObject({ payload: { keep: pair } });
  });

  it('TAB-2.12 TAB-2.13 보는 탭에는 3분이 지나도 보내지 않는다', async () => {
    const world = await startWorld(threeTabs());
    world.browser.answerCommands(() => ({ delivery: 'delivered', value: { pair } }));
    await turn(world, [1], true);
    await vi.advanceTimersByTimeAsync(180_000);
    await settle();
    expect(inputs(world, 1)).toEqual([]);
  });

  it('TAB-2.15 안전한 곳이 없으면 보내지 않고 까닭을 남기며, 다시 찾으면 지운다. 보는 탭이 되면 지운다', async () => {
    const world = await startWorld(threeTabs());
    let answer: typeof pair | null = null;
    world.browser.answerCommands(() => ({ delivery: 'delivered', value: { pair: answer } }));
    await turn(world, [1], true);
    world.browser.activate(2);
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(inputs(world, 1)).toEqual([]);
    expect(tabNotice(records(world), feature, 1)).toBe('no-safe-point');
    answer = pair;
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(inputs(world, 1)).toHaveLength(1);
    expect(tabNotice(records(world), feature, 1)).toBeNull();
    answer = null;
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(tabNotice(records(world), feature, 1)).toBe('no-safe-point');
    world.browser.activate(1);
    await settle();
    expect(tabNotice(records(world), feature, 1)).toBeNull();
  });

  it('받는 쪽이 없는 탭(새로 고치기 전 등)에는 보내지 않고 다음 차례에 다시 묻는다', async () => {
    const world = await startWorld(threeTabs());
    await turn(world, [1], true);
    world.browser.activate(2);
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(inputs(world, 1)).toEqual([]);
    world.browser.answerCommands(() => ({ delivery: 'delivered', value: { pair } }));
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(inputs(world, 1)).toHaveLength(1);
  });
});

describe('TAB-2 콘텐츠 스크립트가 묻는 탭의 상태(결정 0043)', () => {
  it('그 탭에서 켜졌는지로 답하고, 표시는 켜진 탭이 있을 수 있는 동안만 기능 id를 담는다', async () => {
    const world = await startWorld(threeTabs());
    const ask = (tabId: number) =>
      world.from({ kind: 'content', tabId, frameId: 2 })(tabStateGet, {});
    expect(await ask(1)).toEqual(ok({ on: [] }));
    expect(parseTabToggleHint(world.store.peek(tabToggleHintKey))).toEqual([]);
    await turn(world, [1], true);
    expect(await ask(1)).toEqual(ok({ on: [feature] }));
    expect(await ask(2)).toEqual(ok({ on: [] }));
    expect(world.store.peek(tabToggleHintKey)).toEqual([feature]);
    expect(world.browser.listening()).toBe(true);
    await turn(world, [1], false);
    expect(world.store.peek(tabToggleHintKey)).toEqual([]);
    expect(world.browser.listening()).toBe(false);
  });

  it('확장 화면은 탭의 상태를 묻지 못하고, 탭마다 켜고 끄지 않는 기능은 켤 수 없다', async () => {
    const world = await startWorld(threeTabs());
    const fromPopup = await world.popup(tabStateGet, {});
    expect(fromPopup.ok ? null : fromPopup.error.kind).toBe('invalid-input');
    const wrong = await world.popup(tabToggleSet, {
      featureId: 'media-speed',
      tabIds: [1],
      on: true,
    });
    expect(wrong.ok ? null : wrong.error.kind).toBe('invalid-input');
  });
});
