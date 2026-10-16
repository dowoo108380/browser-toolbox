import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/mini';
import {
  type Category,
  type FeatureDefinition,
  type PageAccess,
  defineFeature,
} from '../contracts/index.ts';
import { type AppError, type Result, appError, err, ok } from '../shared/index.ts';
import type {
  RepairNotice,
  RepairNoticeHandlers,
  RepairScope,
  SettingsReaderHandlers,
  Snapshot,
} from '../storage/index.ts';
import { PopupApp, keepAwakeIntervalMs } from './popup-app.tsx';

// 팝업 부품(COM-2, COM-3, N-12). 저장소와 서비스 워커는 가짜로 바꿔 끼운다.

const container = document.createElement('div');
document.body.append(container);

afterEach(() => {
  render(null, container);
  vi.useRealTimers();
});

const feature = defineFeature({
  id: 'sample',
  requirements: [],
  name: '시험 기능',
  description: '시험용',
  category: 'media',
  kind: 'toggle',
  content: null,
  permissions: [],
  settings: { schema: z.object({ enabled: z.boolean() }), defaults: { enabled: false } },
});

const off: Snapshot = { features: new Map([['sample', { enabled: false }]]), sites: new Map() };
const saveFailed = appError('platform', '설정을 저장하지 못했다. 저장된 설정은 바뀌지 않았다.');

// 범주가 여럿인 기능 목록. YouTube 범주에는 기능이 없다.
function toggleFeature(id: string, category: Category, name: string): FeatureDefinition {
  return defineFeature({
    id,
    requirements: [],
    name,
    description: `${name} 설명`,
    category,
    kind: 'toggle',
    content: null,
    permissions: [],
    settings: { schema: z.object({ enabled: z.boolean() }), defaults: { enabled: false } },
  });
}

// 초점이 있는 요소에서 키를 누른다(keydown). 확장 화면의 키 처리는 모두 keydown에서 한다.
async function press(
  key: string,
  options: {
    readonly ctrlKey?: boolean;
    readonly code?: string;
    readonly isComposing?: boolean;
  } = {},
) {
  const target = document.activeElement ?? document.body;
  await act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }),
    );
  });
}

const manyCategories = [
  toggleFeature('chat', 'chatgpt', '대화 기능'),
  toggleFeature('speed', 'media', '배속 기능'),
  toggleFeature('hide', 'page', '숨김 기능'),
  toggleFeature('volume', 'media', '음량 기능'),
];

// 그린 뒤 바로 풀리는 Promise(지난번 범주 읽기 등)의 결과까지 그린다.
const settle = () =>
  act(async () => {
    await Promise.resolve();
  });

interface Options {
  readonly features?: readonly FeatureDefinition[];
  readonly wake?: () => Promise<Result<unknown, AppError>>;
  readonly update?: () => Promise<Result<unknown, AppError>>;
  // 지난번 범주를 읽는 함수. 없으면 남긴 범주가 없다.
  readonly readRemembered?: () => Promise<Category | null>;
  readonly remember?: (category: Category) => Promise<Result<unknown, AppError>>;
  readonly currentTab?: () => Promise<number | null>;
  readonly tabStatus?: (tabId: number) => Promise<Result<{ readonly page: PageAccess }, AppError>>;
}

