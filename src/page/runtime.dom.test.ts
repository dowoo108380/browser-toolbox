import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type PageStatus,
  defineFeature,
  pageRuntimeKey,
  retireEventName,
  v,
} from '../contracts/index.ts';
import {
  type NamedElement,
  claimAttribute,
  createIsolatedHost,
  createPageStyle,
  elementTimeoutMs,
  hostTagName,
  pageElementAttribute,
} from '../dom/index.ts';
import { retireInFrame } from '../platform/index.ts';
import { type AppError, type Result, appError, err, ok } from '../shared/index.ts';
import type { SettingsReaderHandlers, Snapshot } from '../storage/index.ts';
import { type PagePart, definePagePart } from './part.ts';
import { type PageProblem, startPageRuntime } from './runtime.ts';

// 테스트가 만든 실행 틀. 테스트가 끝나면 모두 물러나게 해 다음 테스트에 남지 않게 한다(quality 104).
const started: { isConnected: () => boolean }[] = [];

afterEach(() => {
  for (const deps of started.splice(0)) deps.isConnected = () => false;
  document.dispatchEvent(new Event(retireEventName));
  for (const element of document.querySelectorAll(`[${pageElementAttribute}]`)) element.remove();
  Reflect.deleteProperty(globalThis, Symbol.for(pageRuntimeKey));
});

function snapshot(features: Record<string, unknown>): Snapshot {
  return { features: new Map(Object.entries(features)), sites: new Map() };
}

// topFrame은 이 문서가 탭의 최상위 프레임인지다. 시험이 도는 문서는 Vitest의 iframe이라 실제 값과 상관없이 시험이 정한다.
function setup(parts: readonly PagePart[], connected = true, topFrame = true) {
  let handlers: SettingsReaderHandlers | undefined;
  let subscriptions = 0;
  let unsubscribed = 0;
  const reports: PageProblem[] = [];
  // 서비스 워커가 보낸 작업 결과 알림(결정 0024). 시험이 notice로 보낸다.
  let showNotice: ((text: string) => void) | undefined;
  let noticeListeners = 0;
  // 서비스 워커가 지금 상태를 물으면 답하는 함수(결정 0026). 시험이 status로 묻는다.
  let answerStatus: (() => PageStatus) | undefined;
  let statusListeners = 0;
  const deps = {
    parts,
    context: { window, document },
    topFrame,
    subscribe: (next: SettingsReaderHandlers) => {
      subscriptions += 1;
      handlers = next;
      return () => {
        unsubscribed += 1;
      };
    },
    report: (problem: PageProblem): Promise<Result<null, AppError>> => {
      reports.push(problem);
      return Promise.resolve(ok(null));
    },
    isConnected: () => connected,
    listenNotices: (show: (text: string) => void) => {
      showNotice = show;
      noticeListeners += 1;
      return () => {
        noticeListeners -= 1;
      };
    },
    listenStatus: (answer: () => PageStatus) => {
      answerStatus = answer;
      statusListeners += 1;
      return () => {
        statusListeners -= 1;
      };
    },
  };
  startPageRuntime(deps);
  started.push(deps);
  return {
    deps,
    reports,
    apply: (value: Snapshot) => handlers?.apply(value),
    problem: (error: AppError) => handlers?.problem(error),
    newer: (version: number) => handlers?.newer(version),
    subscriptions: () => subscriptions,
    unsubscribed: () => unsubscribed,
    notice: (text: string) => showNotice?.(text),
    noticeListeners: () => noticeListeners,
    status: () => answerStatus?.(),
    statusListeners: () => statusListeners,
  };
}

function isEnabled(value: Snapshot, featureId: string): boolean {
  const settings = value.features.get(featureId);
  return (
    typeof settings === 'object' &&
    settings !== null &&
    'enabled' in settings &&
    settings.enabled === true
  );
}

// 켜짐이면 시작 횟수와 정리 횟수를 세고, 문서의 ping 이벤트를 받은 횟수도 센다.
function countingPart(featureId: string) {
  const counts = { started: 0, disposed: 0, pings: 0 };
  const part: PagePart = {
    featureId,
    frames: 'all',
    start: (value, { scope }) => {
      if (!isEnabled(value, featureId)) return;
      counts.started += 1;
      scope.defer(() => {
        counts.disposed += 1;
      });
      scope.listen(document, 'test-ping', () => {
        counts.pings += 1;
      });
    },
  };
  return { part, counts };
}

const ping = () => document.dispatchEvent(new Event('test-ping'));

