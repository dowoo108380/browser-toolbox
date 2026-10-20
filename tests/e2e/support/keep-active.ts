import { test as base, expect } from '@playwright/test';
import { settingsUpdate, tabToggleSet, v } from '../../../src/contracts/index.ts';
import { tabKeepActive } from '../../../src/features/tab-keep-active/feature.ts';
import { fixtureOrigin } from './extension.ts';
import { type Popup, type RawChromium, type RawTab, launchRawChromium } from './raw-chromium.ts';

// 페이지 활성 상태 유지(TAB-2)의 확장 전체 시험 도우미. 보임과 초점이 진짜여야 하므로 Playwright의 페이지 대신 직접 띄운
// Chromium(raw-chromium.ts)을 쓴다. 시험 페이지(tests/fixtures/keep-active.html)에 보임·초점·입력을 기록하는 코드를 시험이
// 넣는다(시험 페이지에는 실행 코드를 두지 않는다). 기록하는 코드는 페이지의 첫 스크립트보다 늦게 들어가므로, 페이지 쪽 방패가
// 먼저 건 듣기보다 뒤에 듣는다. 실제 사이트의 스크립트와 같은 자리다.

export const featureId = tabKeepActive.id;
export const pageUrl = `${fixtureOrigin}/keep-active.html`;
export const coveredUrl = `${fixtureOrigin}/keep-active-covered.html`;
export const blankUrl = `${fixtureOrigin}/blank.html`;
// 시험 페이지 안의 다른 사이트 iframe(주소의 일부).
const framePart = 'keep-active-frame.html';

export const test = base.extend<{
  // Chromium에 더 줄 인자(TAB-2.3의 타이머 시험이 쓴다).
  chromiumArgs: string[];
  raw: RawChromium;
}>({
  chromiumArgs: [[], { option: true }],
  raw: async ({ chromiumArgs }, use, testInfo) => {
    const raw = await launchRawChromium(testInfo.outputPath('profile'), { args: chromiumArgs });
    await use(raw);
    await raw.close();
  },
});

export { expect };

export interface AwayRule {
  // 숨김이거나 초점이 없는 것이 이만큼 이어지면 자리 비움으로 판단한다(TAB-2.9).
  readonly hiddenMs: number;
  // 마우스·키보드 입력이 이만큼 없으면 자리 비움으로 판단한다(TAB-2.10).
  readonly idleMs: number;
}

const recordSchema = v.object({
  // 창의 초점, 문서의 보임과 생애 주기 이벤트. state는 blur·focus면 신뢰된 것인지, 나머지는 그때의 보임이다.
  events: v.array(v.object({ type: v.string(), state: v.string() })),
  // 받은 마우스·키보드·스크롤 입력과 그 위치(클라이언트 좌표, 마우스가 아니면 -1).
  inputs: v.array(v.object({ type: v.string(), x: v.number(), y: v.number() })),
  // 마우스가 올라간 요소(id나 태그 이름).
  hovered: v.array(v.string()),
  // 자리 비움으로 판단한 까닭(hidden, idle).
  away: v.array(v.string()),
  // 1초마다 도는 타이머가 돈 시각(Date.now).
  ticks: v.array(v.number()),
  visibility: v.string(),
  focused: v.boolean(),
  // 이 문서가 화면을 그리는지(requestAnimationFrame이 1초 안에 돌았는지). 페이지 쪽 방패가 바꾸지 않는 진짜 보임이다.
  painting: v.boolean(),
});

export type Recorded = v.InferOutput<typeof recordSchema>;

// 페이지에서 돈다. 보임·초점·입력을 기록하고, away의 규칙으로 자리 비움을 판단한다(최상위 문서만 규칙을 받는다). 사이트가 하듯
// 창과 문서에서 듣는다.
function installRecorder(away: AwayRule | null): null {
  const events: { type: string; state: string }[] = [];
  const inputs: { type: string; x: number; y: number }[] = [];
  const hovered: string[] = [];
  const reasons: string[] = [];
  const ticks: number[] = [];
  Reflect.set(window, '__keepActive', { events, inputs, hovered, away: reasons, ticks });
  for (const type of ['blur', 'focus']) {
    window.addEventListener(
      type,
      (event) => {
        if (event.target === window) events.push({ type, state: String(event.isTrusted) });
      },
      true,
    );
  }
  for (const type of ['visibilitychange', 'freeze', 'resume']) {
    document.addEventListener(type, () => {
      events.push({ type, state: document.visibilityState });
    });
  }
  window.addEventListener('pagehide', () => {
    events.push({ type: 'pagehide', state: document.visibilityState });
  });
  let lastInput = Date.now();
  const inputTypes = [
    'mousemove',
    'mousedown',
    'mouseup',
    'click',
    'auxclick',
    'contextmenu',
    'wheel',
    'keydown',
    'keyup',
    'pointerdown',
    'touchstart',
    'scroll',
  ];
  for (const type of inputTypes) {
    window.addEventListener(
      type,
      (event) => {
        lastInput = Date.now();
        const mouse = event instanceof MouseEvent ? event : null;
        inputs.push({ type, x: mouse?.clientX ?? -1, y: mouse?.clientY ?? -1 });
      },
      { capture: true, passive: true },
    );
  }
  document.addEventListener(
    'mouseover',
    (event) => {
      const { target } = event;
      hovered.push(target instanceof Element ? target.id || target.tagName.toLowerCase() : '');
    },
    true,
  );
  setInterval(() => {
    ticks.push(Date.now());
  }, 1000);
  if (away === null) return null;
  let awaySince: number | null = null;
  setInterval(() => {
    const now = Date.now();
    if (document.hidden || !document.hasFocus()) awaySince ??= now;
    else awaySince = null;
    if (awaySince !== null && now - awaySince >= away.hiddenMs) reasons.push('hidden');
    if (now - lastInput >= away.idleMs) reasons.push('idle');
  }, 500);
  return null;
}

