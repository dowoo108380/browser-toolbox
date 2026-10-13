import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBackground } from '../../src/background/index.ts';
import {
  repairNoticeDismiss,
  responseSchema,
  settingsUpdate,
  storageEnsureReady,
} from '../../src/contracts/index.ts';
import { type FakeLocalStore, createFakeLocalStore } from '../../src/platform/fake.ts';
import type { LocalStore, Requester, Sender } from '../../src/platform/index.ts';
import { appError, err } from '../../src/shared/index.ts';
import {
  parseRepairNotice,
  repairNoticeKey,
  settingsFormat,
  settingsKey,
  startSettingsReader,
  watchRepairNotice,
} from '../../src/storage/index.ts';
import { PopupApp } from '../../src/ui/index.ts';
import { specs, stored } from '../support/settings.ts';

// 설정 손상과 복구 알림(COM-3.4, 결정 0016)을 실제 모듈끼리 연결해 본다. 가짜는 Chrome 경계뿐이다:
// 저장소(chrome.storage.local)와 메시지 통로(chrome.runtime.sendMessage). 서비스 워커(라우터, 설정 저장,
// 복구 알림 기록)와 팝업(읽기 도우미, 복구 알림 읽기, 화면)은 실제 코드다. 응답과 읽기 결과는 시험이 붙잡아
// 순서를 바꾼다. 이 폴더는 src 밖이라 tsconfig.json의 JSX 설정(Preact)이 걸리지 않으므로 JSX 대신 h()를 쓴다.

const t = 1_790_000_000_000;

// 붙잡은 일을 시험이 정한 때에 놓아준다.
function gate() {
  const held: (() => void)[] = [];
  return {
    hold: <T>(work: () => Promise<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        held.push(() => {
          work().then(resolve, reject);
        });
      }),
    release: () => {
      for (const run of held.splice(0)) run();
    },
  };
}

// 서비스 워커를 시작하고, 팝업이 쓰는 요청 함수를 돌려준다. holdTypes의 요청은 놓아줄 때까지 서비스 워커에 닿지 않는다.
function startServiceWorker(store: LocalStore) {
  let handle: ((message: unknown, sender: Sender) => Promise<unknown>) | undefined;
  const clock = { time: t };
  startBackground({
    features: specs,
    format: settingsFormat,
    store,
    now: () => clock.time,
    sleep: (ms) => {
      clock.time += ms;
      return Promise.resolve();
    },
    listenRequests: (listener) => {
      handle = listener;
    },
    onInstalled: () => undefined,
    retireOldScripts: () => Promise.resolve(),
  });
  const held = new Set<string>();
  const requests = gate();
  // chromeRequester처럼 메시지를 구조화 복제로 건네고, 응답을 그 요청의 정의로 검증한다.
  const request: Requester = async (definition, payload) => {
    const deliver = async (): Promise<unknown> => {
      if (handle === undefined) throw new Error('서비스 워커가 요청을 듣지 않는다.');
      const message = structuredClone({ type: definition.type, payload });
      return structuredClone(await handle(message, { kind: 'extension' }));
    };
    const response = await (held.has(definition.type) ? requests.hold(deliver) : deliver());
    const parsed = responseSchema(definition.value).safeParse(response);
    return parsed.success
      ? parsed.data
      : err(appError('unexpected', '확장의 응답 형식이 맞지 않는다.'));
  };
  return {
    request,
    holdRequests: (type: string) => held.add(type),
    releaseRequests: () => {
      held.clear();
      requests.release();
    },
  };
}

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) {
    render(null, container);
    container.remove();
  }
});

// 실제 진입점(src/entries/popup.tsx)과 같게 조립한 팝업. noticeStore로 복구 알림 읽기만 다른 저장소 창을 쓸 수 있다.
async function openPopup(
  store: LocalStore,
  request: Requester,
  noticeStore: Pick<LocalStore, 'get' | 'onChanged'> = store,
) {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  await act(() => {
    render(
      h(PopupApp, {
        features: specs,
        subscribe: (handlers) =>
          startSettingsReader({ store, request, format: settingsFormat, specs }, handlers),
        watchRepairs: (handlers) => watchRepairNotice(noticeStore, handlers),
        wake: () => request(storageEnsureReady, {}),
        update: (featureId, patch) => request(settingsUpdate, { featureId, patch }),
        dismissRepair: (stamp) => request(repairNoticeDismiss, { stamp }),
      }),
      container,
    );
  });
  const toggle = (featureId: string) =>
    container.querySelector<HTMLInputElement>(`[data-feature="${featureId}"]`);
  return {
    repairText: () => container.querySelector('.repair')?.textContent ?? null,
    checked: (featureId: string) => toggle(featureId)?.checked,
    // 첫 깨우기의 응답을 받아 스위치를 쓸 수 있을 때까지 기다린다.
    awake: () =>
      vi.waitFor(() => {
        expect(toggle('other')?.disabled).toBe(false);
      }),
    confirm: () =>
      act(async () => {
        container.querySelector<HTMLButtonElement>('.repair button')?.click();
        await Promise.resolve();
      }),
    close: () => {
      render(null, container);
    },
  };
}

