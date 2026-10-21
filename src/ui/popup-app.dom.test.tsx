import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type Category,
  type FeatureDefinition,
  type TabStatus,
  defineFeature,
  v,
} from '../contracts/index.ts';
import type { RequestError } from '../platform/index.ts';
import { type AppError, type Result, appError, err, ok } from '../shared/index.ts';
import type {
  RepairNotice,
  RepairNoticeHandlers,
  RepairScope,
  SettingsReaderHandlers,
  Snapshot,
  TaskRecord,
  TaskWatchHandlers,
} from '../storage/index.ts';
import { type FeatureUiPart, defineUiPart } from './part.ts';
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
  settings: { schema: v.object({ enabled: v.boolean() }), defaults: { enabled: false } },
});

const off: Snapshot = { features: new Map([['sample', { enabled: false }]]), sites: new Map() };
// 설정 바꾸기의 결과. 실패에는 서비스 워커가 그 실패로 답했는지가 있다(결정 0036).
type Saved = Result<{ readonly revision: number }, RequestError>;
// 서비스 워커가 저장하지 못했다고 답한 실패.
const saveFailed: RequestError = {
  ...appError('platform', '설정을 저장하지 못했다. 저장된 설정은 바뀌지 않았다.'),
  answered: true,
};

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
    settings: { schema: v.object({ enabled: v.boolean() }), defaults: { enabled: false } },
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

// act 밖에서 마이크로태스크만 흘려 보낸다. 미뤄 둔 다시 그리기는 끝나지만, 타이머와 화면 그리기 차례를 주지 않으므로
// 효과(useEffect)는 아직 불리지 않는다.
async function renderedOnly() {
  for (let step = 0; step < 10; step += 1) await Promise.resolve();
}

interface Options {
  readonly features?: readonly FeatureDefinition[];
  readonly uiParts?: readonly FeatureUiPart[];
  readonly wake?: () => Promise<Result<unknown, AppError>>;
  readonly update?: () => Promise<Saved>;
  // 지난번 범주를 읽는 함수. 없으면 남긴 범주가 없다.
  readonly readRemembered?: () => Promise<Category | null>;
  readonly remember?: (category: Category) => Promise<Result<unknown, AppError>>;
  readonly currentTab?: () => Promise<Result<number | null, AppError>>;
  readonly tabStatus?: (tabId: number) => Promise<Result<TabStatus, AppError>>;
  readonly startTask?: (featureId: string, tabId: number) => Promise<Result<unknown, AppError>>;
  readonly taskSeen?: (tabId: number, taskId: string) => Promise<Result<unknown, AppError>>;
  // 그 탭의 작업 기록을 처음 받는 것을 시험이 붙잡는다(task로 보낸다). 붙잡지 않으면 듣자마자 작업이 없다고 받는다.
  readonly holdTaskRead?: boolean;
}