async function show({
  features = [feature],
  wake = () => Promise.resolve(ok(null)),
  update,
  readRemembered = () => Promise.resolve(null),
  remember = () => Promise.resolve(ok(null)),
  currentTab = () => Promise.resolve(7),
  tabStatus = () => Promise.resolve(ok({ page: 'ready' as const })),
}: Options = {}) {
  const updates = vi.fn(update ?? (() => Promise.resolve(ok(null))));
  const wakes = vi.fn(wake);
  const remembers = vi.fn(remember);
  const statuses = vi.fn(tabStatus);
  // 저장된 설정을 바로 준다. 저장이 성공해도 바뀜 알림은 시험이 직접 보낸다.
  let handlers: SettingsReaderHandlers | undefined;
  const subscribe = (next: SettingsReaderHandlers) => {
    handlers = next;
    next.apply(off);
    return () => undefined;
  };
  await act(() => {
    render(
      <PopupApp
        features={features}
        subscribe={subscribe}
        watchRepairs={() => () => undefined}
        wake={wakes}
        update={updates}
        dismissRepair={() => Promise.resolve(ok(null))}
        rememberedCategory={readRemembered}
        rememberCategory={remembers}
        currentTab={currentTab}
        tabStatus={statuses}
      />,
      container,
    );
  });
  await settle();
  const toggle = () => {
    const element = container.querySelector<HTMLInputElement>('[role=switch]');
    if (element === null) throw new Error('스위치가 없다.');
    return element;
  };
  return {
    toggle,
    // 첫 깨우기의 응답을 받아 스위치를 쓸 수 있을 때까지 기다린다.
    awake: () =>
      vi.waitFor(() => {
        expect(toggle().disabled).toBe(false);
      }),
    updates,
    wakes,
    remembers,
    statuses,
    state: () => container.querySelector('.state')?.textContent,
    status: () => container.querySelector('[role=status]')?.textContent,
    apply: (snapshot: Snapshot) => act(() => handlers?.apply(snapshot)),
    tab: (name: string) => {
      const found = [...container.querySelectorAll<HTMLElement>('[role=tab]')].find(
        (element) => element.textContent === name,
      );
      if (found === undefined) throw new Error(`범주 ${name}이 없다.`);
      return found;
    },
    tabNames: () =>
      [...container.querySelectorAll('[role=tab]')].map((element) => element.textContent),
    selectedTab: () => container.querySelector('[role=tab][aria-selected=true]')?.textContent,
    // 지금 보이는 패널의 기능 이름.
    panelFeatures: () =>
      [...container.querySelectorAll('[role=tabpanel] .name')].map(
        (element) => element.textContent,
      ),
  };
}