// 페이지에서 돈다. 기록과 지금의 보임·초점을 준다.
async function readRecord(): Promise<unknown> {
  const painting = await new Promise<boolean>((resolve) => {
    requestAnimationFrame(() => {
      resolve(true);
    });
    setTimeout(() => {
      resolve(false);
    }, 1000);
  });
  const record: unknown = Reflect.get(window, '__keepActive');
  return {
    ...(typeof record === 'object' ? record : {}),
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    painting,
  };
}

// 페이지에서 돈다. 기록을 비운다(타이머의 시각은 남긴다).
function clearRecord(): null {
  const record: unknown = Reflect.get(window, '__keepActive');
  for (const key of ['events', 'inputs', 'hovered', 'away']) {
    const list: unknown =
      typeof record === 'object' && record !== null ? Reflect.get(record, key) : null;
    if (Array.isArray(list)) list.length = 0;
  }
  return null;
}

// 페이지에서 돈다. 페이지 쪽 방패가 이 문서에서 켜졌는지. 켜지면 document.hasFocus가 Chrome의 것이 아니게 된다
// (features/tab-keep-active/main.ts). 페이지에서 보이는 것은 이것뿐이라 기다리는 데만 쓴다.
function shieldArmed(): boolean {
  const hasFocus: unknown = Object.getOwnPropertyDescriptor(Document.prototype, 'hasFocus')?.value;
  return !String(hasFocus).includes('[native code]');
}

const recorded = (value: unknown): Recorded => v.parse(recordSchema, value);

export function recorder(raw: RawChromium, tab: RawTab) {
  return {
    install: async (away: AwayRule | null = null) => {
      await raw.evaluate(tab, installRecorder, away);
    },
    installInFrame: async () => {
      await raw.evaluateInFrame(tab, framePart, installRecorder, null);
    },
    read: async () => recorded(await raw.evaluate(tab, readRecord, null)),
    readFrame: async () => recorded(await raw.evaluateInFrame(tab, framePart, readRecord, null)),
    clear: async () => {
      await raw.evaluate(tab, clearRecord, null);
    },
    // 페이지 쪽 방패가 최상위 문서(frame이면 다른 사이트의 iframe도)에서 켜지거나(armed) 꺼질 때까지 기다린다.
    waitShield: async (armed: boolean, { frame = false }: { readonly frame?: boolean } = {}) => {
      await expect
        .poll(() => raw.evaluate(tab, shieldArmed, null), { timeout: 10_000 })
        .toBe(armed);
      if (frame) {
        await expect
          .poll(() => raw.evaluateInFrame(tab, framePart, shieldArmed, null), { timeout: 10_000 })
          .toBe(armed);
      }
    },
  };
}

// 확장 화면(팝업 문서)에서 돈다. 서비스 워커에 요청을 보내고 답을 준다(팝업이 보내는 것과 같은 메시지).
function sendRequest(message: {
  readonly type: string;
  readonly payload: unknown;
}): Promise<unknown> {
  return chrome.runtime.sendMessage(message);
}

async function request(raw: RawChromium, type: string, payload: unknown): Promise<void> {
  const popup = await raw.popup();
  try {
    expect(await popup.evaluate(sendRequest, { type, payload })).toMatchObject({ ok: true });
  } finally {
    await closeTab(raw, popup.tab);
  }
}

// 그 탭들을 켜거나 끈다(팝업의 "고른 탭 켜기"·"고른 탭 끄기"가 보내는 요청).
export function turn(raw: RawChromium, tabs: readonly RawTab[], on: boolean): Promise<void> {
  return request(raw, tabToggleSet.type, { featureId, tabIds: tabs.map((tab) => tab.tabId), on });
}

// "모든 탭" 스위치를 켜거나 끈다(팝업의 스위치가 보내는 설정 바꾸기).
export function setAllTabs(raw: RawChromium, enabled: boolean): Promise<void> {
  return request(raw, settingsUpdate.type, { featureId, patch: { enabled } });
}