describe('콘텐츠 스크립트 실행 틀', () => {
  it('COM-1.4 같은 프레임에 두 번 실려도 실행 틀은 하나다', () => {
    const { deps, subscriptions } = setup([]);
    startPageRuntime(deps);
    expect(subscriptions()).toBe(1);
  });

  it('켜면 시작하고, 끄면 정리하며, 바뀌지 않은 기능은 다시 시작하지 않는다', () => {
    const a = countingPart('a');
    const b = countingPart('b');
    const runtime = setup([a.part, b.part]);
    runtime.apply(snapshot({ a: { enabled: true } }));
    runtime.apply(snapshot({ a: { enabled: true }, b: { enabled: true } }));
    expect(a.counts).toMatchObject({ started: 1, disposed: 0 });
    expect(b.counts).toMatchObject({ started: 1, disposed: 0 });
    runtime.apply(snapshot({ a: { enabled: false }, b: { enabled: true } }));
    expect(a.counts).toMatchObject({ started: 1, disposed: 1 });
    expect(b.counts).toMatchObject({ started: 1, disposed: 0 });
  });

  it('결정 0011 더 새 형식의 설정을 보면 돌던 기능을 모두 멈춘다', () => {
    const a = countingPart('a');
    const runtime = setup([a.part]);
    runtime.apply(snapshot({ a: { enabled: true } }));
    runtime.newer(2);
    expect(a.counts).toMatchObject({ started: 1, disposed: 1 });
  });

  it('quality 010 한 기능의 시작이 실패해도 다른 기능은 시작하고 실패를 기록한다', () => {
    const broken: PagePart = {
      featureId: 'broken',
      frames: 'all',
      start: () => {
        throw new Error('고장');
      },
    };
    const good = countingPart('good');
    const runtime = setup([broken, good.part]);
    runtime.apply(snapshot({ good: { enabled: true } }));
    expect(good.counts.started).toBe(1);
    expect(runtime.reports).toEqual([{ featureId: 'broken', kind: 'unexpected' }]);
  });

  it('결정 0008 연결이 살아 있으면 물러남 이벤트를 따르지 않는다(위조 방지)', () => {
    const a = countingPart('a');
    const runtime = setup([a.part], true);
    runtime.apply(snapshot({ a: { enabled: true } }));
    document.dispatchEvent(new Event(retireEventName));
    expect(a.counts.disposed).toBe(0);
    expect(runtime.unsubscribed()).toBe(0);
  });

  it('결정 0008 이벤트가 연결이 끊기기 전에 닿아도, 정한 때에 다시 확인해 물러난다', () => {
    vi.useFakeTimers();
    try {
      let connected = true;
      const a = countingPart('a');
      const runtime = setup([a.part], true);
      runtime.deps.isConnected = () => connected;
      runtime.apply(snapshot({ a: { enabled: true } }));
      document.dispatchEvent(new Event(retireEventName));
      expect(a.counts.disposed).toBe(0);
      connected = false;
      vi.advanceTimersByTime(200);
      expect(a.counts.disposed).toBe(1);
      expect(runtime.unsubscribed()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('결정 0008 흉내 낸 이벤트가 거듭 와도 다시 확인은 정한 횟수뿐이고 물러나지 않는다', () => {
    vi.useFakeTimers();
    try {
      let checks = 0;
      const a = countingPart('a');
      const runtime = setup([a.part], true);
      runtime.deps.isConnected = () => {
        checks += 1;
        return true;
      };
      runtime.apply(snapshot({ a: { enabled: true } }));
      for (let index = 0; index < 50; index += 1)
        document.dispatchEvent(new Event(retireEventName));
      vi.advanceTimersByTime(10_000);
      // 이벤트마다 한 번, 그리고 다시 확인 세 번.
      expect(checks).toBe(53);
      expect(a.counts.disposed).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('COM-7.2 연결이 끊겼으면 물러남 이벤트에 모든 기능을 정리하고 구독을 그만둔다', () => {
    const a = countingPart('a');
    const runtime = setup([a.part], false);
    runtime.apply(snapshot({ a: { enabled: true } }));
    document.dispatchEvent(new Event(retireEventName));
    expect(a.counts.disposed).toBe(1);
    expect(runtime.unsubscribed()).toBe(1);
  });
});

describe('결정 0024 작업 결과 알림', () => {
  const notices = () =>
    document.querySelectorAll(`${hostTagName}[${pageElementAttribute}="task-notice"]`);

  it('서비스 워커가 보낸 글을 페이지 위에 띄운다', () => {
    const runtime = setup([]);
    expect(runtime.noticeListeners()).toBe(1);
    runtime.notice('자막 저장: 끝났다.');
    expect(notices()).toHaveLength(1);
  });

  it('COM-7.2 물러나면 알림 듣기를 그만두고 남은 알림을 지운다', () => {
    let connected = true;
    const runtime = setup([]);
    runtime.deps.isConnected = () => connected;
    runtime.notice('자막 저장: 끝났다.');
    connected = false;
    document.dispatchEvent(new Event(retireEventName));
    expect(runtime.noticeListeners()).toBe(0);
    expect(notices()).toHaveLength(0);
  });

  it('연결이 끊긴 뒤에 온 알림은 띄우지 않고 물러난다', () => {
    const runtime = setup([], false);
    runtime.notice('자막 저장: 끝났다.');
    expect(notices()).toHaveLength(0);
    expect(runtime.unsubscribed()).toBe(1);
  });
});

describe('결정 0008 새 판의 정리(retireInFrame)', () => {
  // 켜지면 화면 요소 하나를 만드는 기능.
  const hostPart: PagePart = {
    featureId: 'host',
    frames: 'all',
    start: (_value, { scope }) => {
      const host = createIsolatedHost(document, { name: 'test', css: '', parent: document.body });
      scope.defer(host.remove);
    },
  };

  function staleElement(): Element {
    // 다시 로드 뒤 코드가 더 돌지 않는 옛 세계가 남긴 요소를 흉내 낸다.
    const element = document.createElement(hostTagName);
    element.setAttribute(pageElementAttribute, 'old');
    document.body.append(element);
    return element;
  }

  it('COM-7.2 살아 있는 실행 틀의 요소는 남기고, 옛 세계가 남긴 요소는 지운다', () => {
    const runtime = setup([hostPart], true);
    runtime.apply(snapshot({ host: { enabled: true } }));
    const stale = staleElement();
    // 끝까지 돌면 참을 돌려준다. 새 판은 이 값으로 프레임마다 정리가 끝났는지 본다.
    expect(
      retireInFrame(retireEventName, pageElementAttribute, claimAttribute, 'service-worker-token'),
    ).toBe(true);
    expect(stale.isConnected).toBe(false);
    expect(document.querySelectorAll(hostTagName)).toHaveLength(1);
  });

  it('COM-7.2 연결이 끊긴 실행 틀은 물러나며 자기 요소를 지운다', () => {
    const runtime = setup([hostPart], false);
    runtime.apply(snapshot({ host: { enabled: true } }));
    retireInFrame(retireEventName, pageElementAttribute, claimAttribute, 'service-worker-token');
    expect(document.querySelectorAll(hostTagName)).toHaveLength(0);
    expect(runtime.unsubscribed()).toBe(1);
  });

  it('COM-7.2 결정 0031 살아 있는 실행 틀의 페이지 스타일은 남기고, 옛 세계가 남긴 스타일은 지운다', () => {
    const stylePart: PagePart = {
      featureId: 'style',
      frames: 'all',
      start: (_value, { scope }) => {
        const style = createPageStyle(document, { name: 'test-style', css: '' });
        scope.defer(style.remove);
      },
    };
    const runtime = setup([stylePart], true);
    runtime.apply(snapshot({ style: { enabled: true } }));
    const stale = document.createElement('style');
    stale.setAttribute(pageElementAttribute, 'test-style');
    document.documentElement.append(stale);

    retireInFrame(retireEventName, pageElementAttribute, claimAttribute, 'service-worker-token');
    expect(stale.isConnected).toBe(false);
    expect(document.querySelectorAll(`style[${pageElementAttribute}]`)).toHaveLength(1);
  });

  it('흉내 낸 이벤트(토큰을 아는 웹 페이지)로는 살아 있는 실행 틀의 요소가 지워지지 않는다', () => {
    const runtime = setup([hostPart], true);
    runtime.apply(snapshot({ host: { enabled: true } }));
    document.dispatchEvent(new CustomEvent(retireEventName, { detail: 'page-token' }));
    expect(document.querySelectorAll(hostTagName)).toHaveLength(1);
  });
});

describe('결정 0014 기능의 자원 범위와 실패 격리', () => {
  // 켜지면 화면 요소, 이벤트 듣기, 관찰을 만들고, 정한 곳에서 실패하는 기능.
  function failingPart(failAt: 'start' | 'ping' | 'mutation' | 'async') {
    const counts = { started: 0, pings: 0, others: 0 };
    const target = document.createElement('div');
    document.body.append(target);
    const part: PagePart = {
      featureId: 'failing',
      frames: 'all',
      start: (value, { scope }) => {
        if (!isEnabled(value, 'failing')) return;
        counts.started += 1;
        const host = createIsolatedHost(document, { name: 'test', css: '', parent: document.body });
        scope.defer(host.remove);
        scope.listen(document, 'test-other', () => {
          counts.others += 1;
        });
        scope.listen(document, 'test-ping', () => {
          counts.pings += 1;
          if (failAt === 'ping' && counts.pings === 2) throw new Error('콜백 고장');
        });
        scope
          .mutationObserver(() => {
            if (failAt === 'mutation') throw new Error('관찰 고장');
          })
          .observe(target, { childList: true });
        scope.listen(document, 'test-async', async () => {
          await Promise.resolve();
          if (failAt === 'async') throw new Error('비동기 고장');
        });
        if (failAt === 'start') throw new Error('시작 고장');
      },
    };
    return { part, counts, target };
  }

  // 실패한 기능이 페이지에 남긴 것이 없고 더는 이벤트를 받지 않으며, 다른 기능은 그대로 도는지 본다.
  function expectIsolated(
    failing: ReturnType<typeof failingPart>,
    good: ReturnType<typeof countingPart>,
    runtime: ReturnType<typeof setup>,
  ) {
    expect(document.querySelectorAll(hostTagName)).toHaveLength(0);
    const { pings, others } = failing.counts;
    ping();
    document.dispatchEvent(new Event('test-other'));
    expect(failing.counts.pings).toBe(pings);
    expect(failing.counts.others).toBe(others);
    expect(runtime.reports).toEqual([{ featureId: 'failing', kind: 'unexpected' }]);
    expect(good.counts.disposed).toBe(0);
    const before = good.counts.pings;
    ping();
    expect(good.counts.pings).toBe(before + 1);
    failing.target.remove();
  }

  const both = snapshot({ failing: { enabled: true }, good: { enabled: true } });

  it('quality 083 시작 도중에 실패해도 그때까지 만든 자원을 치우고 기록하며, 다른 기능은 계속 돈다', () => {
    const failing = failingPart('start');
    const good = countingPart('good');
    const runtime = setup([failing.part, good.part]);
    runtime.apply(both);
    expectIsolated(failing, good, runtime);
  });

  it('quality 010 이벤트 콜백의 예외는 그 기능만 멈추고 정리한 뒤 기록하며, 페이지로 새지 않는다', () => {
    const failing = failingPart('ping');
    const good = countingPart('good');
    const runtime = setup([failing.part, good.part]);
    runtime.apply(both);
    ping();
    expect(document.querySelectorAll(hostTagName)).toHaveLength(1);
    expect(() => ping()).not.toThrow();
    expectIsolated(failing, good, runtime);
  });

  it('quality 010 관찰 콜백의 예외도 그 기능만 멈추고 정리한 뒤 기록한다', async () => {
    const failing = failingPart('mutation');
    const good = countingPart('good');
    const runtime = setup([failing.part, good.part]);
    runtime.apply(both);
    failing.target.append(document.createElement('span'));
    await vi.waitFor(() => {
      expect(runtime.reports).toHaveLength(1);
    });
    expectIsolated(failing, good, runtime);
  });

  it('quality 010 비동기 콜백이 거절되어도 그 기능만 멈추고 정리한 뒤 기록한다', async () => {
    const failing = failingPart('async');
    const good = countingPart('good');
    const runtime = setup([failing.part, good.part]);
    runtime.apply(both);
    document.dispatchEvent(new Event('test-async'));
    await vi.waitFor(() => {
      expect(runtime.reports).toHaveLength(1);
    });
    expectIsolated(failing, good, runtime);
  });

  it('실패한 기능은 설정이 그대로면 다시 시작하지 않고, 설정이 바뀌면 다시 시작한다', () => {
    const failing = failingPart('ping');
    const runtime = setup([failing.part]);
    runtime.apply(both);
    ping();
    ping();
    runtime.apply(both);
    expect(failing.counts.started).toBe(1);
    runtime.apply(snapshot({ failing: { enabled: false } }));
    runtime.apply(both);
    expect(failing.counts.started).toBe(2);
    expect(document.querySelectorAll(hostTagName)).toHaveLength(1);
    failing.target.remove();
  });

  it('정리 하나가 실패해도 나머지 정리는 하고 기록한다', () => {
    const cleanup = vi.fn();
    const part: PagePart = {
      featureId: 'cleanup',
      frames: 'all',
      start: (value, { scope }) => {
        if (!isEnabled(value, 'cleanup')) return;
        scope.defer(cleanup);
        scope.defer(() => {
          throw new Error('정리 고장');
        });
      },
    };
    const runtime = setup([part]);
    runtime.apply(snapshot({ cleanup: { enabled: true } }));
    runtime.apply(snapshot({ cleanup: { enabled: false } }));
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(runtime.reports).toEqual([{ featureId: 'cleanup', kind: 'unexpected' }]);
  });
});

describe('결정 0008 보조 방법: 물러남 이벤트 없이 연결만 끊긴 경우', () => {
  // 물러남 이벤트는 보내지 않고 연결만 끊는다. 새 판이 이벤트를 보내지 못했거나 놓친 경우다.
  function disconnectedRuntime() {
    const a = countingPart('a');
    const runtime = setup([a.part], true);
    runtime.apply(snapshot({ a: { enabled: true } }));
    runtime.deps.isConnected = () => false;
    return { a, runtime };
  }

  function expectRetired({ a, runtime }: ReturnType<typeof disconnectedRuntime>) {
    expect(a.counts.disposed).toBe(1);
    expect(runtime.unsubscribed()).toBe(1);
  }

  it('COM-7.2 탭이 다시 보이면 연결을 확인해 물러난다', () => {
    const disconnected = disconnectedRuntime();
    expect(document.visibilityState).toBe('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expectRetired(disconnected);
  });

  it('COM-7.2 페이지 안에서 이동하면(history.pushState) 연결을 확인해 물러난다', async () => {
    const original = location.href;
    const disconnected = disconnectedRuntime();
    history.pushState(null, '', `${original.split('#')[0] ?? ''}#moved`);
    try {
      await vi.waitFor(() => {
        expectRetired(disconnected);
      });
    } finally {
      history.replaceState(null, '', original);
    }
  });

  it('COM-7.2 기능이 페이지 사건(확장 단축키, 화면 조작 포함)에 반응하려 하면 확인해 물러나고, 그 콜백은 돌지 않는다', () => {
    const disconnected = disconnectedRuntime();
    ping();
    expect(disconnected.a.counts.pings).toBe(0);
    expectRetired(disconnected);
  });

  it('COM-7.2 읽기 도우미가 문제를 알릴 때도 확인해, 끊겼으면 기록하지 않고 물러난다', () => {
    const disconnected = disconnectedRuntime();
    disconnected.runtime.problem(appError('platform', '설정을 읽지 못했다.'));
    expect(disconnected.runtime.reports).toEqual([]);
    expectRetired(disconnected);
  });

  it('결정 0008 셋째 방법: 확장에 보낸 요청이 끊김으로 돌아오면 물러난다', async () => {
    const a = countingPart('a');
    const runtime = setup([a.part], true);
    runtime.apply(snapshot({ a: { enabled: true } }));
    runtime.deps.report = () =>
      Promise.resolve(err(appError('disconnected', '확장이 다시 로드되었다.')));
    runtime.problem(appError('timeout', '응답 없음'));
    await vi.waitFor(() => {
      expect(a.counts.disposed).toBe(1);
    });
    expect(runtime.unsubscribed()).toBe(1);
  });

  it('COM-7.2 한 기능이 시작하는 도중에 연결이 끊긴 것을 알아 물러나도, 같은 적용에서 그 뒤에 시작한 기능까지 모두 정리된다', () => {
    let connected = true;
    // 시작하면서 자기가 듣는 페이지 사건을 곧바로 일으키는 기능. 그 콜백 앞에서 실행 틀이 연결을 확인한다.
    const early: PagePart = {
      featureId: 'early',
      frames: 'all',
      start: (value, { scope }) => {
        if (!isEnabled(value, 'early')) return;
        scope.listen(document, 'test-early', () => undefined);
        connected = false;
        document.dispatchEvent(new Event('test-early'));
      },
    };
    const late = countingPart('late');
    const runtime = setup([early, late.part], true);
    runtime.deps.isConnected = () => connected;
    runtime.apply(snapshot({ early: { enabled: true }, late: { enabled: true } }));
    expect(runtime.unsubscribed()).toBe(1);
    expect(late.counts).toMatchObject({ started: 1, disposed: 1 });
    ping();
    expect(late.counts.pings).toBe(0);
  });

  it('연결이 살아 있으면 보이기·이동·페이지 사건에도 물러나지 않는다', () => {
    const a = countingPart('a');
    const runtime = setup([a.part], true);
    runtime.apply(snapshot({ a: { enabled: true } }));
    const original = location.href;
    document.dispatchEvent(new Event('visibilitychange'));
    history.pushState(null, '', `${original.split('#')[0] ?? ''}#stay`);
    history.replaceState(null, '', original);
    ping();
    expect(a.counts).toMatchObject({ disposed: 0, pings: 1 });
    expect(runtime.unsubscribed()).toBe(0);
  });
});

describe('COM-6 기대는 외부 화면 요소를 찾지 못함(결정 0026)', () => {
  // 시계는 가짜이고, 문서가 보이는지는 시험이 정한다(headless Chromium의 문서는 늘 visible이다).
  let visibility: DocumentVisibilityState = 'visible';
  const added: Element[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(document, 'visibilityState');
    visibility = 'visible';
    for (const element of added.splice(0)) element.remove();
  });

  const setVisibility = (next: DocumentVisibilityState) => {
    visibility = next;
    document.dispatchEvent(new Event('visibilitychange'));
  };

  // 외부 사이트의 요소를 본뜬 시험 요소. 찾는 단서는 aria-label이다.
  const labelled = (id: string, name: string): NamedElement => ({
    id,
    name,
    find: (root) => root.querySelector(`[aria-label="${name}"]`),
  });
  const region = labelled('test.region', '시험 영역');
  const editArea = labelled('test.edit-area', '시험 수정 영역');

  const add = (label: string, tag = 'section'): Element => {
    const element = document.createElement(tag);
    element.setAttribute('aria-label', label);
    document.body.append(element);
    added.push(element);
    return element;
  };

  // 관찰 알림(마이크로태스크)까지 처리한다.
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  // 늘 있는 요소에 기대는 기능. 켜지면 먼저 문서 루트에 표시를 달고(반쯤 적용한 변경), 시험 영역을 찾으면 그 영역에도
  // 표시를 단다. 모두 범위에 맡긴다.
  function regionPart() {
    const counts = { started: 0, applied: 0 };
    const part: PagePart = {
      featureId: 'region',
      frames: 'all',
      start: (value, { scope, find }) => {
        if (!isEnabled(value, 'region')) return;
        counts.started += 1;
        const root = document.documentElement;
        root.setAttribute('data-test-region', 'waiting');
        scope.defer(() => {
          root.removeAttribute('data-test-region');
        });
        find(region, (element) => {
          counts.applied += 1;
          element.setAttribute('data-test-applied', '');
          scope.defer(() => {
            element.removeAttribute('data-test-applied');
          });
        });
      },
    };
    return { part, counts };
  }

  // 조작해야 생기는 요소에 기대는 기능. "시험 수정" 단추를 누르면 그때부터 수정 영역을 찾는다.
  function editPart() {
    const counts = { started: 0, applied: 0 };
    const part: PagePart = {
      featureId: 'edit',
      frames: 'all',
      start: (value, { scope, find }) => {
        if (!isEnabled(value, 'edit')) return;
        counts.started += 1;
        scope.listen(document, 'click', (event) => {
          if (!(event.target instanceof Element)) return;
          if (event.target.getAttribute('aria-label') !== '시험 수정') return;
          find(editArea, () => {
            counts.applied += 1;
          });
        });
      },
    };
    return { part, counts };
  }

  const notFoundReport = (featureId: string, element: NamedElement): PageProblem => ({
    featureId,
    kind: 'not-found',
    element: { id: element.id, name: element.name },
  });

  it('COM-6.1 요소가 없으면 켠 때부터 15초 뒤 그 기능만 멈추고 반쯤 적용한 변경을 되돌리며, 찾지 못한 요소와 함께 기록한다', () => {
    const feature = regionPart();
    const runtime = setup([feature.part]);
    const before = document.documentElement.getAttributeNames();
    runtime.apply(snapshot({ region: { enabled: true } }));
    expect(document.documentElement.getAttribute('data-test-region')).toBe('waiting');
    vi.advanceTimersByTime(elementTimeoutMs - 1);
    expect(runtime.reports).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(document.documentElement.getAttributeNames()).toEqual(before);
    expect(runtime.reports).toEqual([notFoundReport('region', region)]);
  });

  it('COM-6.2 찾지 못한 기능이 멈춰도 같은 페이지의 다른 기능은 그대로 돈다', () => {
    const feature = regionPart();
    const other = countingPart('other');
    const runtime = setup([feature.part, other.part]);
    runtime.apply(snapshot({ region: { enabled: true }, other: { enabled: true } }));
    vi.advanceTimersByTime(elementTimeoutMs);
    ping();
    expect(other.counts).toEqual({ started: 1, disposed: 0, pings: 1 });
  });

  it('COM-6.3 찾지 못한 뒤 요소가 나타나면 그 기능을 다시 시작해 작용하고 더 기록하지 않는다', async () => {
    const feature = regionPart();
    const runtime = setup([feature.part]);
    runtime.apply(snapshot({ region: { enabled: true } }));
    vi.advanceTimersByTime(elementTimeoutMs);
    // 한참 뒤에 나타나도 지켜본다(한도가 없다).
    vi.advanceTimersByTime(10 * 60_000);
    const element = add('시험 영역');
    await settle();
    expect(feature.counts).toEqual({ started: 2, applied: 1 });
    expect(element.hasAttribute('data-test-applied')).toBe(true);
    expect(runtime.reports).toHaveLength(1);
  });

  it('COM-6.5 페이지를 연 지 15초가 지난 뒤 켜면 요소가 있을 때는 바로 작용하고, 없을 때는 켠 때부터 15초 뒤에 찾지 못함이 된다', () => {
    const feature = regionPart();
    const runtime = setup([feature.part]);
    runtime.apply(snapshot({ region: { enabled: false } }));
    vi.advanceTimersByTime(20_000);
    const element = add('시험 영역');
    runtime.apply(snapshot({ region: { enabled: true } }));
    expect(element.hasAttribute('data-test-applied')).toBe(true);

    runtime.apply(snapshot({ region: { enabled: false } }));
    element.remove();
    vi.advanceTimersByTime(20_000);
    runtime.apply(snapshot({ region: { enabled: true } }));
    vi.advanceTimersByTime(elementTimeoutMs - 1);
    expect(runtime.reports).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(runtime.reports).toEqual([notFoundReport('region', region)]);
  });

  it('COM-6.6 조작해야 생기는 요소는 조작하지 않으면 5분이 지나도 찾지 못함이 되지 않고, 조작한 뒤 15초 안에 생기지 않으면 찾지 못함이 된다', () => {
    const feature = editPart();
    const runtime = setup([feature.part]);
    runtime.apply(snapshot({ edit: { enabled: true } }));
    vi.advanceTimersByTime(5 * 60_000);
    expect(runtime.reports).toEqual([]);
    const button = add('시험 수정', 'button');
    if (!(button instanceof HTMLElement)) throw new Error('단추가 아니다.');
    button.click();
    vi.advanceTimersByTime(elementTimeoutMs - 1);
    expect(runtime.reports).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(runtime.reports).toEqual([notFoundReport('edit', editArea)]);
  });

  it('COM-6.6 조작한 뒤 요소가 생기면 작용한다', async () => {
    const feature = editPart();
    const runtime = setup([feature.part]);
    runtime.apply(snapshot({ edit: { enabled: true } }));
    const button = add('시험 수정', 'button');
    if (!(button instanceof HTMLElement)) throw new Error('단추가 아니다.');
    button.click();
    vi.advanceTimersByTime(3000);
    add('시험 수정 영역');
    await settle();
    expect(feature.counts).toEqual({ started: 1, applied: 1 });
    vi.advanceTimersByTime(elementTimeoutMs);
    expect(runtime.reports).toEqual([]);
  });

  it('COM-6.7 요소가 탭이 보일 때에야 생기는 페이지를 숨겨진 탭으로 열어 1분 뒤에 보이게 하면 찾지 못함이 되지 않는다', async () => {
    visibility = 'hidden';
    // 보일 때 요소를 만드는 페이지.
    const showRegion = () => {
      if (document.visibilityState === 'visible') add('시험 영역');
    };
    document.addEventListener('visibilitychange', showRegion);
    try {
      const feature = regionPart();
      const runtime = setup([feature.part]);
      runtime.apply(snapshot({ region: { enabled: true } }));
      vi.advanceTimersByTime(60_000);
      setVisibility('visible');
      await settle();
      vi.advanceTimersByTime(elementTimeoutMs);
      expect(runtime.reports).toEqual([]);
      expect(feature.counts.applied).toBe(1);
    } finally {
      document.removeEventListener('visibilitychange', showRegion);
    }
  });

  it('COM-6 기대 동작 2 서비스 워커가 물으면 지금 찾지 못한 기능과 그 요소를 답하고, 다시 찾으면 목록에서 뺀다', async () => {
    const feature = regionPart();
    const runtime = setup([feature.part]);
    runtime.apply(snapshot({ region: { enabled: true } }));
    // 찾는 중(15초 전)에는 찾지 못함이 아니다.
    vi.advanceTimersByTime(elementTimeoutMs - 1);
    expect(runtime.status()).toEqual({ notFound: [] });
    vi.advanceTimersByTime(1);
    expect(runtime.status()).toEqual({
      notFound: [{ featureId: 'region', element: { id: 'test.region', name: '시험 영역' } }],
    });
    add('시험 영역');
    await settle();
    expect(runtime.status()).toEqual({ notFound: [] });
  });

  it('찾지 못한 기능을 끄면 목록에서 빠지고, 물러나면 묻기를 듣지 않는다', () => {
    const feature = regionPart();
    const runtime = setup([feature.part]);
    runtime.apply(snapshot({ region: { enabled: true } }));
    vi.advanceTimersByTime(elementTimeoutMs);
    runtime.apply(snapshot({ region: { enabled: false } }));
    expect(runtime.status()).toEqual({ notFound: [] });
    expect(runtime.statusListeners()).toBe(1);
    runtime.deps.isConnected = () => false;
    document.dispatchEvent(new Event(retireEventName));
    expect(runtime.statusListeners()).toBe(0);
  });

  it('quality 083 찾지 못한 기능을 끄면 지켜보기도 그친다', async () => {
    const feature = regionPart();
    const runtime = setup([feature.part]);
    runtime.apply(snapshot({ region: { enabled: true } }));
    vi.advanceTimersByTime(elementTimeoutMs);
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    runtime.apply(snapshot({ region: { enabled: false } }));
    expect(disconnect).toHaveBeenCalled();
    disconnect.mockRestore();
    add('시험 영역');
    await settle();
    expect(feature.counts).toEqual({ started: 1, applied: 0 });
  });

  it('결정 0008 물러나면 지켜보기도 그친다', async () => {
    const feature = regionPart();
    const runtime = setup([feature.part]);
    runtime.apply(snapshot({ region: { enabled: true } }));
    vi.advanceTimersByTime(elementTimeoutMs);
    runtime.deps.isConnected = () => false;
    document.dispatchEvent(new Event(retireEventName));
    add('시험 영역');
    await settle();
    expect(feature.counts).toEqual({ started: 1, applied: 0 });
  });

  it('quality 010 지켜보는 동안 찾는 함수가 던지면 그 기능의 실패로 기록하고, 설정이 바뀔 때까지 다시 찾지 않는다', async () => {
    let broken = false;
    const fragile: NamedElement = {
      ...region,
      find: (root) => {
        if (broken) throw new Error('사이트 모듈의 결함');
        return region.find(root);
      },
    };
    const counts = { started: 0 };
    const part: PagePart = {
      featureId: 'fragile',
      frames: 'all',
      start: (value, { find }) => {
        if (!isEnabled(value, 'fragile')) return;
        counts.started += 1;
        find(fragile, () => undefined);
      },
    };
    const runtime = setup([part]);
    runtime.apply(snapshot({ fragile: { enabled: true } }));
    vi.advanceTimersByTime(elementTimeoutMs);
    broken = true;
    add('다른 영역');
    await settle();
    expect(runtime.reports).toEqual([
      notFoundReport('fragile', region),
      { featureId: 'fragile', kind: 'unexpected' },
    ]);
    broken = false;
    add('시험 영역');
    await settle();
    expect(counts.started).toBe(1);
  });
});

describe('결정 0004 기능의 프레임 범위(기능 정의의 content.frames, 아키텍처 2장)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 이 문서에 없는 외부 화면 요소.
  const missing: NamedElement = { id: 'test.missing', name: '없는 영역', find: () => null };

  // 그 프레임 범위로 정의한 켜고 끄기 기능과 그 페이지 쪽 일. 켜지면 시작을 세고 문서 루트에 표시를 단 뒤 없는 영역을
  // 찾는다. 표시는 범위에 맡긴다.
  function framedFeature(id: string, frames: 'all' | 'top') {
    const definition = defineFeature({
      id,
      requirements: [],
      name: id,
      description: `${id} 시험`,
      category: 'page',
      kind: 'toggle',
      content: { sites: 'all', frames },
      permissions: [],
      settings: { schema: v.object({ enabled: v.boolean() }), defaults: { enabled: false } },
    });
    const counts = { started: 0 };
    const attribute = `data-test-${id}`;
    const part = definePagePart(definition, (_settings, { scope, find }) => {
      counts.started += 1;
      const root = document.documentElement;
      root.setAttribute(attribute, '');
      scope.defer(() => {
        root.removeAttribute(attribute);
      });
      find(missing, () => undefined);
    });
    return { part, counts, marked: () => document.documentElement.hasAttribute(attribute) };
  }

  const notFound = (featureId: string): PageProblem => ({
    featureId,
    kind: 'not-found',
    element: { id: missing.id, name: missing.name },
  });

  it('iframe의 실행 틀은 최상위에서만 작용하는 기능을 시작하지 않아 문서를 바꾸지 않고 15초가 지나도 찾지 못함을 기록하지 않는다. 모든 프레임에서 작용하는 기능은 시작한다', () => {
    const topOnly = framedFeature('top-only', 'top');
    const everywhere = framedFeature('everywhere', 'all');
    const runtime = setup([topOnly.part, everywhere.part], true, false);
    runtime.apply(snapshot({ 'top-only': { enabled: true }, everywhere: { enabled: true } }));
    expect(topOnly.counts.started).toBe(0);
    expect(topOnly.marked()).toBe(false);
    expect(everywhere.counts.started).toBe(1);
    expect(everywhere.marked()).toBe(true);
    vi.advanceTimersByTime(elementTimeoutMs);
    expect(runtime.reports).toEqual([notFound('everywhere')]);
    expect(runtime.status()?.notFound.map(({ featureId }) => featureId)).toEqual(['everywhere']);
  });

  it('페이지에 작용하지 않는 기능(content: null)에는 페이지 쪽 일을 만들 수 없다(타입 검사가 막는다)', () => {
    const nowhere = defineFeature({
      id: 'nowhere',
      requirements: [],
      name: 'nowhere',
      description: 'nowhere 시험',
      category: 'tabs',
      kind: 'toggle',
      content: null,
      permissions: [],
      settings: { schema: v.object({ enabled: v.boolean() }), defaults: { enabled: false } },
    });
    // @ts-expect-error 페이지에 작용한다고 적지 않은 정의다. 실행하면 정의에 프레임 범위가 없어 실패한다.
    const make = () => definePagePart(nowhere, () => undefined);
    expect(make).toThrow(TypeError);
  });

  it('최상위 프레임의 실행 틀은 두 기능을 모두 시작한다', () => {
    const topOnly = framedFeature('top-only', 'top');
    const everywhere = framedFeature('everywhere', 'all');
    const runtime = setup([topOnly.part, everywhere.part], true, true);
    runtime.apply(snapshot({ 'top-only': { enabled: true }, everywhere: { enabled: true } }));
    expect(topOnly.counts.started).toBe(1);
    expect(everywhere.counts.started).toBe(1);
    vi.advanceTimersByTime(elementTimeoutMs);
    expect(runtime.reports).toEqual([notFound('top-only'), notFound('everywhere')]);
  });
});