describe('COM-2 범주 목록(결정 0023)', () => {
  it('기능이 있는 범주만 요구사항 묶음의 순서로 보이고, 처음에는 첫 범주의 기능을 보인다', async () => {
    const popup = await show({ features: manyCategories });
    expect(popup.tabNames()).toEqual(['미디어', '페이지', 'ChatGPT']);
    expect(popup.selectedTab()).toBe('미디어');
    expect(popup.panelFeatures()).toEqual(['배속 기능', '음량 기능']);
    const panel = container.querySelector('[role=tabpanel]');
    expect(panel?.getAttribute('aria-labelledby')).toBe(popup.tab('미디어').id);
    expect(popup.tab('미디어').getAttribute('aria-controls')).toBe(panel?.id);
  });

  it('범주를 누르면 그 범주의 기능을 보인다', async () => {
    const popup = await show({ features: manyCategories });
    await act(() => {
      popup.tab('페이지').click();
    });
    expect(popup.selectedTab()).toBe('페이지');
    expect(popup.panelFeatures()).toEqual(['숨김 기능']);
  });

  it('COM-2.2 아래·위 방향키, Home, End가 다음·이전·처음·끝 범주로 초점을 옮기고 그 범주를 보인다', async () => {
    const popup = await show({ features: manyCategories });
    popup.tab('미디어').focus();
    const steps: [key: string, category: string, features: string[]][] = [
      ['ArrowDown', '페이지', ['숨김 기능']],
      ['ArrowDown', 'ChatGPT', ['대화 기능']],
      // 끝에서는 처음으로, 처음에서는 끝으로 간다.
      ['ArrowDown', '미디어', ['배속 기능', '음량 기능']],
      ['ArrowUp', 'ChatGPT', ['대화 기능']],
      ['ArrowUp', '페이지', ['숨김 기능']],
      ['Home', '미디어', ['배속 기능', '음량 기능']],
      ['End', 'ChatGPT', ['대화 기능']],
    ];
    for (const [key, category, names] of steps) {
      await press(key);
      expect(document.activeElement, key).toBe(popup.tab(category));
      expect(popup.selectedTab(), key).toBe(category);
      expect(popup.panelFeatures(), key).toEqual(names);
    }
  });

  it('범주 목록 안에서는 고른 범주만 Tab으로 들어간다(roving tabindex)', async () => {
    const popup = await show({ features: manyCategories });
    popup.tab('미디어').focus();
    await press('ArrowDown');
    expect(
      [...container.querySelectorAll<HTMLElement>('[role=tab]')].map((tab) => tab.tabIndex),
    ).toEqual([-1, 0, -1]);
  });

  it('조합 키와 함께 누른 방향키로는 범주를 옮기지 않는다', async () => {
    const popup = await show({ features: manyCategories });
    popup.tab('미디어').focus();
    await press('ArrowDown', { ctrlKey: true });
    expect(popup.selectedTab()).toBe('미디어');
  });

  it('COM-2 기대 동작 5 지난번에 고른 범주로 연다', async () => {
    const popup = await show({
      features: manyCategories,
      readRemembered: () => Promise.resolve('page'),
    });
    expect(popup.selectedTab()).toBe('페이지');
    expect(popup.panelFeatures()).toEqual(['숨김 기능']);
  });

  it('지난번 범주에 기능이 없으면(보이지 않는 범주) 첫 범주로 연다', async () => {
    const popup = await show({
      features: manyCategories,
      readRemembered: () => Promise.resolve('youtube'),
    });
    expect(popup.selectedTab()).toBe('미디어');
  });

  it('지난번 범주를 읽기 전에는 범주를 그리지 않는다(첫 범주를 잠깐 보였다가 바꾸지 않는다)', async () => {
    let answer: (category: Category | null) => void = () => undefined;
    const popup = await show({
      features: manyCategories,
      readRemembered: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    expect(container.querySelector('[role=tablist]')).toBeNull();
    answer('chatgpt');
    await settle();
    expect(popup.selectedTab()).toBe('ChatGPT');
  });

  it('범주를 고를 때마다(누르기, 방향키) 그 범주를 남긴다. 연 것만으로는 남기지 않는다', async () => {
    const popup = await show({ features: manyCategories });
    expect(popup.remembers).not.toHaveBeenCalled();
    await act(() => {
      popup.tab('페이지').click();
    });
    popup.tab('페이지').focus();
    await press('ArrowDown');
    expect(popup.remembers.mock.calls).toEqual([['page'], ['chatgpt']]);
  });

  it('범주를 남기지 못해도 알리지 않는다(편의 값이고 서비스 워커가 기록한다)', async () => {
    const popup = await show({
      features: manyCategories,
      remember: () => Promise.resolve(err(appError('platform', '남기지 못했다.'))),
    });
    await act(async () => {
      popup.tab('페이지').click();
      await Promise.resolve();
    });
    expect(popup.selectedTab()).toBe('페이지');
    expect(popup.status()).toBeUndefined();
  });

  it('스위치의 이름은 기능 이름이고, 설명을 그 스위치의 설명으로 잇는다', async () => {
    const popup = await show();
    const description = document.getElementById(
      popup.toggle().getAttribute('aria-describedby') ?? '',
    );
    expect(description?.textContent).toBe('시험용');
    expect(popup.toggle().labels?.[0]?.textContent).toBe('시험 기능');
  });
});

describe('COM-2 기능 검색(결정 0023)', () => {
  function searchBox(): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>('[role=combobox]');
    if (input === null) throw new Error('검색 칸이 없다.');
    return input;
  }

  // 검색 칸에 글자를 넣는다(input 이벤트).
  async function typeQuery(text: string) {
    searchBox().focus();
    await act(() => {
      searchBox().value = text;
      searchBox().dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  const resultNames = () =>
    [...container.querySelectorAll('[role=option] .name')].map((element) => element.textContent);

  it('COM-2.1 어디에 초점이 있든 Ctrl+K를 누르면 검색 칸에 초점이 간다', async () => {
    const popup = await show({ features: manyCategories });
    popup.tab('미디어').focus();
    // 한글 자판에서는 같은 자리의 글자가 'ㅏ'다. 자리(code)로 본다.
    await press('ㅏ', { ctrlKey: true, code: 'KeyK' });
    expect(document.activeElement).toBe(searchBox());
  });

  it('COM-2.1 검색어가 이름이나 설명에 들어간 기능만 보이고, Enter를 누르면 첫 기능의 범주를 골라 그 스위치에 초점을 둔다', async () => {
    const popup = await show({ features: manyCategories });
    await typeQuery('숨김');
    expect(container.querySelector('[role=tablist]')).toBeNull();
    expect(resultNames()).toEqual(['숨김 기능']);
    expect(searchBox().getAttribute('aria-expanded')).toBe('true');
    await press('Enter');
    expect(searchBox().value).toBe('');
    expect(popup.selectedTab()).toBe('페이지');
    expect(document.activeElement).toBe(container.querySelector('[data-feature="hide"]'));
    // 검색으로 간 범주도 고른 범주다.
    expect(popup.remembers.mock.calls).toEqual([['page']]);
  });

  it('결과는 범주 순서이고, 방향키로 고른 기능으로 Enter가 간다', async () => {
    const popup = await show({ features: manyCategories });
    // 모든 기능의 설명에 '설명'이 들어 있다.
    await typeQuery('설명');
    expect(resultNames()).toEqual(['배속 기능', '음량 기능', '숨김 기능', '대화 기능']);
    await press('ArrowDown');
    await press('ArrowDown');
    const chosen = container.querySelector('[role=option][aria-selected=true]');
    expect(chosen?.querySelector('.name')?.textContent).toBe('음량 기능');
    expect(searchBox().getAttribute('aria-activedescendant')).toBe(chosen?.id);
    // 초점은 검색 칸에 남는다.
    expect(document.activeElement).toBe(searchBox());
    await press('Enter');
    expect(popup.selectedTab()).toBe('미디어');
    expect(document.activeElement).toBe(container.querySelector('[data-feature="volume"]'));
  });

  it('결과를 누르면 그 기능으로 간다', async () => {
    const popup = await show({ features: manyCategories });
    await typeQuery('대화');
    await act(() => {
      container.querySelector<HTMLElement>('[role=option]')?.click();
    });
    expect(popup.selectedTab()).toBe('ChatGPT');
    expect(document.activeElement).toBe(container.querySelector('[data-feature="chat"]'));
  });

  it('Esc는 검색어를 지우고 범주 화면으로 돌아간다', async () => {
    const popup = await show({ features: manyCategories });
    await typeQuery('숨김');
    await press('Escape');
    expect(searchBox().value).toBe('');
    expect(popup.selectedTab()).toBe('미디어');
    expect(document.activeElement).toBe(searchBox());
  });

  it('맞는 기능이 없으면 그렇다고 보이고 목록은 펼치지 않는다. Enter는 아무 데도 가지 않는다', async () => {
    await show({ features: manyCategories });
    await typeQuery('자막');
    expect(container.querySelector('.no-results')?.textContent).toBe('맞는 기능이 없다.');
    expect(container.querySelector('[role=listbox]')).toBeNull();
    expect(searchBox().getAttribute('aria-expanded')).toBe('false');
    expect(searchBox().hasAttribute('aria-controls')).toBe(false);
    await press('Enter');
    expect(searchBox().value).toBe('자막');
  });

  it('N-01 한글을 조합하는 중의 Enter는 조합을 끝내는 데 쓰이므로 기능으로 가지 않는다', async () => {
    await show({ features: manyCategories });
    await typeQuery('숨김');
    await press('Enter', { isComposing: true });
    expect(searchBox().value).toBe('숨김');
    expect(resultNames()).toEqual(['숨김 기능']);
  });
});

describe('COM-2 기대 동작 4 지금 탭에서 쓸 수 없는 기능의 이유(결정 0023)', () => {
  // 페이지에 작용하는 기능과 그렇지 않은 기능(시험 기능)이 같은 범주에 있다.
  const onPages = defineFeature({
    ...feature,
    id: 'on-pages',
    name: '페이지 기능',
    content: { sites: 'all', frames: 'all' },
  });
  const both = [onPages, feature];

  const reasonOf = (featureId: string) =>
    container
      .querySelector(`[data-feature="${featureId}"]`)
      ?.closest('li')
      ?.querySelector('.reason')?.textContent ?? null;

  it('COM-2.3 지금 탭에 확장이 접근할 수 없으면 페이지에 작용하는 기능에만 이유를 보이고 스위치의 설명으로 잇는다. 스위치는 막지 않는다', async () => {
    const popup = await show({
      features: both,
      tabStatus: () => Promise.resolve(ok({ page: 'denied' as const })),
    });
    await popup.awake();
    expect(popup.statuses).toHaveBeenCalledWith(7);
    expect(reasonOf('on-pages')).toBe('쓸 수 없음: 확장이 이 페이지에 접근할 수 없음');
    expect(reasonOf('sample')).toBeNull();
    const toggle = container.querySelector<HTMLInputElement>('[data-feature="on-pages"]');
    const described = (toggle?.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(['시험용', '쓸 수 없음: 확장이 이 페이지에 접근할 수 없음']);
    expect(toggle?.disabled).toBe(false);
  });

  it('COM-7 기대 동작 2 실행 틀이 없는 탭이면 새로 고쳐야 쓸 수 있다고 보인다', async () => {
    await show({
      features: both,
      tabStatus: () => Promise.resolve(ok({ page: 'reload' as const })),
    });
    expect(reasonOf('on-pages')).toBe('쓸 수 없음: 이 탭을 새로 고쳐야 쓸 수 있음');
  });

  it('쓸 수 있는 탭이면 이유가 없다', async () => {
    const popup = await show({ features: both });
    expect(popup.statuses).toHaveBeenCalledTimes(1);
    expect(reasonOf('on-pages')).toBeNull();
  });

  it('상태를 얻지 못하면 이유 없이 그 까닭을 알린다', async () => {
    const timeout = appError('timeout', '확장의 응답이 없다. 잠시 뒤 다시 한다.');
    const popup = await show({ features: both, tabStatus: () => Promise.resolve(err(timeout)) });
    expect(popup.status()).toBe(timeout.message);
    expect(reasonOf('on-pages')).toBeNull();
  });

  it('지금 탭을 알 수 없으면 묻지 않고 그렇다고 알린다', async () => {
    const popup = await show({ features: both, currentTab: () => Promise.resolve(null) });
    expect(popup.statuses).not.toHaveBeenCalled();
    expect(popup.status()).toBe('지금 탭을 알 수 없어 기능을 쓸 수 있는지 확인하지 못했다.');
  });
});

describe('COM-3 기대 동작 3 저장에 실패하면 화면은 저장된 값을 보인다', () => {
  it('COM-3.3 같은 저장 실패가 두 번 이어져도 그때마다 스위치를 저장된 값으로 되돌린다', async () => {
    const popup = await show({ update: () => Promise.resolve(err(saveFailed)) });
    await popup.awake();
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await act(async () => {
        popup.toggle().click();
        await Promise.resolve();
      });
      expect(popup.updates).toHaveBeenCalledTimes(attempt);
      expect(popup.toggle().checked).toBe(false);
      expect(popup.state()).toBe('꺼짐');
      expect(popup.status()).toBe(saveFailed.message);
    }
  });

  it('저장이 성공하면 바뀜 알림의 값을 보이고 알림을 지운다', async () => {
    const popup = await show({ update: () => Promise.resolve(err(saveFailed)) });
    await popup.awake();
    await act(async () => {
      popup.toggle().click();
      await Promise.resolve();
    });
    popup.updates.mockImplementation(() => Promise.resolve(ok(null)));
    await act(async () => {
      popup.toggle().click();
      await Promise.resolve();
    });
    await popup.apply({ features: new Map([['sample', { enabled: true }]]), sites: new Map() });
    expect(popup.toggle().checked).toBe(true);
    expect(popup.state()).toBe('켜짐');
    expect(popup.status()).toBeUndefined();
  });
});

describe('N-12 서비스 워커가 깨어난 뒤에만 조작한다', () => {
  it('깨우기가 늦으면 응답이 올 때까지 스위치를 쓸 수 없다', async () => {
    let woken: (result: Result<unknown, AppError>) => void = () => undefined;
    const popup = await show({
      wake: () =>
        new Promise((resolve) => {
          woken = resolve;
        }),
    });
    expect(popup.toggle().disabled).toBe(true);
    popup.toggle().click();
    expect(popup.updates).not.toHaveBeenCalled();
    woken(ok(null));
    await popup.awake();
  });

  it('깨우지 못하면 이유를 보이고 스위치를 쓸 수 있게 한다(누르면 그 요청이 결과를 알린다)', async () => {
    const timeout = appError('timeout', '확장의 응답이 없다. 잠시 뒤 다시 한다.');
    const popup = await show({ wake: () => Promise.resolve(err(timeout)) });
    await popup.awake();
    expect(popup.status()).toBe(timeout.message);
  });

  it('열려 있는 동안 20초마다 다시 깨우고, 닫히면 그친다', async () => {
    vi.useFakeTimers();
    const popup = await show();
    expect(popup.wakes).toHaveBeenCalledTimes(1);
    await act(() => {
      vi.advanceTimersByTime(keepAwakeIntervalMs * 3);
    });
    expect(popup.wakes).toHaveBeenCalledTimes(4);
    render(null, container);
    vi.advanceTimersByTime(keepAwakeIntervalMs * 3);
    expect(popup.wakes).toHaveBeenCalledTimes(4);
  });
});

describe('결정 0011·0016 저장된 설정을 읽을 수 없을 때 팝업이 알린다', () => {
  const second = defineFeature({ ...feature, id: 'second', name: '두 번째 기능' });

  interface Wiring {
    // 처음 받은 설정. 없으면 시험 기능이 꺼진 정상 설정이다.
    readonly subscribe?: (handlers: SettingsReaderHandlers) => void;
    readonly dismiss?: (stamp: number) => Promise<Result<unknown, AppError>>;
  }

  async function showWith({
    subscribe = (handlers) => {
      handlers.apply(off);
    },
    dismiss,
  }: Wiring) {
    let reader: SettingsReaderHandlers | undefined;
    let repairs: RepairNoticeHandlers | undefined;
    const dismissals = vi.fn(dismiss ?? (() => Promise.resolve(ok(null))));
    await act(() => {
      render(
        <PopupApp
          features={[feature, second]}
          subscribe={(handlers) => {
            reader = handlers;
            subscribe(handlers);
            return () => undefined;
          }}
          watchRepairs={(handlers) => {
            repairs = handlers;
            return () => undefined;
          }}
          wake={() => Promise.resolve(ok(null))}
          update={() => Promise.resolve(ok(null))}
          dismissRepair={dismissals}
          rememberedCategory={() => Promise.resolve(null)}
          rememberCategory={() => Promise.resolve(ok(null))}
          currentTab={() => Promise.resolve(1)}
          tabStatus={() => Promise.resolve(ok({ page: 'ready' as const }))}
        />,
        container,
      );
    });
    await settle();
    return {
      dismissals,
      repairText: () => container.querySelector('.repair')?.textContent ?? null,
      log: (notice: RepairNotice) => act(() => repairs?.notice(notice)),
      corrupt: (scope: RepairScope) => act(() => reader?.corrupt(scope)),
      confirm: () =>
        act(async () => {
          container.querySelector<HTMLButtonElement>('.repair button')?.click();
          await Promise.resolve();
        }),
    };
  }

  // 기능 id와 사이트 항목으로 범위를 만든다.
  const scope = (features: readonly string[], sites: RepairScope['sites'] = []): RepairScope => ({
    whole: false,
    features,
    sites,
  });

  it('COM-3.4 손상 항목이 있으면 기본값을 보이고 그 기능 이름을 알린다', async () => {
    const popup = await showWith({
      subscribe: (handlers) => {
        handlers.apply({ features: new Map(), sites: new Map() });
        handlers.corrupt(scope(['sample']));
      },
    });
    expect(container.querySelector('.state')?.textContent).toBe('꺼짐');
    expect(popup.repairText()).toContain('기본값으로 바꿨다: 시험 기능.');
    expect(popup.repairText()).not.toContain('두 번째 기능');
    expect(popup.repairText()).not.toContain('사이트');
  });

  it('COM-3.4 서비스 워커가 먼저 고쳐 썼으면 남긴 기록으로 알린다', async () => {
    const popup = await showWith({});
    expect(popup.repairText()).toBeNull();
    await popup.log({ stamp: 7, ...scope(['sample', 'second']), whole: true });
    expect(popup.repairText()).toContain('모든 설정을 기본값으로 바꿨다');
    expect(popup.repairText()).toContain('기본값으로 바꿨다: 시험 기능, 두 번째 기능.');
  });

  it('COM-3.4 결정 0017 손상된 사이트 항목은 사이트 이름과 기능 이름으로 알린다. 사이트 전체면 사이트 이름만 쓴다', async () => {
    const popup = await showWith({});
    await popup.log({
      stamp: 7,
      ...scope(
        [],
        [
          { host: 'a.test', featureId: 'second' },
          { host: 'b.test', featureId: null },
          { host: 'c.test', featureId: 'retired-feature' },
        ],
      ),
    });
    expect(popup.repairText()).toContain(
      '다음 사이트의 저장된 설정을 읽을 수 없어 기본값으로 바꿨다: a.test(두 번째 기능), b.test, c.test(retired-feature).',
    );
    expect(popup.repairText()).not.toContain('다음 기능의');
  });

  it('직접 본 손상과 서비스 워커의 기록이 겹치면 한 번만 보인다', async () => {
    const site = { host: 'a.test', featureId: 'sample' };
    const popup = await showWith({});
    await popup.corrupt(scope(['sample'], [site]));
    await popup.log({ stamp: 7, ...scope(['sample'], [site]) });
    expect(popup.repairText()).toContain('기본값으로 바꿨다: 시험 기능.');
    expect(popup.repairText()).toContain('기본값으로 바꿨다: a.test(시험 기능).');
  });

  it('확인하면 본 기록의 stamp로 지우게 하고 감춘다. 그 뒤 새 기록은 다시 보인다', async () => {
    const popup = await showWith({});
    await popup.log({ stamp: 7, ...scope(['sample']) });
    await popup.confirm();
    expect(popup.dismissals).toHaveBeenCalledWith(7);
    expect(popup.repairText()).toBeNull();
    await popup.log({ stamp: 9, ...scope(['sample', 'second']) });
    expect(popup.repairText()).toContain('시험 기능, 두 번째 기능');
  });

  it('직접 본 손상만 있으면 확인해도 서비스 워커에 보내지 않는다', async () => {
    const popup = await showWith({});
    await popup.corrupt({ ...scope([]), whole: true });
    await popup.confirm();
    expect(popup.dismissals).not.toHaveBeenCalled();
    expect(popup.repairText()).toBeNull();
  });

  it('확인을 서비스 워커에 알리지 못하면 이유를 보이고 알림을 남긴다', async () => {
    const failed = appError('platform', '설정 복구 알림을 지우지 못했다. 다시 확인을 누른다.');
    const popup = await showWith({ dismiss: () => Promise.resolve(err(failed)) });
    await popup.log({ stamp: 7, ...scope(['sample']) });
    await popup.confirm();
    await vi.waitFor(() => {
      expect(popup.repairText()).toContain('시험 기능');
    });
    expect(container.querySelector('[role=status]')?.textContent).toBe(failed.message);
  });

  it('COM-3.8 더 새 형식의 설정이면 기능을 보이지 않고 이유를 알린다', async () => {
    await showWith({
      subscribe: (handlers) => {
        handlers.apply(off);
        handlers.newer(2);
      },
    });
    expect(container.querySelector('[role=switch]')).toBeNull();
    expect(container.textContent).toContain('더 새 버전의 확장이 저장한 설정');
  });
});
