import { afterEach, describe, expect, it, vi } from 'vitest';
import { retireEventName } from '../contracts/index.ts';
import {
  claimAttribute,
  createIsolatedHost,
  hostTagName,
  pageElementAttribute,
} from '../dom/index.ts';
import { retireInFrame } from '../platform/index.ts';
import { type AppError, type ErrorKind, type Result, appError, err, ok } from '../shared/index.ts';
import type { SettingsReaderHandlers, Snapshot } from '../storage/index.ts';
import type { PagePart } from './part.ts';
import { startPageRuntime } from './runtime.ts';

// 테스트가 만든 실행 틀. 테스트가 끝나면 모두 물러나게 해 다음 테스트에 남지 않게 한다(quality 104).
const started: { isConnected: () => boolean }[] = [];

afterEach(() => {
  for (const deps of started.splice(0)) deps.isConnected = () => false;
  document.dispatchEvent(new Event(retireEventName));
  for (const element of document.querySelectorAll(`[${pageElementAttribute}]`)) element.remove();
  Reflect.deleteProperty(globalThis, Symbol.for('browser-toolbox.page-runtime'));
});

function snapshot(features: Record<string, unknown>): Snapshot {
  return { features: new Map(Object.entries(features)), sites: new Map() };
}

function setup(parts: readonly PagePart[], connected = true) {
  let handlers: SettingsReaderHandlers | undefined;
  let subscriptions = 0;
  let unsubscribed = 0;
  const reports: { featureId: string | null; kind: ErrorKind }[] = [];
  const deps = {
    parts,
    context: { window, document },
    subscribe: (next: SettingsReaderHandlers) => {
      subscriptions += 1;
      handlers = next;
      return () => {
        unsubscribed += 1;
      };
    },
    report: (featureId: string | null, kind: ErrorKind): Promise<Result<null, AppError>> => {
      reports.push({ featureId, kind });
      return Promise.resolve(ok(null));
    },
    isConnected: () => connected,
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

describe('결정 0008 새 판의 정리(retireInFrame)', () => {
  // 켜지면 화면 요소 하나를 만드는 기능.
  const hostPart: PagePart = {
    featureId: 'host',
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
