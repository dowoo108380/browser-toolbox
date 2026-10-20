import { describe, expect, it } from 'vitest';
import type { DebuggerLoss } from '../platform/index.ts';
import { type AppError, type Result, appError, err, ok } from '../shared/index.ts';
import { createDebuggerManager } from './debugger.ts';
import type { Problem } from './problems.ts';

// 서비스 워커의 디버거 관리(아키텍처 8장, 결정 0042): 탭마다 연결 하나, 쓰는 쪽을 센다. 붙이기와 떼기는 시험이 끝을 정한다.

interface Pending {
  readonly tabId: number;
  readonly resolve: (result: Result<null, AppError>) => void;
}

function setup() {
  const attaches: Pending[] = [];
  const detaches: Pending[] = [];
  const sent: { readonly tabId: number; readonly method: string }[] = [];
  const problems: Problem[] = [];
  const manager = createDebuggerManager({
    attach: (tabId) =>
      new Promise((resolve) => {
        attaches.push({ tabId, resolve });
      }),
    detach: (tabId) =>
      new Promise((resolve) => {
        detaches.push({ tabId, resolve });
      }),
    send: (tabId, method) => {
      sent.push({ tabId, method });
      return Promise.resolve(ok({}));
    },
    record: (problem) => problems.push(problem),
  });
  const lost: { readonly user: string; readonly tabId: number; readonly loss: DebuggerLoss }[] = [];
  for (const user of ['keep', 'capture']) {
    manager.onLost(user, (tabId, loss) => lost.push({ user, tabId, loss }));
  }
  return { manager, attaches, detaches, sent, problems, lost };
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('디버거 관리(결정 0042)', () => {
  it('탭마다 연결 하나를 두고 쓰는 쪽이 둘이어도 한 번만 붙이며, 둘 다 그만 쓸 때 뗀다', async () => {
    const { manager, attaches, detaches } = setup();
    const keep = manager.acquire(1, 'keep');
    const capture = manager.acquire(1, 'capture');
    expect(attaches.map((call) => call.tabId)).toEqual([1]);
    attaches[0]?.resolve(ok(null));
    expect(await keep).toEqual(ok(null));
    expect(await capture).toEqual(ok(null));
    manager.release(1, 'capture');
    await flush();
    expect(detaches).toEqual([]);
    manager.release(1, 'keep');
    await flush();
    expect(detaches.map((call) => call.tabId)).toEqual([1]);
  });

  it('붙은 탭에만 명령을 보낸다. 붙기 전이나 뗀 뒤에는 unavailable이다', async () => {
    const { manager, attaches, detaches, sent } = setup();
    const acquired = manager.acquire(2, 'keep');
    const early = await manager.send(2, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    expect(early.ok ? null : early.error.kind).toBe('unavailable');
    attaches[0]?.resolve(ok(null));
    await acquired;
    expect(await manager.send(2, 'Emulation.setFocusEmulationEnabled', { enabled: true })).toEqual(
      ok({}),
    );
    manager.release(2, 'keep');
    detaches[0]?.resolve(ok(null));
    await flush();
    const late = await manager.send(2, 'Page.setWebLifecycleState', { state: 'active' });
    expect(late.ok ? null : late.error.kind).toBe('unavailable');
    expect(sent.map((call) => call.method)).toEqual(['Emulation.setFocusEmulationEnabled']);
  });

  it('TAB-2.4 붙이지 못하면 기다리던 쪽에 그 까닭을 준다', async () => {
    const { manager, attaches } = setup();
    const acquired = manager.acquire(3, 'keep');
    const refusal = appError('permission', '붙일 수 없는 화면이다.');
    attaches[0]?.resolve(err(refusal));
    expect(await acquired).toEqual(err(refusal));
  });

  it('붙기 전에 그만 쓰면 기다림이 cancelled로 끝나고, 붙은 연결은 곧 뗀다', async () => {
    const { manager, attaches, detaches } = setup();
    const acquired = manager.acquire(4, 'keep');
    manager.release(4, 'keep');
    const result = await acquired;
    expect(result.ok ? null : result.error.kind).toBe('cancelled');
    attaches[0]?.resolve(ok(null));
    await flush();
    expect(detaches.map((call) => call.tabId)).toEqual([4]);
  });

  it('TAB-2.7 Chrome이 연결을 끊으면 그 탭을 쓰던 쪽마다 알리고, 다시 쓰면 새로 붙인다', async () => {
    const { manager, attaches, lost } = setup();
    const keep = manager.acquire(5, 'keep');
    attaches[0]?.resolve(ok(null));
    await keep;
    manager.lost(5, 'cancelled');
    expect(lost).toEqual([{ user: 'keep', tabId: 5, loss: 'cancelled' }]);
    void manager.acquire(5, 'keep');
    expect(attaches.map((call) => call.tabId)).toEqual([5, 5]);
  });

  it('결정 0038 쓰는 쪽이 없는 탭에 남았을 수 있는 연결을 뗀다', async () => {
    const { manager, detaches } = setup();
    manager.discard(6);
    expect(detaches.map((call) => call.tabId)).toEqual([6]);
    detaches[0]?.resolve(ok(null));
    await flush();
  });

  it('떼지 못해도(일어나면 안 됨) 떨어진 것으로 보고 기록하며, 다시 쓰면 붙인다', async () => {
    const { manager, attaches, detaches, problems } = setup();
    const keep = manager.acquire(7, 'keep');
    attaches[0]?.resolve(ok(null));
    await keep;
    manager.release(7, 'keep');
    detaches[0]?.resolve(err(appError('platform', '떼지 못했다.')));
    await flush();
    expect(problems).toEqual([{ featureId: null, kind: 'platform' }]);
    void manager.acquire(7, 'keep');
    expect(attaches).toHaveLength(2);
  });

  it('붙이기가 던져도(일어나면 안 됨) 기다리던 쪽에 unexpected를 주고 기록한다', async () => {
    const problems: Problem[] = [];
    const manager = createDebuggerManager({
      attach: () => Promise.reject(new Error('던짐')),
      detach: () => Promise.resolve(ok(null)),
      send: () => Promise.resolve(ok({})),
      record: (problem) => problems.push(problem),
    });
    const result = await manager.acquire(8, 'keep');
    expect(result.ok ? null : result.error.kind).toBe('unexpected');
    expect(problems).toEqual([{ featureId: null, kind: 'unexpected' }]);
  });
});
