import { describe, expect, it } from 'vitest';
import { oldStored, specs, stored, twoVersionFormat } from '../../tests/support/settings.ts';
import { v } from '../contracts/index.ts';
import { createFakeStore } from '../platform/fake.ts';
import type { KeyValueStore, Requester } from '../platform/index.ts';
import { type AppError, type Result, appError, err, ok } from '../shared/index.ts';
import { type SettingsFormat, settingsFormat, settingsKey } from './format.ts';
import type { Snapshot } from './reader.ts';
import type { RepairScope } from './repair-notice.ts';
import { startSettingsReader } from './subscribe.ts';

const t = 1_790_000_000_000;

function setup<Store extends Pick<KeyValueStore, 'get' | 'onChanged'>>(
  store: Store,
  onEnsureReady: () => Promise<Result<unknown, AppError>>,
  format: SettingsFormat = settingsFormat,
) {
  const applied: Snapshot[] = [];
  const problems: AppError[] = [];
  const corrupted: RepairScope[] = [];
  const newer: number[] = [];
  let ensureCount = 0;
  // 진짜처럼 응답을 그 요청의 정의로 검증해 돌려준다.
  const request: Requester = async (definition) => {
    ensureCount += 1;
    const result = await onEnsureReady();
    if (!result.ok) return result;
    const parsed = v.safeParse(definition.value, result.value);
    return parsed.success ? ok(parsed.output) : err(appError('unexpected', '응답 형식'));
  };
  const stop = startSettingsReader(
    { store, request, format, specs },
    {
      apply: (snapshot) => applied.push(snapshot),
      corrupt: (scope) => corrupted.push(scope),
      newer: (version) => newer.push(version),
      problem: (error) => problems.push(error),
    },
  );
  return { store, applied, problems, corrupted, newer, stop, ensureCount: () => ensureCount };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// 서비스 워커가 준비했다고 답하지만 아무것도 바꾸지 않는다. 응답은 다음 작업으로 미뤄,
// 횟수 제한이 듣지 않으면 settle마다 요청이 늘어나게 한다.
const answerLater = (): Promise<Result<unknown, AppError>> =>
  new Promise((resolve) =>
    setTimeout(() => {
      resolve(ok(null));
    }, 0),
  );

describe('읽기 도우미', () => {
  it('설정이 없으면 서비스 워커에 준비를 부탁하고, 쓴 값을 다시 읽어 시작한다', async () => {
    const store = createFakeStore();
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
    const harness = setup(createFakeStore(), () =>
      Promise.resolve(err(appError('timeout', '응답 없음'))),
    );
    await settle();
    expect(harness.applied).toEqual([]);
    expect(harness.problems.map((problem) => problem.kind)).toEqual(['timeout']);
  });

  it('준비했다고 해도 계속 읽을 수 없으면 정한 횟수만 다시 부탁한다(quality 069)', async () => {
    const harness = setup(createFakeStore(), () => Promise.resolve(ok(null)));
    await settle();
    await settle();
    expect(harness.ensureCount()).toBe(3);
    expect(harness.problems.map((problem) => problem.kind)).toEqual(['unexpected']);
  });

  it('정상 값을 받은 뒤 옛 형식 값이 계속 와도 정한 횟수만 다시 부탁한다(quality 069)', async () => {
    const store = createFakeStore({
      [settingsKey]: { version: 2, revision: t, features: {}, sites: {} },
    });
    // 저장소에는 옛 형식 값이 그대로 남는다.
    const harness = setup(store, answerLater, twoVersionFormat);
    await settle();
    expect(harness.applied).toHaveLength(1);
    store.replace(settingsKey, oldStored(5));
    for (let round = 0; round < 10; round += 1) await settle();
    expect(harness.ensureCount()).toBe(3);
    expect(harness.problems.map((problem) => problem.kind)).toEqual(['unexpected']);
    // 기능은 받아들인 정상 값으로 계속 돈다.
    expect(harness.applied).toHaveLength(1);
  });

  it('다시 부탁하는 동안 받아들인 값을 잃게 하는 손상 값이 와도 횟수를 이어 센다(quality 069)', async () => {
    const store = createFakeStore({
      [settingsKey]: { version: 2, revision: t, features: {}, sites: {} },
    });
    // 옛 형식 값 뒤에 부탁하면, 서비스 워커는 답하지만 저장소에는 손상 값이 남는다.
    const harness = setup(
      store,
      async () => {
        const answer = await answerLater();
        store.replace(settingsKey, { version: 'x' });
        return answer;
      },
      twoVersionFormat,
    );
    await settle();
    store.replace(settingsKey, oldStored(5));
    for (let round = 0; round < 10; round += 1) await settle();
    expect(harness.ensureCount()).toBe(3);
    expect(harness.problems.map((problem) => problem.kind)).toEqual(['unexpected']);
  });

  it('준비 요청이 진행 중이면 그사이 온 값이 다시 부탁하게 해도 하나만 보낸다', async () => {
    const store = createFakeStore();
    let answer: () => void = () => undefined;
    const harness = setup(
      store,
      () =>
        new Promise((resolve) => {
          answer = () => {
            resolve(ok(null));
          };
        }),
    );
    await settle();
    expect(harness.ensureCount()).toBe(1);
    // 응답을 기다리는 동안 다시 부탁해야 하는 값(손상, 없음)이 온다.
    store.replace(settingsKey, { version: 'x' });
    store.replace(settingsKey, undefined);
    await settle();
    expect(harness.ensureCount()).toBe(1);
    // 서비스 워커가 기본 설정을 쓰고 답하면 다시 읽어 시작한다.
    store.replace(settingsKey, stored(t));
    answer();
    await settle();
    expect(harness.ensureCount()).toBe(1);
    expect(harness.problems).toEqual([]);
  });

  it('COM-3.4 손상을 화면에 알린다: 설정 전체와 손상 항목', async () => {
    const store = createFakeStore({ [settingsKey]: { version: 'x' } });
    const harness = setup(store, () => {
      store.replace(settingsKey, stored(t, { sample: { enabled: 'no' } }));
      return Promise.resolve(ok(null));
    });
    await settle();
    expect(harness.corrupted).toEqual([
      { whole: true, features: [], sites: [] },
      { whole: false, features: ['sample'], sites: [] },
    ]);
  });

  it('COM-3.8 더 새 형식이면 그 버전을 화면에 알린다', async () => {
    const harness = setup(createFakeStore({ [settingsKey]: { version: 9 } }), answerLater);
    await settle();
    expect(harness.newer).toEqual([9]);
    expect(harness.applied).toEqual([]);
  });

  it('설정을 읽지 못하면 알린다', async () => {
    const store = createFakeStore();
    const harness = setup(
      { ...store, get: () => Promise.reject(new Error('읽기 실패')) },
      answerLater,
    );
    await settle();
    expect(harness.problems.map((problem) => problem.kind)).toEqual(['platform']);
  });

  it('다시 부탁해 새 값을 받아들이면 횟수를 처음부터 센다', async () => {
    const store = createFakeStore({ [settingsKey]: oldStored(5) });
    let answers = 0;
    // 처음 두 번은 옛 형식 그대로 두고, 세 번째에 이전을 마친다. 그 뒤 다시 옛 형식 값이 온다.
    const harness = setup(
      store,
      async () => {
        const answer = await answerLater();
        answers += 1;
        if (answers === 3) {
          store.replace(settingsKey, { version: 2, revision: t, features: {}, sites: {} });
        }
        return answer;
      },
      twoVersionFormat,
    );
    for (let round = 0; round < 10; round += 1) await settle();
    expect(harness.ensureCount()).toBe(3);
    expect(harness.applied).toHaveLength(1);
    expect(harness.problems).toEqual([]);
    store.replace(settingsKey, oldStored(6));
    for (let round = 0; round < 10; round += 1) await settle();
    expect(harness.ensureCount()).toBe(6);
    expect(harness.problems.map((problem) => problem.kind)).toEqual(['unexpected']);
  });

  it('그만두면 바뀜 듣기를 그만둔다', async () => {
    const store = createFakeStore({ [settingsKey]: stored(t) });
    let listening = 0;
    const harness = setup(
      {
        get: (key) => store.get(key),
        onChanged: (key, listener) => {
          listening += 1;
          const unsubscribe = store.onChanged(key, listener);
          return () => {
            listening -= 1;
            unsubscribe();
          };
        },
      },
      answerLater,
    );
    await settle();
    expect(listening).toBe(1);
    harness.stop();
    expect(listening).toBe(0);
  });

  it('그만둔 직후에 이미 보낸 바뀜 알림이 와도 적용하지 않는다', async () => {
    // 듣기를 그만두기 전에 보낸 알림이 그만둔 뒤에 닿는 경우: 듣기를 그만둬도 알림이 계속 오는 저장소로 흉내 낸다.
    const store = createFakeStore({ [settingsKey]: stored(t) });
    const harness = setup(
      {
        get: (key) => store.get(key),
        onChanged: (key, listener) => {
          store.onChanged(key, listener);
          return () => undefined;
        },
      },
      answerLater,
    );
    await settle();
    harness.stop();
    store.replace(settingsKey, stored(t + 1, { other: { enabled: true } }));
    store.replace(settingsKey, { version: 'x' });
    await settle();
    expect(harness.applied).toHaveLength(1);
    expect(harness.corrupted).toEqual([]);
    expect(harness.ensureCount()).toBe(0);
  });
});

describe('COM-7 그만둔 뒤에는 읽지도 알리지도 않는다', () => {
  // 준비 요청의 응답과 저장소 읽기를 시험이 정한 때에 끝낸다.
  function controlled() {
    const store = createFakeStore();
    let reads = 0;
    let failRead: ((error: Error) => void) | null = null;
    let answer: (result: Result<unknown, AppError>) => void = () => undefined;
    const applied: Snapshot[] = [];
    const problems: AppError[] = [];
    const request: Requester = (definition) =>
      new Promise((resolve) => {
        answer = (result) => {
          if (!result.ok) {
            resolve(result);
            return;
          }
          const parsed = v.safeParse(definition.value, result.value);
          resolve(parsed.success ? ok(parsed.output) : err(appError('unexpected', '응답 형식')));
        };
      });
    const stop = startSettingsReader(
      {
        store: {
          ...store,
          get: (key) => {
            reads += 1;
            // 두 번째 읽기부터는 시험이 실패시킬 때까지 끝나지 않는다.
            if (reads === 1) return store.get(key);
            return new Promise((_resolve, reject) => {
              failRead = reject;
            });
          },
        },
        request,
        format: settingsFormat,
        specs,
      },
      {
        apply: (snapshot) => applied.push(snapshot),
        corrupt: () => undefined,
        newer: () => undefined,
        problem: (error) => problems.push(error),
      },
    );
    return {
      stop,
      store,
      applied,
      problems,
      reads: () => reads,
      answer: (result: Result<unknown, AppError>) => {
        answer(result);
      },
      failRead: () => failRead?.(new Error('읽기 실패')),
    };
  }

  it('준비 요청 중에 그만두면, 성공 응답이 늦게 와도 다시 읽지 않는다', async () => {
    const reader = controlled();
    await settle();
    expect(reader.reads()).toBe(1);
    reader.stop();
    reader.store.replace(settingsKey, stored(t));
    reader.answer(ok(null));
    await settle();
    expect(reader.reads()).toBe(1);
    expect(reader.applied).toEqual([]);
    expect(reader.problems).toEqual([]);
  });

  it('준비 요청 중에 그만두면, 실패 응답이 늦게 와도 알리지 않는다', async () => {
    const reader = controlled();
    await settle();
    reader.stop();
    reader.answer(err(appError('timeout', '응답 없음')));
    await settle();
    expect(reader.problems).toEqual([]);
  });

  it('다시 읽는 중에 그만두면, 읽기가 늦게 실패해도 알리지 않는다', async () => {
    const reader = controlled();
    await settle();
    reader.answer(ok(null));
    await settle();
    expect(reader.reads()).toBe(2);
    reader.stop();
    reader.failRead();
    await settle();
    expect(reader.problems).toEqual([]);
  });
});