function featureIds(store: FakeLocalStore): string[] {
  const value = store.peek(settingsKey);
  if (typeof value !== 'object' || value === null || !('features' in value)) return [];
  const { features } = value;
  return typeof features === 'object' && features !== null ? Object.keys(features) : [];
}

// 문자열에 나온 횟수.
const countOf = (text: string | null, part: string) => (text ?? '').split(part).length - 1;

describe('COM-3.4 서비스 워커가 먼저 고쳐 쓴 뒤 팝업을 연다', () => {
  it('팝업은 고친 값만 읽어도 기본값으로 바꾼 기능 이름을 알리고, 확인하면 다시 열어도 없다', async () => {
    const store = createFakeLocalStore({
      [settingsKey]: stored(5, { sample: { enabled: 'no' }, other: { enabled: true } }),
    });
    const worker = startServiceWorker(store);
    // 서비스 워커가 시작하면서 고쳐 쓴다. 팝업은 그 뒤에 열린다.
    await vi.waitFor(() => {
      expect(featureIds(store)).toEqual(['other']);
    });

    const popup = await openPopup(store, worker.request);
    await vi.waitFor(() => {
      expect(popup.repairText()).toContain('기본값으로 바꿨다: 시험 기능.');
    });
    // 손상 항목은 기본값, 나머지 항목은 그대로다.
    expect(popup.checked('sample')).toBe(false);
    expect(popup.checked('other')).toBe(true);
    expect(popup.repairText()).not.toContain('다른 기능');

    await popup.awake();
    await popup.confirm();
    expect(popup.repairText()).toBeNull();
    await vi.waitFor(() => {
      expect(store.peek(repairNoticeKey)).toMatchObject({ whole: false, features: [] });
    });
    popup.close();

    const again = await openPopup(store, worker.request);
    await again.awake();
    expect(again.repairText()).toBeNull();
  });

  it('설정 전체가 손상되었으면 모든 설정을 기본값으로 바꿨다고 알린다', async () => {
    const store = createFakeLocalStore({ [settingsKey]: { version: 'x' } });
    const worker = startServiceWorker(store);
    await vi.waitFor(() => {
      expect(store.peek(settingsKey)).toMatchObject({ version: 1, features: {} });
    });
    const popup = await openPopup(store, worker.request);
    await vi.waitFor(() => {
      expect(popup.repairText()).toContain('모든 설정을 기본값으로 바꿨다');
    });
    expect(popup.checked('other')).toBe(false);
  });

  it('알림을 읽은 결과가 새 손상이 더해진 기록보다 늦게 와도, 더 나중 기록을 보인다', async () => {
    const store = createFakeLocalStore({
      [settingsKey]: stored(5, { sample: { enabled: 'no' }, other: { enabled: true } }),
    });
    const worker = startServiceWorker(store);
    await vi.waitFor(() => {
      expect(featureIds(store)).toEqual(['other']);
    });
    // 팝업의 복구 알림 읽기 결과(읽기를 시작한 때의 기록: 시험 기능만)를 붙잡는다.
    const reads = gate();
    const popup = await openPopup(store, worker.request, {
      onChanged: (key, listener) => store.onChanged(key, listener),
      get: (key) => store.get(key).then((value) => reads.hold(() => Promise.resolve(value))),
    });
    await popup.awake();
    // 그사이 다른 기능의 설정도 손상된다. 팝업의 읽기 도우미는 이 값을 보지 못하고(이미 받은 값보다 세대 번호가
    // 작다) 다른 탭의 페이지가 서비스 워커에 고쳐 쓰기를 부탁한다. 그래서 팝업은 서비스 워커의 기록으로만 안다.
    store.replace(settingsKey, stored(3, { other: { enabled: 'no' } }));
    expect(await worker.request(storageEnsureReady, {})).toEqual({ ok: true, value: null });
    await vi.waitFor(() => {
      expect(popup.repairText()).toContain('기본값으로 바꿨다: 시험 기능, 다른 기능.');
    });
    reads.release();
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(popup.repairText()).toContain('기본값으로 바꿨다: 시험 기능, 다른 기능.');
  });
});