async function show({
  features = [feature],
  uiParts = [],
  wake = () => Promise.resolve(ok(null)),
  update,
  readRemembered = () => Promise.resolve(null),
  remember = () => Promise.resolve(ok(null)),
  currentTab = () => Promise.resolve(ok(7)),
  tabStatus = () =>
    Promise.resolve(ok({ page: 'ready' as const, bundle: 'common' as const, unmet: [] })),
  startTask = () => Promise.resolve(ok(null)),
  taskSeen = () => Promise.resolve(ok(null)),
  holdTaskRead = false,
}: Options = {}) {
  const updates = vi.fn(update ?? (() => Promise.resolve(ok({ revision: 2 }))));
  const starts = vi.fn(startTask);
  const seens = vi.fn(taskSeen);
  // 작업 기록은 시험이 보낸다(task). 팝업이 어느 탭의 기록을 들었는지 남긴다.
  let taskHandlers: TaskWatchHandlers | undefined;
  const watchedTabs: number[] = [];
  // 팝업의 연결(결정 0024): 알린 탭, 다시 잇기, 닫기를 센다.
  const announced: { tabs: number[]; renews: number; closes: number } = {
    tabs: [],
    renews: 0,
    closes: 0,
  };
  const announceTab = (tabId: number) => {
    announced.tabs.push(tabId);
    return {
      renew: () => {
        announced.renews += 1;
      },
      close: () => {
        announced.closes += 1;
      },
    };
  };
  const watchTask = (tabId: number, next: TaskWatchHandlers) => {
    watchedTabs.push(tabId);
    taskHandlers = next;
    if (!holdTaskRead) next.task(null);
    return () => {
      if (taskHandlers === next) taskHandlers = undefined;
    };
  };
  const wakes = vi.fn(wake);
  const remembers = vi.fn(remember);
  const statuses = vi.fn(tabStatus);
  // 저장된 설정을 바로 준다. 저장이 성공해도 바뀜 알림은 시험이 직접 보낸다.
  let handlers: SettingsReaderHandlers | undefined;
  const subscribe = (next: SettingsReaderHandlers) => {
    handlers = next;
    next.apply(off, 1);
    return () => undefined;
  };
  await act(() => {
    render(
      <PopupApp
        features={features}
        uiParts={uiParts}
        subscribe={subscribe}
        watchRepairs={() => () => undefined}
        wake={wakes}
        update={updates}
        dismissRepair={() => Promise.resolve(ok(null))}
        rememberedCategory={readRemembered}
        rememberCategory={remembers}
        currentTab={currentTab}
        tabStatus={statuses}
        startTask={starts}
        watchTask={watchTask}
        taskSeen={seens}
        announceTab={announceTab}
        windowTabs={() => Promise.resolve(ok([]))}
        tabRuntimes={() => Promise.resolve(ok([]))}
        watchTabToggles={() => () => undefined}
        setTabToggle={() => Promise.resolve(ok(null))}
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
    starts,
    seens,
    watchedTabs,
    announced,
    // 그 탭의 작업 기록을 읽었거나 기록이 바뀐 것처럼 보낸다.
    task: (record: TaskRecord | null) =>
      act(() => {
        taskHandlers?.task(record);
      }),
    // 위와 같되 act 밖에서 보낸다. act는 다시 그리기와 효과를 한 번에 흘려 보내지만, 실제로는 Preact가 다시 그리기를
    // 마이크로태스크에서 하고 효과는 브라우저가 다음 화면을 그린 뒤에 부른다(preact/hooks의 afterNextFrame).
    // 그 사이를 보려면 이것으로 보낸 뒤 renderedOnly를 기다린다.
    taskOutsideAct: (record: TaskRecord | null) => {
      taskHandlers?.task(record);
    },
    // 작업 기록을 읽지 못한 것처럼 알린다.
    taskProblem: (error: AppError) =>
      act(() => {
        taskHandlers?.problem(error);
      }),
    taskText: () => container.querySelector('.task')?.textContent ?? '',
    state: () => container.querySelector('.state')?.textContent,
    status: () => container.querySelector('[role=status]')?.textContent,
    // 저장된 설정이 바뀐 것처럼 알린다(세대 번호를 주지 않으면 2).
    apply: (snapshot: Snapshot, revision: number | null = 2) =>
      act(() => handlers?.apply(snapshot, revision)),
    // 읽기 도우미가 문제를 알린다(예: 설정을 읽지 못함).
    readerProblem: (error: AppError) => act(() => handlers?.problem(error)),
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

  it('COM-6 기대 동작 2 결정 0026 그 기능이 기대는 외부 화면 요소를 찾지 못했으면 "찾지 못함: (요소 이름)"을 스위치의 설명으로 잇고, 스위치는 막지 않는다', async () => {
    const element = { id: 'chatgpt.thread', name: 'ChatGPT 대화 열' };
    const popup = await show({
      features: both,
      tabStatus: () =>
        Promise.resolve(
          ok({
            page: 'ready' as const,
            bundle: 'common' as const,
            unmet: [{ featureId: 'on-pages', reason: 'not-found' as const, element }],
          }),
        ),
    });
    await popup.awake();
    expect(reasonOf('on-pages')).toBe('찾지 못함: ChatGPT 대화 열');
    expect(reasonOf('sample')).toBeNull();
    const toggle = container.querySelector<HTMLInputElement>('[data-feature="on-pages"]');
    const described = (toggle?.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(['시험용', '찾지 못함: ChatGPT 대화 열']);
    expect(toggle?.disabled).toBe(false);
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
    const popup = await show({ features: both, currentTab: () => Promise.resolve(ok(null)) });
    expect(popup.statuses).not.toHaveBeenCalled();
    expect(popup.status()).toBe('지금 탭을 알 수 없어 기능을 쓸 수 있는지 확인하지 못했다.');
  });

  it('지금 탭을 묻다 실패하면 묻지 않고 그 까닭을 알린다', async () => {
    const failed = appError('platform', '지금 탭을 Chrome에서 받지 못했다.');
    const popup = await show({ features: both, currentTab: () => Promise.resolve(err(failed)) });
    expect(popup.statuses).not.toHaveBeenCalled();
    expect(popup.status()).toBe(failed.message);
  });
});

describe('COM-10 실행 기능의 단추(결정 0024)', () => {
  const saveTask = defineFeature({
    id: 'save',
    requirements: [],
    name: '자막 저장',
    description: '자막을 글로 저장한다.',
    category: 'media',
    kind: 'action',
    content: null,
    permissions: [],
    task: { timeoutMs: 10_000 },
  });
  const onPage = defineFeature({
    ...saveTask,
    id: 'capture',
    name: '캡처',
    content: { sites: 'all', frames: 'top' },
  });
  // 깨어났는지 스위치로 보므로 켜고 끄기 기능도 둔다.
  const withToggle = [feature, saveTask, onPage];

  const button = (featureId: string) => {
    const found = container.querySelector<HTMLButtonElement>(`button[data-feature="${featureId}"]`);
    if (found === null) throw new Error(`${featureId}의 단추가 없다.`);
    return found;
  };
  const click = (element: HTMLElement) =>
    act(async () => {
      element.click();
      await Promise.resolve();
    });

  it('실행 기능은 기능 이름이 적힌 단추이고 설명을 잇는다. 누르면 지금 탭에서 작업을 시작한다', async () => {
    const popup = await show({ features: withToggle });
    await popup.awake();
    expect(button('save').textContent).toBe('자막 저장');
    expect(
      document.getElementById(button('save').getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe('자막을 글로 저장한다.');
    expect(button('save').hasAttribute('aria-disabled')).toBe(false);
    await click(button('save'));
    expect(popup.starts).toHaveBeenCalledWith('save', 7);
  });

  it('N-12 서비스 워커가 깨어나기 전에는 막혀 있고 눌러도 시작하지 않는다', async () => {
    let wake: (result: Result<unknown, AppError>) => void = () => undefined;
    const popup = await show({
      features: withToggle,
      wake: () =>
        new Promise((resolve) => {
          wake = resolve;
        }),
    });
    expect(button('save').getAttribute('aria-disabled')).toBe('true');
    await click(button('save'));
    expect(popup.starts).not.toHaveBeenCalled();
    await act(() => {
      wake(ok(null));
    });
    await popup.awake();
    expect(button('save').hasAttribute('aria-disabled')).toBe(false);
  });

  it('지금 탭에서 쓸 수 없으면 이유를 단추의 설명으로 잇고, 막혀 있어 눌러도 시작하지 않는다', async () => {
    const popup = await show({
      features: withToggle,
      tabStatus: () => Promise.resolve(ok({ page: 'denied' as const })),
    });
    await popup.awake();
    const described = (button('capture').getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual([
      '자막을 글로 저장한다.',
      '쓸 수 없음: 확장이 이 페이지에 접근할 수 없음',
    ]);
    expect(button('capture').getAttribute('aria-disabled')).toBe('true');
    await click(button('capture'));
    expect(popup.starts).not.toHaveBeenCalled();
    // 페이지에 작용하지 않는 실행 기능은 그대로 쓴다.
    expect(button('save').hasAttribute('aria-disabled')).toBe(false);
  });

  it('지금 탭을 알 수 없으면 막혀 있다', async () => {
    const popup = await show({ features: withToggle, currentTab: () => Promise.resolve(ok(null)) });
    await popup.awake();
    expect(button('save').getAttribute('aria-disabled')).toBe('true');
  });

  it('COM-10 기대 동작 3·6 그 탭의 작업 기록을 처음 받기 전에는 막혀 있어 눌러도 시작하지 않고, 받으면 보지 않은 결과를 보인 뒤 쓸 수 있다', async () => {
    const popup = await show({ features: withToggle, holdTaskRead: true });
    await popup.awake();
    expect(popup.watchedTabs).toEqual([7]);
    expect(button('save').getAttribute('aria-disabled')).toBe('true');
    await click(button('save'));
    expect(popup.starts).not.toHaveBeenCalled();
    await popup.task({ id: 't1', featureId: 'save', status: 'succeeded', summary: '영상.txt' });
    expect(popup.taskText()).toBe('자막 저장: 끝났다. 영상.txt');
    expect(popup.seens).toHaveBeenCalledExactlyOnceWith(7, 't1');
    expect(button('save').hasAttribute('aria-disabled')).toBe(false);
  });

  it('COM-10 기대 동작 3·6 기록을 받은 직후 작업 칸을 그린 화면이 나오기 전에는 막혀 있어 눌러도 시작하지 않고, 그 뒤에 쓸 수 있다', async () => {
    const popup = await show({ features: withToggle, holdTaskRead: true });
    await popup.awake();
    popup.taskOutsideAct({ id: 't1', featureId: 'save', status: 'succeeded', summary: '영상.txt' });
    await renderedOnly();
    // 다시 그렸지만 효과는 아직이다. 받은 결과를 보인 화면이 나오기 전이라 단추는 막혀 있다.
    expect(button('save').getAttribute('aria-disabled')).toBe('true');
    expect(popup.taskText()).toBe('자막 저장: 끝났다. 영상.txt');
    expect(popup.seens).not.toHaveBeenCalled();
    await click(button('save'));
    expect(popup.starts).not.toHaveBeenCalled();
    // 그 화면이 나온 뒤(효과)에는 쓸 수 있고, 보인 결과의 확인을 보냈다.
    await vi.waitFor(() => {
      expect(button('save').hasAttribute('aria-disabled')).toBe(false);
    });
    expect(popup.seens).toHaveBeenCalledExactlyOnceWith(7, 't1');
  });

  it.each([
    ['다시 연 팝업이 처음 받은 결과', [] as const],
    ['열린 동안 끝난 결과', [{ id: 't1', featureId: 'save', status: 'running' }] as const],
  ])(
    'COM-10 기대 동작 3·6 %s의 확인은 작업 칸이 그 결과를 그린 뒤에 보낸다',
    async (_name, before) => {
      // 확인을 보내는 순간 작업 칸에 있던 글.
      const shownWhenSeen: string[] = [];
      const popup = await show({
        features: withToggle,
        holdTaskRead: true,
        taskSeen: () => {
          shownWhenSeen.push(container.querySelector('.task')?.textContent ?? '');
          return Promise.resolve(ok(null));
        },
      });
      await popup.awake();
      for (const record of before) await popup.task(record);
      await popup.task({ id: 't1', featureId: 'save', status: 'succeeded', summary: '영상.txt' });
      expect(shownWhenSeen).toEqual(['자막 저장: 끝났다. 영상.txt']);
    },
  );

  it('페이지에 작용하는 실행 기능은 지금 탭에서 쓸 수 있는지 답을 받기 전에는 막혀 있어 눌러도 시작하지 않는다. 작용하지 않는 기능은 기다리지 않는다', async () => {
    let answer: (result: Result<TabStatus, AppError>) => void = () => undefined;
    const popup = await show({
      features: withToggle,
      tabStatus: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    await popup.awake();
    expect(button('capture').getAttribute('aria-disabled')).toBe('true');
    expect(button('save').hasAttribute('aria-disabled')).toBe(false);
    await click(button('capture'));
    expect(popup.starts).not.toHaveBeenCalled();
    await act(() => {
      answer(ok({ page: 'ready', bundle: 'common', unmet: [] }));
    });
    await vi.waitFor(() => {
      expect(button('capture').hasAttribute('aria-disabled')).toBe(false);
    });
  });

  it('지금 탭에서 쓸 수 있는지 답을 받지 못하면 그 까닭을 알리고 이유 없이 연다(결정 0023)', async () => {
    const popup = await show({
      features: withToggle,
      tabStatus: () => Promise.resolve(err(appError('timeout', '확장의 응답이 없다.'))),
    });
    await popup.awake();
    await vi.waitFor(() => {
      expect(popup.status()).toBe('확장의 응답이 없다.');
    });
    expect(button('capture').hasAttribute('aria-disabled')).toBe(false);
    expect(container.querySelector('#feature-unavailable-capture')).toBeNull();
  });

  it('작업 기록을 읽지 못하면 그 이유를 알리고 막아 둔다. 그 뒤 기록의 바뀜을 받으면 쓸 수 있다', async () => {
    const popup = await show({ features: withToggle, holdTaskRead: true });
    await popup.awake();
    await popup.taskProblem(appError('platform', '작업 기록을 읽지 못했다.'));
    expect(popup.status()).toBe('작업 기록을 읽지 못했다.');
    expect(button('save').getAttribute('aria-disabled')).toBe('true');
    await popup.task(null);
    expect(button('save').hasAttribute('aria-disabled')).toBe(false);
  });

  it('작업을 시작하지 못하면 그 이유를 알린다', async () => {
    const running = appError('unavailable', '이 탭에서 캡처 진행 중이다. 끝난 뒤 다시 한다.');
    const popup = await show({
      features: withToggle,
      startTask: () => Promise.resolve(err(running)),
    });
    await popup.awake();
    await click(button('save'));
    expect(popup.status()).toBe(running.message);
  });

  it('COM-10.3 지금 탭의 작업 기록을 듣고, 진행 중이면 작업 칸에 보이며 모든 실행 단추를 막고 이유를 잇는다(COM-10.7)', async () => {
    const popup = await show({ features: withToggle });
    await popup.awake();
    expect(popup.watchedTabs).toEqual([7]);
    await popup.task({ id: 't1', featureId: 'save', status: 'running' });
    expect(popup.taskText()).toBe('자막 저장: 진행 중이다.');
    for (const id of ['save', 'capture']) {
      expect(button(id).getAttribute('aria-disabled')).toBe('true');
      expect(container.querySelector(`#feature-unavailable-${id}`)?.textContent).toBe(
        '쓸 수 없음: 이 탭에서 자막 저장 진행 중',
      );
    }
    await click(button('capture'));
    expect(popup.starts).not.toHaveBeenCalled();
    // 켜고 끄기는 막지 않는다(모든 탭에 대한 설정이다).
    expect(popup.toggle().disabled).toBe(false);
    expect(popup.seens).not.toHaveBeenCalled();
  });

  it('작업 칸은 처음부터 있는 알림 영역이다(내용이 바뀌면 화면 낭독기가 읽는다)', async () => {
    const popup = await show({ features: withToggle });
    expect(container.querySelector('.task')?.getAttribute('aria-live')).toBe('polite');
    expect(popup.taskText()).toBe('');
  });

  it('끝난 결과를 보이고 그 작업 id로 확인을 한 번만 보낸다. 기록이 지워져도 팝업을 닫을 때까지 보인다', async () => {
    const popup = await show({ features: withToggle });
    await popup.awake();
    await popup.task({ id: 't1', featureId: 'save', status: 'running' });
    const done = { id: 't1', featureId: 'save', status: 'succeeded', summary: '영상.txt' } as const;
    await popup.task(done);
    expect(popup.taskText()).toBe('자막 저장: 끝났다. 영상.txt');
    expect(popup.seens).toHaveBeenCalledExactlyOnceWith(7, 't1');
    // 같은 결과가 다시 와도(예: 다른 탭의 기록이 바뀜) 두 번 보내지 않는다.
    await popup.task(done);
    await popup.task(null);
    expect(popup.taskText()).toBe('자막 저장: 끝났다. 영상.txt');
    expect(popup.seens).toHaveBeenCalledTimes(1);
    // 단추는 다시 쓸 수 있다.
    expect(button('save').hasAttribute('aria-disabled')).toBe(false);
  });

  it.each([
    [
      '실패',
      appError('unavailable', '자막이 없는 영상이다.'),
      '자막 저장: 실패했다. 자막이 없는 영상이다.',
    ],
    [
      '취소',
      appError('cancelled', '다른 영상으로 이동했다.'),
      '자막 저장: 취소했다. 다른 영상으로 이동했다.',
    ],
  ])('%s한 결과는 그 이유와 함께 보인다', async (_name, error, text) => {
    const popup = await show({ features: withToggle });
    await popup.task({ id: 't1', featureId: 'save', status: 'failed', error });
    expect(popup.taskText()).toBe(text);
    expect(popup.seens).toHaveBeenCalledExactlyOnceWith(7, 't1');
  });

  it('결과를 보인 뒤 새 작업이 시작되면 그 작업을 보이고, 끝나면 그 결과도 확인한다', async () => {
    const popup = await show({ features: withToggle });
    await popup.task({ id: 't1', featureId: 'save', status: 'succeeded', summary: null });
    await popup.task({ id: 't2', featureId: 'capture', status: 'running' });
    expect(popup.taskText()).toBe('캡처: 진행 중이다.');
    await popup.task({ id: 't2', featureId: 'capture', status: 'succeeded', summary: null });
    expect(popup.taskText()).toBe('캡처: 끝났다.');
    expect(popup.seens.mock.calls).toEqual([
      [7, 't1'],
      [7, 't2'],
    ]);
  });

  it('진행 중이던 작업이 기록에서 사라지면(탭이 닫힘) 작업 칸을 비운다', async () => {
    const popup = await show({ features: withToggle });
    await popup.task({ id: 't1', featureId: 'save', status: 'running' });
    await popup.task(null);
    expect(popup.taskText()).toBe('');
  });

  it('지금 탭을 알면 그 탭을 본다고 서비스 워커에 알리고, 닫히면 그 연결을 닫는다', async () => {
    const popup = await show({ features: withToggle });
    await popup.awake();
    expect(popup.announced.tabs).toEqual([7]);
    expect(popup.announced.closes).toBe(0);
    await act(() => {
      render(null, container);
    });
    expect(popup.announced.closes).toBe(1);
  });

  it('깨울 때마다 끊긴 연결을 다시 잇는다(서비스 워커가 다시 시작했을 수 있다). 깨우지 못하면 잇지 않는다', async () => {
    vi.useFakeTimers();
    let wakes = 0;
    const popup = await show({
      features: withToggle,
      wake: () => {
        wakes += 1;
        return Promise.resolve(
          wakes === 2 ? err(appError('timeout', '확장의 응답이 없다.')) : ok(null),
        );
      },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const afterOpen = popup.announced.renews;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(keepAwakeIntervalMs);
    });
    expect(popup.announced.renews).toBe(afterOpen);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(keepAwakeIntervalMs);
    });
    expect(popup.announced.renews).toBe(afterOpen + 1);
  });

  it('지금 탭을 알 수 없으면 작업 기록을 듣지 않는다', async () => {
    const popup = await show({ features: withToggle, currentTab: () => Promise.resolve(ok(null)) });
    expect(popup.watchedTabs).toEqual([]);
  });

  it('검색에서 간 실행 기능은 그 단추에 초점이 간다', async () => {
    await show({ features: withToggle });
    const search = container.querySelector<HTMLInputElement>('[role=combobox]');
    if (search === null) throw new Error('검색 칸이 없다.');
    search.focus();
    await act(() => {
      search.value = '자막';
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await press('Enter');
    expect(document.activeElement).toBe(button('save'));
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
    popup.updates.mockImplementation(() => Promise.resolve(ok({ revision: 2 })));
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

// 크기를 정하는 화면 조각이 있는 기능(결정 0030). 조각의 시험과 알림 줄의 시험이 쓴다.
const sized = defineFeature({
  id: 'sized',
  requirements: [],
  name: '크기 기능',
  description: '크기를 정한다',
  category: 'media',
  kind: 'toggle',
  content: null,
  permissions: [],
  settings: {
    schema: v.object({ enabled: v.boolean(), size: v.int() }),
    defaults: { enabled: false, size: 3 },
  },
});
// 보일 크기를 보이고, 누르면 그 크기를 정하는 단추 둘(3, 5)이 있는 조각.
const sizedPart = defineUiPart(sized, ({ settings, disabled, choose }) => (
  <div class="controls">
    <span class="size">{settings.size}</span>
    {[3, 5].map((size) => (
      <button
        type="button"
        key={size}
        data-size={size}
        disabled={disabled}
        onClick={() => {
          choose({ size });
        }}
      >
        {size}로
      </button>
    ))}
  </div>
));
const text = (selector: string) => container.querySelector(selector)?.textContent;
const sizeTo = (size: number) =>
  act(() => {
    const found = container.querySelector<HTMLButtonElement>(
      `.controls [data-size="${String(size)}"]`,
    );
    if (found === null) throw new Error('조각의 단추가 없다.');
    found.click();
  });
const sizedSettings = (size: number): Snapshot => ({
  features: new Map([['sized', { enabled: false, size }]]),
  sites: new Map(),
});

describe('결정 0030 기능의 화면 조각', () => {
  it('그 기능 항목의 설명 아래에 그 기능의 저장된 설정(없으면 기본값)으로 그린다', async () => {
    const popup = await show({ features: [sized, feature], uiParts: [sizedPart] });
    const item = container.querySelector('[data-feature="sized"]')?.closest('li');
    expect(item?.querySelector('.description + .controls')).not.toBeNull();
    expect(text('.size')).toBe('3');
    // 조각이 없는 기능에는 아무것도 붙지 않는다.
    expect(container.querySelectorAll('.controls')).toHaveLength(1);
    await popup.apply(sizedSettings(8), 9);
    expect(text('.size')).toBe('8');
    await popup.apply({ features: new Map(), sites: new Map() }, null);
    expect(text('.size')).toBe('3');
  });

  it('N-12 서비스 워커가 깨어나기 전에는 조각의 조작도 막는다', async () => {
    let wake: (value: Result<unknown, AppError>) => void = () => undefined;
    const popup = await show({
      features: [sized],
      uiParts: [sizedPart],
      wake: () => new Promise((resolve) => (wake = resolve)),
    });
    expect(container.querySelector<HTMLButtonElement>('.controls button')?.disabled).toBe(true);
    await act(() => {
      wake(ok(null));
    });
    await popup.awake();
    expect(container.querySelector<HTMLButtonElement>('.controls button')?.disabled).toBe(false);
  });

  it('COM-3 기대 동작 3 결정 0037 정한 값은 보이는 값과 다를 때만 그 기능의 설정 바꾸기로 보내고, 보이는 설정이 그 저장을 담을 때까지 보이며, 실패하면 알리고 저장된 값으로 돌아간다', async () => {
    let result: Saved = ok({ revision: 7 });
    const popup = await show({
      features: [sized],
      uiParts: [sizedPart],
      update: () => Promise.resolve(result),
    });
    await popup.awake();
    await sizeTo(3);
    expect(popup.updates).not.toHaveBeenCalled();
    await sizeTo(5);
    expect(popup.updates.mock.calls).toEqual([['sized', { size: 5 }]]);
    await settle();
    // 저장했지만(세대 7) 보이는 설정(세대 1)이 아직 담지 않았다.
    expect(text('.size')).toBe('5');
    expect(popup.status()).toBeUndefined();
    await sizeTo(5);
    expect(popup.updates).toHaveBeenCalledTimes(1);
    await popup.apply(sizedSettings(5), 7);
    expect(text('.size')).toBe('5');

    result = err(saveFailed);
    await sizeTo(3);
    expect(popup.updates).toHaveBeenLastCalledWith('sized', { size: 3 });
    await settle();
    expect(popup.status()).toBe(saveFailed.message);
    expect(text('.size')).toBe('5');
  });

  it('COM-3 기대 동작 3 결정 0037 조각이 사라졌다 다시 그려져도(다른 범주로 갔다 돌아옴) 팝업이 정한 값과 보낸 저장을 기억해, 응답을 기다리는 값을 보이고 되돌린 값도 보낸다', async () => {
    const answers: ((value: Saved) => void)[] = [];
    const popup = await show({
      features: [sized, toggleFeature('hide', 'page', '숨김 기능')],
      uiParts: [sizedPart],
      update: () =>
        new Promise((resolve) => {
          answers.push(resolve);
        }),
    });
    await popup.awake();
    await sizeTo(5);
    await act(() => {
      popup.tab('페이지').click();
    });
    expect(container.querySelector('.controls')).toBeNull();
    // 칸이 없는 동안 온 응답도 기억에 담긴다.
    await act(async () => {
      answers[0]?.(ok({ revision: 2 }));
      for (let step = 0; step < 5; step += 1) await Promise.resolve();
    });
    await act(() => {
      popup.tab('미디어').click();
    });
    expect(text('.size')).toBe('5');
    await sizeTo(3);
    expect(popup.updates.mock.calls).toEqual([
      ['sized', { size: 5 }],
      ['sized', { size: 3 }],
    ]);
    expect(text('.size')).toBe('3');
  });

  it('결정 0037 다시 그리기 전에 잇달아 정하거나 응답이 와도 앞의 바꿈 위에서 판단한다', async () => {
    const answers: ((value: Saved) => void)[] = [];
    const popup = await show({
      features: [sized],
      uiParts: [sizedPart],
      update: () =>
        new Promise((resolve) => {
          answers.push(resolve);
        }),
    });
    await popup.awake();
    // act는 끝날 때 한 번 그린다. 두 번째 단추는 첫 번째로 정한 값(5)이 그려지기 전에 눌린다.
    const button = (size: number) =>
      container.querySelector<HTMLButtonElement>(`.controls [data-size="${String(size)}"]`);
    await act(() => {
      button(5)?.click();
      button(3)?.click();
    });
    expect(popup.updates.mock.calls).toEqual([
      ['sized', { size: 5 }],
      ['sized', { size: 3 }],
    ]);
    await act(async () => {
      answers[0]?.(ok({ revision: 2 }));
      answers[1]?.(ok({ revision: 3 }));
      for (let step = 0; step < 5; step += 1) await Promise.resolve();
    });
    // 두 응답이 모두 담겼다. 보이는 설정이 마지막 저장(세대 3)을 담으면 그 뒤로는 저장된 값을 따른다.
    expect(text('.size')).toBe('3');
    await popup.apply(sizedSettings(3), 3);
    await popup.apply(sizedSettings(8), 4);
    expect(text('.size')).toBe('8');
  });

  it('결정 0036 읽기 도우미가 기본값으로 대신 쓰면(세대 번호 없음) 저장한 것을 잊고 저장된 값을 보인다', async () => {
    const popup = await show({
      features: [sized],
      uiParts: [sizedPart],
      update: () => Promise.resolve(ok({ revision: 2 })),
    });
    await popup.awake();
    await sizeTo(5);
    await settle();
    expect(text('.size')).toBe('5');
    await popup.apply({ features: new Map(), sites: new Map() }, null);
    expect(text('.size')).toBe('3');
    // 시계가 뒤로 간 채 고쳐 쓴 값(세대 1)도 따른다.
    await popup.apply(sizedSettings(4), 1);
    expect(text('.size')).toBe('4');
  });

  it('결정 0036 결정 0037 조각이 그려져 있지 않은 동안 기본값으로 대신 쓰게 되어도 응답을 기다리던 저장을 잊고, 그 늦은 응답은 버린다', async () => {
    const answers: ((value: Saved) => void)[] = [];
    const popup = await show({
      features: [sized, toggleFeature('hide', 'page', '숨김 기능')],
      uiParts: [sizedPart],
      update: () =>
        new Promise((resolve) => {
          answers.push(resolve);
        }),
    });
    await popup.awake();
    await popup.apply(sizedSettings(3), 1000);
    await sizeTo(5);
    await act(() => {
      popup.tab('페이지').click();
    });
    await popup.apply({ features: new Map(), sites: new Map() }, null);
    // 시계가 뒤로 간 채 고쳐 쓴 값(세대 100) 뒤에 앞 저장의 성공(세대 1001)이 온다.
    await popup.apply(sizedSettings(3), 100);
    await act(async () => {
      answers[0]?.(ok({ revision: 1001 }));
      for (let step = 0; step < 5; step += 1) await Promise.resolve();
    });
    await act(() => {
      popup.tab('미디어').click();
    });
    expect(text('.size')).toBe('3');
  });

  // 저장이 실패로 끝난 방법(결정 0036): 서비스 워커가 저장하지 않았다고 답함, 답을 받지 못함, 처리기가 예상하지 못한 오류로 끝남.
  const noAnswer: RequestError = {
    ...appError('timeout', '확장의 응답이 없다. 잠시 뒤 다시 한다.'),
    answered: false,
  };
  const crashed: RequestError = {
    ...appError('unexpected', '확장 안에서 예상하지 못한 오류가 났다.'),
    answered: true,
  };
  const failures = [
    { failure: saveFailed, name: '저장하지 않았다고 답함', resend: false },
    { failure: noAnswer, name: '답을 받지 못함', resend: true },
    { failure: crashed, name: '예상하지 못한 오류로 답함', resend: true },
  ] as const;

  it('COM-3 기대 동작 3 결정 0036 저장이 실패하면 알리고 저장된 값을 보이며, 서비스 워커가 저장하지 않았다고 답했으면 같은 값을 보내지 않고, 답을 받지 못했거나 예상하지 못한 오류로 끝났으면 그 뒤에 보낸 저장이 될 때까지 보낸다', async () => {
    for (const { failure, name, resend } of failures) {
      let result: Saved = err(failure);
      const popup = await show({
        features: [sized],
        uiParts: [sizedPart],
        update: () => Promise.resolve(result),
      });
      await popup.awake();
      await sizeTo(5);
      await settle();
      expect({ name, size: text('.size'), status: popup.status() }).toEqual({
        name,
        size: '3',
        status: failure.message,
      });
      result = ok({ revision: 2 });
      await sizeTo(3);
      expect({ name, sent: popup.updates.mock.calls.length }).toEqual({
        name,
        sent: resend ? 2 : 1,
      });
      if (resend) {
        await settle();
        await popup.apply(sizedSettings(3), 2);
        await sizeTo(3);
        expect(popup.updates).toHaveBeenCalledTimes(2);
      }
      render(null, container);
    }
  });

  it('결정 0036 알 수 없게 끝난 저장이 나중에 담기면 칸은 그 값을 보이고, 알림 줄의 실패는 그 뒤에 보낸 저장이 될 때까지 남는다(담긴 것이 그 저장인지 가를 수 없다)', async () => {
    let result: Saved = err(noAnswer);
    const popup = await show({
      features: [sized],
      uiParts: [sizedPart],
      update: () => Promise.resolve(result),
    });
    await popup.awake();
    await sizeTo(5);
    await settle();
    await popup.apply(sizedSettings(5), 2);
    expect(text('.size')).toBe('5');
    expect(popup.status()).toBe(noAnswer.message);
    result = ok({ revision: 3 });
    await sizeTo(5);
    await settle();
    expect(popup.updates).toHaveBeenCalledTimes(2);
    expect(popup.status()).toBeUndefined();
  });

  it('결정 0036 결정 0037 조각이 그려져 있지 않은 동안 저장이 실패로 끝나도 기억에 담겨, 다시 그린 조각은 저장된 값을 보이고 알 수 없게 끝났을 때만 같은 값을 보낸다', async () => {
    for (const { failure, name, resend } of failures) {
      const answers: ((value: Saved) => void)[] = [];
      const popup = await show({
        features: [sized, toggleFeature('hide', 'page', '숨김 기능')],
        uiParts: [sizedPart],
        update: () =>
          new Promise((resolve) => {
            answers.push(resolve);
          }),
      });
      await popup.awake();
      await sizeTo(5);
      await act(() => {
        popup.tab('페이지').click();
      });
      await act(async () => {
        answers[0]?.(err(failure));
        for (let step = 0; step < 5; step += 1) await Promise.resolve();
      });
      await act(() => {
        popup.tab('미디어').click();
      });
      expect({ name, size: text('.size') }).toEqual({ name, size: '3' });
      await sizeTo(3);
      expect({ name, sent: popup.updates.mock.calls.length }).toEqual({
        name,
        sent: resend ? 2 : 1,
      });
      render(null, container);
    }
  });
});

describe('COM-3 기대 동작 3 결정 0036 알림 줄은 소식의 차례를 따른다', () => {
  const capture = defineFeature({
    id: 'capture',
    requirements: [],
    name: '캡처',
    description: '화면을 캡처한다.',
    category: 'media',
    kind: 'action',
    content: null,
    permissions: [],
    task: { timeoutMs: 10_000 },
  });
  const taskFailed = appError('platform', '작업 기록을 읽지 못했다.');

  // 저장(조각과 스위치)의 응답을 시험이 정한 차례로 보낸다. index는 보낸 차례(0부터)다.
  async function showHeld(options: Options = {}) {
    const answers: ((value: Saved) => void)[] = [];
    const popup = await show({
      features: [sized, capture],
      uiParts: [sizedPart],
      update: () =>
        new Promise((resolve) => {
          answers.push(resolve);
        }),
      ...options,
    });
    await popup.awake();
    return {
      ...popup,
      answer: (index: number, value: Saved) =>
        act(async () => {
          answers[index]?.(value);
          for (let step = 0; step < 5; step += 1) await Promise.resolve();
        }),
      flip: () =>
        act(async () => {
          popup.toggle().click();
          await Promise.resolve();
        }),
    };
  }

  it('앞에 보낸 저장의 성공이 그 뒤에 보낸 저장의 실패보다 늦게 와도 실패 알림은 남는다(조각과 스위치는 한 알림 줄을 쓴다)', async () => {
    for (const order of [
      ['조각', '조각'],
      ['스위치', '조각'],
      ['조각', '스위치'],
    ] as const) {
      const popup = await showHeld();
      let size = 3;
      for (const which of order) {
        if (which === '스위치') {
          await popup.flip();
        } else {
          size = size === 3 ? 5 : 3;
          await sizeTo(size);
        }
      }
      expect(popup.updates).toHaveBeenCalledTimes(2);
      await popup.answer(1, err(saveFailed));
      await popup.answer(0, ok({ revision: 2 }));
      expect({ order, status: popup.status() }).toEqual({ order, status: saveFailed.message });
      render(null, container);
    }
  });

  it('앞에 시작한 작업의 성공이 그 뒤에 보낸 저장의 실패보다 늦게 와도 실패 알림은 남는다', async () => {
    let started: (value: Result<unknown, AppError>) => void = () => undefined;
    const popup = await showHeld({
      startTask: () =>
        new Promise((resolve) => {
          started = resolve;
        }),
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[data-feature="capture"]')?.click();
      await Promise.resolve();
    });
    expect(popup.starts).toHaveBeenCalledTimes(1);
    await sizeTo(5);
    await popup.answer(0, err(saveFailed));
    await act(async () => {
      started(ok({ taskId: 'task-1' }));
      for (let step = 0; step < 5; step += 1) await Promise.resolve();
    });
    expect(popup.status()).toBe(saveFailed.message);
  });

  it('저장을 보낸 뒤에 받은 다른 알림(작업 기록, 읽기 도우미)은 그 저장의 늦은 성공이 지우지 않고, 그 뒤에 보낸 저장의 성공이 지운다', async () => {
    const readFailed = appError('platform', '설정을 읽지 못했다.');
    for (const source of ['작업 기록', '읽기 도우미'] as const) {
      const popup = await showHeld();
      await sizeTo(5);
      if (source === '작업 기록') await popup.taskProblem(taskFailed);
      else await popup.readerProblem(readFailed);
      const message = source === '작업 기록' ? taskFailed.message : readFailed.message;
      await popup.answer(0, ok({ revision: 2 }));
      expect({ source, status: popup.status() }).toEqual({ source, status: message });
      await sizeTo(3);
      await popup.answer(1, ok({ revision: 3 }));
      expect({ source, status: popup.status() }).toEqual({ source, status: undefined });
      render(null, container);
    }
  });

  it('앞에 보낸 저장의 실패가 그 뒤에 보낸 저장의 성공보다 늦게 와도 알리고(실패를 숨기지 않는다), 그 뒤에 보낸 저장의 성공이 지운다', async () => {
    const popup = await showHeld();
    await sizeTo(5);
    await popup.flip();
    await popup.answer(1, ok({ revision: 2 }));
    expect(popup.status()).toBeUndefined();
    await popup.answer(0, err(saveFailed));
    expect(popup.status()).toBe(saveFailed.message);
    // 첫 저장(5)은 저장하지 않았으므로 칸은 저장된 3을 보인다.
    await sizeTo(5);
    await popup.answer(2, ok({ revision: 3 }));
    expect(popup.status()).toBeUndefined();
  });

  it('앞에 보낸 저장의 실패가 먼저 오면 그 뒤에 보낸 저장의 성공이 지운다', async () => {
    const popup = await showHeld();
    await sizeTo(5);
    await sizeTo(3);
    await popup.answer(0, err(saveFailed));
    expect(popup.status()).toBe(saveFailed.message);
    await popup.answer(1, ok({ revision: 2 }));
    expect(popup.status()).toBeUndefined();
  });

  it('줄이 담은 가장 나중의 소식보다 앞에 보낸 저장의 성공은, 그보다 앞의 실패가 줄을 덮었어도 지우지 않는다', async () => {
    const popup = await showHeld();
    // 저장 셋을 보낸 뒤 다른 알림을 받는다. 첫 저장의 실패가 그 알림을 덮고, 그 뒤 둘째 저장의 성공이 온다.
    await sizeTo(5);
    await sizeTo(3);
    await popup.taskProblem(taskFailed);
    await popup.answer(0, err(saveFailed));
    await popup.answer(1, ok({ revision: 2 }));
    expect(popup.status()).toBe(saveFailed.message);
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
    // 깨우기 뒤에 보낸 저장이 되면 그 알림을 지운다(결정 0036).
    await act(async () => {
      popup.toggle().click();
      await Promise.resolve();
    });
    expect(popup.status()).toBeUndefined();
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
      handlers.apply(off, 1);
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
          uiParts={[]}
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
          update={() => Promise.resolve(ok({ revision: 2 }))}
          dismissRepair={dismissals}
          rememberedCategory={() => Promise.resolve(null)}
          rememberCategory={() => Promise.resolve(ok(null))}
          currentTab={() => Promise.resolve(ok(1))}
          tabStatus={() =>
            Promise.resolve(ok({ page: 'ready' as const, bundle: 'common' as const, unmet: [] }))
          }
          startTask={() => Promise.resolve(ok(null))}
          watchTask={() => () => undefined}
          taskSeen={() => Promise.resolve(ok(null))}
          announceTab={() => ({ renew: () => undefined, close: () => undefined })}
          windowTabs={() => Promise.resolve(ok([]))}
          tabRuntimes={() => Promise.resolve(ok([]))}
          watchTabToggles={() => () => undefined}
          setTabToggle={() => Promise.resolve(ok(null))}
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
        handlers.apply({ features: new Map(), sites: new Map() }, 1);
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
        handlers.apply(off, 1);
        handlers.newer(2);
      },
    });
    expect(container.querySelector('[role=switch]')).toBeNull();
    expect(container.textContent).toContain('더 새 버전의 확장이 저장한 설정');
  });
});
