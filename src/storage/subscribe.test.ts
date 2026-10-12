import { describe, expect, it } from 'vitest';
import { specs, stored } from '../../tests/support/settings.ts';
import { type FakeLocalStore, createFakeLocalStore } from '../platform/fake.ts';
import type { Requester } from '../platform/index.ts';
import { type AppError, type Result, appError, err, ok } from '../shared/index.ts';
import { settingsFormat, settingsKey } from './format.ts';
import type { Snapshot } from './reader.ts';
import { startSettingsReader } from './subscribe.ts';

const t = 1_790_000_000_000;

function setup(store: FakeLocalStore, onEnsureReady: () => Promise<Result<unknown, AppError>>) {
  const applied: Snapshot[] = [];
  const problems: AppError[] = [];
  let ensureCount = 0;
  // 진짜처럼 응답을 그 요청의 정의로 검증해 돌려준다.
  const request: Requester = async (definition) => {
    ensureCount += 1;
    const result = await onEnsureReady();
    if (!result.ok) return result;
    const parsed = definition.value.safeParse(result.value);
    return parsed.success ? ok(parsed.data) : err(appError('unexpected', '응답 형식'));
  };
  const stop = startSettingsReader(
    { store, request, format: settingsFormat, specs },
    {
      apply: (snapshot) => applied.push(snapshot),
      corrupt: () => undefined,
      newer: () => undefined,
      problem: (error) => problems.push(error),
    },
  );
  return { store, applied, problems, stop, ensureCount: () => ensureCount };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('읽기 도우미', () => {
  it('설정이 없으면 서비스 워커에 준비를 부탁하고, 쓴 값을 다시 읽어 시작한다', async () => {
    const store = createFakeLocalStore();
    const harness = setup(store, () => {
      // 서비스 워커가 기본 설정을 쓴 것처럼 한다.
      store.replace(settingsKey, stored(t));
      return Promise.resolve(ok(null));
    });
    await settle();
    expect(harness.ensureCount()).toBe(1);
    expect(harness.applied.length).toBeGreaterThanOrEqual(1);
    expect(harness.problems).toEqual([]);
  });

  it('준비 요청이 시간을 넘기면 기능을 시작하지 않고 문제를 알린다', async () => {
    const harness = setup(createFakeLocalStore(), () =>
      Promise.resolve(err(appError('timeout', '응답 없음'))),
    );
    await settle();
    expect(harness.applied).toEqual([]);
    expect(harness.problems.map((problem) => problem.kind)).toEqual(['timeout']);
  });

  it('준비했다고 해도 계속 읽을 수 없으면 정한 횟수만 다시 부탁한다(quality 069)', async () => {
    const harness = setup(createFakeLocalStore(), () => Promise.resolve(ok(null)));
    await settle();
    await settle();
    expect(harness.ensureCount()).toBe(3);
    expect(harness.problems.map((problem) => problem.kind)).toEqual(['unexpected']);
  });

  it('그만두면 바뀜 알림을 더 받지 않는다', async () => {
    const harness = setup(createFakeLocalStore({ [settingsKey]: stored(t) }), () =>
      Promise.resolve(ok(null)),
    );
    await settle();
    harness.stop();
    harness.store.replace(settingsKey, stored(t + 1, { other: { enabled: true } }));
    expect(harness.applied).toHaveLength(1);
  });
});
