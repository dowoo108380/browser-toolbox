import { describe, expect, it } from 'vitest';
import {
  popupRemember,
  problemReport,
  repairNoticeDismiss,
  settingsUpdate,
  storageEnsureReady,
} from '../contracts/index.ts';
import type { Sender } from '../platform/index.ts';
import { appError, err, ok } from '../shared/index.ts';
import { createRouter, route } from './router.ts';

const extension: Sender = { kind: 'extension' };
const content: Sender = { kind: 'content', tabId: 1, frameId: 0 };

function setup(onUpdate: () => Promise<unknown> = () => Promise.resolve()) {
  const unexpected: unknown[] = [];
  const router = createRouter(
    [
      route(settingsUpdate, async () => {
        await onUpdate();
        return ok({ revision: 1 });
      }),
      route(storageEnsureReady, () => Promise.resolve(ok(null))),
      route(repairNoticeDismiss, () => Promise.resolve(ok(null))),
      route(problemReport, () => Promise.resolve(ok(null))),
      route(popupRemember, () => Promise.resolve(ok(null))),
    ],
    (error) => unexpected.push(error),
  );
  return { router, unexpected };
}

const update = { type: 'settings.update', payload: { featureId: 'a', patch: { enabled: true } } };

describe('요청 검증(결정 0006)', () => {
  it('확장 화면의 올바른 요청을 처리한다', async () => {
    const { router } = setup();
    expect(await router(update, extension)).toEqual({ ok: true, value: { revision: 1 } });
  });

  it('콘텐츠 스크립트는 설정을 바꾸거나 설정 복구 알림을 지울 수 없다', async () => {
    const { router } = setup();
    const dismiss = { type: 'repairNotice.dismiss', payload: { stamp: 1 } };
    for (const message of [update, dismiss]) {
      const result = await router(message, content);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('permission');
    }
    expect(await router(dismiss, extension)).toEqual(ok(null));
  });

  it('결정 0023 팝업의 범주는 확장 화면만 남길 수 있고, 모르는 범주는 받지 않는다', async () => {
    const { router } = setup();
    const remember = { type: 'popup.remember', payload: { category: 'page' } };
    expect(await router(remember, extension)).toEqual(ok(null));
    const fromContent = await router(remember, content);
    expect(fromContent.ok).toBe(false);
    if (!fromContent.ok) expect(fromContent.error.kind).toBe('permission');
    const unknown = await router(
      { type: 'popup.remember', payload: { category: 'settings' } },
      extension,
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.kind).toBe('invalid-input');
  });

  it('콘텐츠 스크립트도 준비 요청과 문제 기록은 보낼 수 있다', async () => {
    const { router } = setup();
    expect(await router({ type: 'storage.ensureReady', payload: {} }, content)).toEqual(ok(null));
    expect(
      await router(
        { type: 'problem.report', payload: { featureId: null, kind: 'timeout' } },
        content,
      ),
    ).toEqual(ok(null));
  });

  it.each([
    ['형식이 틀림', 'hello'],
    ['모르는 요청', { type: 'tab.close', payload: {} }],
    ['내용이 틀림', { type: 'settings.update', payload: { featureId: 3 } }],
  ])('잘못된 요청은 처리하지 않는다: %s', async (_name, message) => {
    const { router } = setup();
    const result = await router(message, extension);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid-input');
  });

  it('처리기의 예상하지 못한 예외는 그 요청만 실패시키고 기록한다', async () => {
    const { router, unexpected } = setup(() => Promise.reject(new Error('boom')));
    const result = await router(update, extension);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('unexpected');
    expect(unexpected).toHaveLength(1);
  });

  it('처리기가 빠진 요청이 있으면 시작할 때 드러낸다', () => {
    expect(() => createRouter([], () => undefined)).toThrow();
  });
});

describe('일어나면 안 되는 일의 기록(quality 066)', () => {
  it('처리기가 돌려준 unexpected 결과도 기록한다. 다른 실패는 기록하지 않는다', async () => {
    const unexpected: unknown[] = [];
    const router = createRouter(
      [
        route(settingsUpdate, () =>
          Promise.resolve(err(appError('unexpected', '저장할 설정이 형식에 맞지 않는다.'))),
        ),
        route(storageEnsureReady, () =>
          Promise.resolve(err(appError('platform', '설정을 읽지 못했다.'))),
        ),
        route(repairNoticeDismiss, () => Promise.resolve(ok(null))),
        route(problemReport, () => Promise.resolve(ok(null))),
        route(popupRemember, () => Promise.resolve(ok(null))),
      ],
      (error) => unexpected.push(error),
    );
    expect((await router(update, extension)).ok).toBe(false);
    expect(unexpected).toHaveLength(1);
    expect((await router({ type: 'storage.ensureReady', payload: {} }, content)).ok).toBe(false);
    expect(unexpected).toHaveLength(1);
  });
});
