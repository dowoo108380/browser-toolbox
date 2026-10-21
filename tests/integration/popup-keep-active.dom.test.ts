import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { mediaSpeed } from '../../src/features/media-speed/feature.ts';
import { tabKeepActive } from '../../src/features/tab-keep-active/feature.ts';
import { createFakeStore } from '../../src/platform/fake.ts';
import type { PageProbe } from '../../src/platform/index.ts';
import { tabTogglesKey } from '../../src/storage/index.ts';
import { startTestBackground } from '../support/background.ts';
import { createFakeBrowser } from '../support/fake-browser.ts';
import { renderTestPopup } from '../support/popup.ts';

// 팝업에서 탭마다 켜고 끄기(TAB-2 기대 동작 1·8, 결정 0043)를 실제 모듈끼리 연결해 본다. 팝업, 서비스 워커(라우터, 설정 저장,
// 디버거 관리, 탭마다 켜고 끄기, 기능의 서비스 워커 쪽)는 실제 코드이고, 가짜는 저장소와 Chrome(탭·창·디버거)뿐이다.

const features = [mediaSpeed, tabKeepActive];
const containers: HTMLElement[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) {
    render(null, container);
    container.remove();
  }
});

async function settle() {
  await act(async () => {
    for (let step = 0; step < 40; step += 1) await Promise.resolve();
  });
}

// 이 창의 탭: 1(지금 탭)·2·4는 웹 페이지, 3은 새 탭. 탐침(결정 0023, 0045)은 probes에 없는 탭이면 실행 틀이 돈다고 답하고,
// 지금 탭이 아닌 탭은 hold가 풀린 뒤에 답한다. selectTabs가 거짓이면 처음 범주(미디어)로 둔다.
async function openPopup({
  probes = {},
  selectTabs = true,
  hold = Promise.resolve(),
}: {
  readonly probes?: Readonly<Record<number, PageProbe>>;
  readonly selectTabs?: boolean;
  readonly hold?: Promise<void>;
} = {}) {
  const browser = createFakeBrowser();
  browser.open({ id: 1, active: true, url: 'https://a.test/' });
  browser.open({ id: 2, url: 'https://b.test/' });
  browser.open({ id: 3, url: 'chrome://newtab/' });
  browser.open({ id: 4, url: 'https://d.test/' });
  const store = createFakeStore();
  const session = createFakeStore();
  const probed: number[] = [];
  const request = startTestBackground({
    store,
    session,
    features,
    startTime: 1,
    browser,
    probePage: async (tabId) => {
      probed.push(tabId);
      if (tabId !== 1) await hold;
      return probes[tabId] ?? { status: 'ran', marker: 'common' };
    },
  });
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  await renderTestPopup(container, {
    store,
    session,
    request,
    features,
    currentTab: () => Promise.resolve({ ok: true, value: 1 }),
    windowTabs: () => browser.deps.allTabInfos(),
  });
  await settle();
  if (selectTabs) await selectCategory(container, '탭');
  return { browser, store, session, container, probed };
}

async function selectCategory(container: HTMLElement, name: string) {
  const category = [...container.querySelectorAll<HTMLElement>('[role=tab]')].find(
    (tab) => tab.textContent === name,
  );
  await act(() => {
    category?.click();
  });
  await settle();
}

const row = (container: HTMLElement, tabId: number) =>
  container.querySelector<HTMLElement>(`[data-tab="${String(tabId)}"]`);

const stateOf = (container: HTMLElement, tabId: number) =>
  row(container, tabId)?.querySelector('.state')?.textContent ?? null;

async function choose(container: HTMLElement, tabIds: readonly number[]) {
  for (const tabId of tabIds) {
    const box = row(container, tabId)?.querySelector<HTMLInputElement>('input[type=checkbox]');
    await act(() => {
      box?.click();
    });
  }
}

async function press(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) throw new Error(`${label} 단추가 없다.`);
  await act(() => {
    button.click();
  });
  await settle();
}

