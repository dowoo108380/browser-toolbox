import { afterEach, describe, expect, it } from 'vitest';
import { retireEventName } from '../contracts/index.ts';
import { type ErrorKind, ok } from '../shared/index.ts';
import type { SettingsReaderHandlers, Snapshot } from '../storage/index.ts';
import type { PagePart } from './part.ts';
import { startPageRuntime } from './runtime.ts';

afterEach(() => {
  // 테스트마다 새 실행 틀에서 시작한다(quality 104).
  Reflect.deleteProperty(globalThis, Symbol.for('browser-toolbox.page-runtime'));
});

function snapshot(features: Record<string, unknown>): Snapshot {
  return { features: new Map(Object.entries(features)), sites: {} };
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
    report: (featureId: string | null, kind: ErrorKind) => {
      reports.push({ featureId, kind });
      return Promise.resolve(ok(null));
    },
    isConnected: () => connected,
  };
  startPageRuntime(deps);
  return {
    deps,
    reports,
    apply: (value: Snapshot) => handlers?.apply(value),
    subscriptions: () => subscriptions,
    unsubscribed: () => unsubscribed,
  };
}

// 켜짐이면 시작 횟수와 정리 횟수를 센다.
function countingPart(featureId: string) {
  const counts = { started: 0, disposed: 0 };
  const part: PagePart = {
    featureId,
    start: (value) => {
      const settings = value.features.get(featureId);
      if (typeof settings !== 'object' || settings === null || !('enabled' in settings))
        return null;
      if (settings.enabled !== true) return null;
      counts.started += 1;
      return () => {
        counts.disposed += 1;
      };
    },
  };
  return { part, counts };
}

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
    expect(a.counts).toEqual({ started: 1, disposed: 0 });
    expect(b.counts).toEqual({ started: 1, disposed: 0 });
    runtime.apply(snapshot({ a: { enabled: false }, b: { enabled: true } }));
    expect(a.counts).toEqual({ started: 1, disposed: 1 });
    expect(b.counts).toEqual({ started: 1, disposed: 0 });
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

  it('COM-7.2 연결이 끊겼으면 물러남 이벤트에 모든 기능을 정리하고 구독을 그만둔다', () => {
    const a = countingPart('a');
    const runtime = setup([a.part], false);
    runtime.apply(snapshot({ a: { enabled: true } }));
    document.dispatchEvent(new Event(retireEventName));
    expect(a.counts.disposed).toBe(1);
    expect(runtime.unsubscribed()).toBe(1);
  });
});
