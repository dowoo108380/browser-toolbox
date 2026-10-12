import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/mini';
import { defineFeature } from '../contracts/index.ts';
import { type AppError, type Result, appError, err, ok } from '../shared/index.ts';
import type { SettingsReaderHandlers, Snapshot } from '../storage/index.ts';
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

const off: Snapshot = { features: new Map([['sample', { enabled: false }]]), sites: {} };
const saveFailed = appError('platform', '설정을 저장하지 못했다. 저장된 설정은 바뀌지 않았다.');

interface Options {
  readonly wake?: () => Promise<Result<unknown, AppError>>;
  readonly update?: () => Promise<Result<unknown, AppError>>;
}

async function show({ wake = () => Promise.resolve(ok(null)), update }: Options = {}) {
  const updates = vi.fn(update ?? (() => Promise.resolve(ok(null))));
  const wakes = vi.fn(wake);
  // 저장된 설정을 바로 준다. 저장이 성공해도 바뀜 알림은 시험이 직접 보낸다.
  let handlers: SettingsReaderHandlers | undefined;
  const subscribe = (next: SettingsReaderHandlers) => {
    handlers = next;
    next.apply(off);
    return () => undefined;
  };
  await act(() => {
    render(
      <PopupApp features={[feature]} subscribe={subscribe} wake={wakes} update={updates} />,
      container,
    );
  });
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
    state: () => container.querySelector('.state')?.textContent,
    status: () => container.querySelector('[role=status]')?.textContent,
    apply: (snapshot: Snapshot) => act(() => handlers?.apply(snapshot)),
  };
}

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
    await popup.apply({ features: new Map([['sample', { enabled: true }]]), sites: {} });
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