describe('팝업의 탭마다 켜고 끄기(TAB-2)', () => {
  it('TAB-2.19 이 창의 탭을 보이고, 탭 둘을 골라 켜면 둘 다 켜짐이며, 하나를 골라 끄면 그 탭만 꺼진다', async () => {
    const { container, browser } = await openPopup();
    expect(stateOf(container, 1)).toBe('꺼짐');
    expect(row(container, 1)?.textContent).toContain('탭 1');
    await choose(container, [1, 2]);
    await press(container, '고른 탭 켜기');
    expect(stateOf(container, 1)).toBe('켜짐');
    expect(stateOf(container, 2)).toBe('켜짐');
    // 보지 않는 탭(2)에만 디버거가 붙는다(TAB-2.16).
    expect(browser.attached()).toEqual([2]);
    await choose(container, [2]);
    await press(container, '고른 탭 끄기');
    expect(stateOf(container, 1)).toBe('켜짐');
    expect(stateOf(container, 2)).toBe('꺼짐');
  });

  it('TAB-2.19 웹 페이지가 아닌 탭에는 쓸 수 없는 이유가 보인다', async () => {
    const { container } = await openPopup();
    expect(stateOf(container, 3)).toBe('꺼짐 · 쓸 수 없음: 웹 페이지에서만 쓸 수 있음');
  });

  it('TAB-2.4 TAB-2 기대 동작 8 기능이 남긴 까닭을 그 탭에 보인다', async () => {
    const { container, browser } = await openPopup();
    browser.refuse(2);
    await choose(container, [2]);
    await press(container, '고른 탭 켜기');
    expect(stateOf(container, 2)).toBe(`꺼짐 · ${tabKeepActive.notices['attach-failed'] ?? ''}`);
  });

  it('TAB-2.20 "모든 탭" 스위치를 켜면 모든 탭이 켜짐으로 보이고, 끄면 꺼짐으로 보인다', async () => {
    const { container, session } = await openPopup();
    const allTabs = container.querySelector<HTMLInputElement>(
      `[data-feature="${tabKeepActive.id}"]`,
    );
    expect(allTabs?.getAttribute('role')).toBe('switch');
    await act(() => {
      allTabs?.click();
    });
    await settle();
    expect(stateOf(container, 1)).toBe('켜짐');
    expect(stateOf(container, 2)).toBe('켜짐');
    expect(session.peek(tabTogglesKey)).toMatchObject({ [tabKeepActive.id]: { allTabs: true } });
    await act(() => {
      allTabs?.click();
    });
    await settle();
    expect(stateOf(container, 1)).toBe('꺼짐');
  });

  it('COM-7 기대 동작 2 TAB-2 기대 동작 8 결정 0045 지금 탭이 아니어도 새로 고쳐야 하는 탭과 확장이 접근할 수 없는 탭에는 그 이유가 보이고, 켜도 그대로다', async () => {
    const { container } = await openPopup({
      probes: { 2: { status: 'ran', marker: null }, 4: { status: 'unavailable' } },
    });
    expect(stateOf(container, 1)).toBe('꺼짐');
    expect(stateOf(container, 2)).toBe('꺼짐 · 쓸 수 없음: 이 탭을 새로 고쳐야 쓸 수 있음');
    expect(stateOf(container, 3)).toBe('꺼짐 · 쓸 수 없음: 웹 페이지에서만 쓸 수 있음');
    expect(stateOf(container, 4)).toBe('꺼짐 · 쓸 수 없음: 확장이 이 페이지에 접근할 수 없음');
    await choose(container, [2]);
    await press(container, '고른 탭 켜기');
    expect(stateOf(container, 2)).toBe('켜짐 · 쓸 수 없음: 이 탭을 새로 고쳐야 쓸 수 있음');
  });

  it('결정 0045 탭 목록이 보이기 전에는 다른 탭에 탐침을 넣지 않고, 보이면 웹 페이지 탭에 한 번만 넣는다', async () => {
    const { container, probed } = await openPopup({ selectTabs: false });
    // 지금 탭의 상태(tab.status)만 물었다.
    expect(probed).toEqual([1]);
    await selectCategory(container, '탭');
    expect(probed.toSorted((a, b) => a - b)).toEqual([1, 1, 2, 4]);
    await selectCategory(container, '미디어');
    await selectCategory(container, '탭');
    expect(probed).toHaveLength(4);
  });

  it('결정 0045 탭마다 쓸 수 없는 이유를 확인하는 동안 목록은 바쁨(aria-busy)이고, 답을 받으면 이유가 더해지며 풀린다', async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { container } = await openPopup({ probes: { 2: { status: 'ran', marker: null } }, hold });
    const list = () => container.querySelector('.tab-toggle ul');
    expect(list()?.getAttribute('aria-busy')).toBe('true');
    expect(stateOf(container, 2)).toBe('꺼짐');
    release();
    await settle();
    expect(list()?.hasAttribute('aria-busy')).toBe(false);
    expect(stateOf(container, 2)).toBe('꺼짐 · 쓸 수 없음: 이 탭을 새로 고쳐야 쓸 수 있음');
  });

  it('고른 탭이 없으면 켜기·끄기 단추가 막혀 있다(키보드로 눌러도 보내지 않는다)', async () => {
    const { container, browser } = await openPopup();
    const on = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '고른 탭 켜기',
    );
    expect(on?.getAttribute('aria-disabled')).toBe('true');
    await press(container, '고른 탭 켜기');
    expect(browser.pushes).toEqual([]);
  });
});
