import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/mini';
import { defineFeature } from '../contracts/index.ts';
import { type AppError, type Result, appError, err, ok } from '../shared/index.ts';
import type { SettingsReaderHandlers, Snapshot } from '../storage/index.ts';
import { PopupApp } from './popup-app.tsx';

// 팝업 부품(COM-2, COM-3). 저장소와 서비스 워커는 가짜로 바꿔 끼운다.

const container = document.createElement('div');
document.body.append(container);

afterEach(() => {
  render(null, container);
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

async function show(update: () => Promise<Result<unknown, AppError>>) {
  const updates = vi.fn(update);
  // 저장된 설정을 바로 준다. 저장이 성공해도 바뀜 알림은 시험이 직접 보낸다.
  let handlers: SettingsReaderHandlers | undefined;
  const subscribe = (next: SettingsReaderHandlers) => {
    handlers = next;
    next.apply(off);
    return () => undefined;
  };
  await act(() => {
    render(<PopupApp features={[feature]} subscribe={subscribe} update={updates} />, container);
  });
  const toggle = () => {
    const element = container.querySelector<HTMLInputElement>('[role=switch]');
    if (element === null) throw new Error('스위치가 없다.');
    return element;
  };
  return {
    toggle,
    updates,
    state: () => container.querySelector('.state')?.textContent,
    status: () => container.querySelector('[role=status]')?.textContent,
    apply: (snapshot: Snapshot) => act(() => handlers?.apply(snapshot)),
  };
}

describe('COM-3 기대 동작 3 저장에 실패하면 화면은 저장된 값을 보인다', () => {
  it('COM-3.3 같은 저장 실패가 두 번 이어져도 그때마다 스위치를 저장된 값으로 되돌린다', async () => {
    const popup = await show(() => Promise.resolve(err(saveFailed)));
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
    const popup = await show(() => Promise.resolve(err(saveFailed)));
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