export async function closeTab(raw: RawChromium, tab: RawTab): Promise<void> {
  await raw.sw((id) => chrome.tabs.remove(id), tab.tabId);
}

// 이 확장의 디버거가 그 탭에 붙어 있는지. 시험 도구는 계산할 때만 붙으므로 이 사이에는 이 확장의 연결만 센다. 탭이 없으면 null이다.
export function attached(raw: RawChromium, tab: RawTab): Promise<boolean | null> {
  return raw.sw(
    async (id) =>
      (await chrome.debugger.getTargets()).find((target) => target.tabId === id)?.attached ?? null,
    tab.tabId,
  );
}

export async function waitAttached(raw: RawChromium, tab: RawTab, on: boolean): Promise<void> {
  await expect.poll(() => attached(raw, tab), { timeout: 10_000 }).toBe(on);
}

// 팝업에서 돈다. "탭" 범주를 고르고, 이 기능의 탭 목록이 그려졌으면 탭마다 상태 글자를 준다(아직이면 null).
function readTabStates(): Record<string, string> | null {
  const category = [...document.querySelectorAll<HTMLElement>('[role=tab]')].find(
    (tab) => tab.textContent === '탭',
  );
  if (category?.getAttribute('aria-selected') !== 'true') category?.click();
  const rows = [...document.querySelectorAll<HTMLElement>('.tab-toggle [data-tab]')];
  if (rows.length === 0) return null;
  return Object.fromEntries(
    rows.map((row) => [row.dataset['tab'] ?? '', row.querySelector('.state')?.textContent ?? '']),
  );
}

// 그 창(없으면 처음 창)에서 팝업을 새로 열어 탭 목록의 상태 글자가 check를 통과할 때까지 기다린다. 팝업은 연 때의 탭을
// 보이므로, 탭이 바뀐 뒤에는 새로 연다(사용자가 팝업을 다시 여는 것과 같다).
export async function popupStates(
  raw: RawChromium,
  check: (states: Readonly<Record<string, string>>) => void,
  windowId?: number,
): Promise<void> {
  const popup = await raw.popup(windowId);
  try {
    await expect
      .poll(
        async () => {
          const states = await popup.evaluate(readTabStates, null);
          if (states === null) return false;
          check(states);
          return true;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  } finally {
    await closeTab(raw, popup.tab);
  }
}

// 팝업에서 돈다. "탭" 범주를 고르고, 그 탭들의 고르는 칸이 모두 그려졌으면 누르고 참을 준다.
function chooseInPopup(ids: readonly number[]): boolean {
  const category = [...document.querySelectorAll<HTMLElement>('[role=tab]')].find(
    (tab) => tab.textContent === '탭',
  );
  if (category?.getAttribute('aria-selected') !== 'true') category?.click();
  const boxes = ids.map((id) =>
    document.querySelector<HTMLInputElement>(`.tab-toggle [data-tab="${String(id)}"] input`),
  );
  if (boxes.some((box) => box === null)) return false;
  for (const box of boxes) box?.click();
  return true;
}

// 팝업에서 돈다. 그 단추가 풀렸으면 누르고 참을 준다.
function pressButton(label: string): boolean {
  const button = [...document.querySelectorAll<HTMLButtonElement>('.tab-toggle button')].find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) return false;
  if (button.getAttribute('aria-disabled') !== null) return false;
  button.click();
  return true;
}

// 팝업의 탭 목록에서 그 탭들을 골라 단추를 누른다. 팝업은 뒤쪽 탭이라 그 문서의 타이머가 늦춰지므로 기다림은 시험 쪽에서 한다.
export async function pressInList(popup: Popup, tabs: readonly RawTab[], button: string) {
  const ids = tabs.map((tab) => tab.tabId);
  await expect.poll(() => popup.evaluate(chooseInPopup, ids), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => popup.evaluate(pressButton, button), { timeout: 10_000 }).toBe(true);
}

// 탭 목록의 상태 글자(src/ui/strings.ts와 기능의 notices).
export const stateText = {
  on: '켜짐',
  off: '꺼짐',
  notWeb: (on: boolean) => `${on ? '켜짐' : '꺼짐'} · 쓸 수 없음: 웹 페이지에서만 쓸 수 있음`,
  notice: (name: keyof typeof tabKeepActive.notices, on: boolean) =>
    `${on ? '켜짐' : '꺼짐'} · ${tabKeepActive.notices[name] ?? ''}`,
};

// 보는 탭처럼 동작하는지(TAB-2.1): 페이지가 보이고 초점이 있다고 읽고, 화면을 그리며, 창의 초점·보임이 바뀐 이벤트를 받지 않았다.
export function expectActiveLike(record: Recorded): void {
  expect(record.visibility).toBe('visible');
  expect(record.focused).toBe(true);
  expect(record.painting).toBe(true);
  expect(record.events).toEqual([]);
}