describe('COM-3.4 팝업이 열린 채 손상이 생긴다', () => {
  async function openOnHealthySettings() {
    const store = createFakeLocalStore({ [settingsKey]: stored(5, { other: { enabled: true } }) });
    const worker = startServiceWorker(store);
    const popup = await openPopup(store, worker.request);
    await popup.awake();
    expect(popup.checked('other')).toBe(true);
    expect(popup.repairText()).toBeNull();
    return { store, worker, popup };
  }

  it('항목 손상: 기능 이름을 바로 알리고, 서비스 워커가 고쳐 쓴 기록과 겹쳐도 한 번만 보인다', async () => {
    const { store, popup } = await openOnHealthySettings();
    store.replace(settingsKey, stored(6, { sample: { enabled: 'no' }, other: { enabled: true } }));
    // 읽기 도우미가 고쳐 쓰기를 부탁해 서비스 워커가 기록을 남기고 고쳐 쓴다.
    await vi.waitFor(() => {
      expect(featureIds(store)).toEqual(['other']);
    });
    expect(store.peek(repairNoticeKey)).toMatchObject({ whole: false, features: ['sample'] });
    expect(countOf(popup.repairText(), '시험 기능')).toBe(1);
    expect(popup.checked('other')).toBe(true);
  });

  it('전체 손상: 모든 설정을 기본값으로 보이고 알리며, 서비스 워커가 기본 설정으로 고쳐 쓴다', async () => {
    const { store, popup } = await openOnHealthySettings();
    store.replace(settingsKey, { version: 1 });
    await vi.waitFor(() => {
      expect(popup.repairText()).toContain('모든 설정을 기본값으로 바꿨다');
    });
    await vi.waitFor(() => {
      expect(store.peek(settingsKey)).toMatchObject({ version: 1, features: {}, sites: {} });
    });
    expect(popup.checked('other')).toBe(false);
  });

  it('확인이 서비스 워커에 닿기 전에 새 손상이 기록되면, 확인은 새 기록을 지우지 않는다', async () => {
    const { store, worker, popup } = await openOnHealthySettings();
    store.replace(settingsKey, stored(6, { sample: { enabled: 'no' }, other: { enabled: true } }));
    await vi.waitFor(() => {
      expect(store.peek(repairNoticeKey)).toMatchObject({ features: ['sample'] });
    });
    // 확인 요청을 붙잡아 둔 채 다른 기능의 설정이 손상된다.
    worker.holdRequests('repairNotice.dismiss');
    await popup.confirm();
    expect(popup.repairText()).toBeNull();
    store.replace(settingsKey, stored(t + 100, { other: { enabled: 'no' } }));
    await vi.waitFor(() => {
      expect(store.peek(repairNoticeKey)).toMatchObject({ features: ['sample', 'other'] });
    });
    worker.releaseRequests();
    await vi.waitFor(() => {
      expect(popup.repairText()).toContain('시험 기능, 다른 기능');
    });
    // 늦게 닿은 확인은 자기가 본 기록이 아니므로 지우지 않는다.
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(store.peek(repairNoticeKey)).toMatchObject({ features: ['sample', 'other'] });
    expect(popup.repairText()).toContain('시험 기능, 다른 기능');
  });

  // 같은 범위가 다시 손상되어 고쳐진 경우. 기록의 범위는 그대로라도 새 기록이어야, 첫 손상에 대한 늦은 확인이
  // 두 번째 손상의 알림까지 지우지 않는다(결정 0016).
  it.each([
    {
      name: '같은 기능',
      // 팝업의 읽기 도우미는 이 값을 보지 못한다(이미 받은 값보다 세대 번호가 작다). 팝업은 기록으로만 안다.
      corrupt: () => stored(3, { sample: { enabled: 'no' }, other: { enabled: true } }),
      scope: { whole: false, features: ['sample'] },
      text: '기본값으로 바꿨다: 시험 기능.',
    },
    {
      name: '설정 전체',
      corrupt: () => ({ version: 1 }),
      scope: { whole: true, features: [] },
      text: '모든 설정을 기본값으로 바꿨다',
    },
  ])(
    '확인이 서비스 워커에 닿기 전에 같은 범위가 다시 손상되어 고쳐지면, 늦은 확인은 두 번째 기록을 지우지 않는다: $name',
    async ({ corrupt, scope, text }) => {
      const { store, worker, popup } = await openOnHealthySettings();
      const stampOf = () => parseRepairNotice(store.peek(repairNoticeKey))?.stamp ?? 0;
      // 손상되고, 다른 탭의 페이지가 서비스 워커에 고쳐 쓰기를 부탁한다.
      store.replace(settingsKey, corrupt());
      expect(await worker.request(storageEnsureReady, {})).toEqual({ ok: true, value: null });
      await vi.waitFor(() => {
        expect(store.peek(repairNoticeKey)).toMatchObject(scope);
        expect(popup.repairText()).toContain(text);
      });
      const first = stampOf();

      worker.holdRequests('repairNotice.dismiss');
      await popup.confirm();
      expect(popup.repairText()).toBeNull();
      // 같은 범위가 다시 손상되고, 다시 고쳐 쓰기를 부탁한다.
      store.replace(settingsKey, corrupt());
      expect(await worker.request(storageEnsureReady, {})).toEqual({ ok: true, value: null });
      await vi.waitFor(() => {
        expect(stampOf()).toBeGreaterThan(first);
      });
      await vi.waitFor(() => {
        expect(popup.repairText()).toContain(text);
      });

      worker.releaseRequests();
      await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
      expect(store.peek(repairNoticeKey)).toMatchObject(scope);
      expect(stampOf()).toBeGreaterThan(first);
      expect(popup.repairText()).toContain(text);
    },
  );
});
