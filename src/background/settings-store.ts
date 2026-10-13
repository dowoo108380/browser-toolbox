import type { FeatureDefinition } from '../contracts/index.ts';
import type { LocalStore } from '../platform/index.ts';
import {
  type AppError,
  type Result,
  appError,
  createSerialQueue,
  err,
  ok,
} from '../shared/index.ts';
import {
  type Repair,
  type SettingsFormat,
  type StoredSettings,
  checkFinal,
  checkSize,
  nextRevision,
  normalize,
  settingsKey,
} from '../storage/index.ts';
import type { Problem } from './problems.ts';

// 설정을 쓰는 곳은 이것 하나다(결정 0005, 0011). 쓰기는 들어온 순서대로 하나씩 하고, 쓰기 하나는
// 읽기 → 버전으로 나누어 지금 형식의 값 얻기 → 바꾸기 → 새 revision → 최종 값 전체 검증 → 크기 확인 → set 한 번이다.

export interface SettingsStore {
  // 고칠 것(없음, 손상, 옛 형식, 손상 항목)이 있으면 바꾸기 없이 고쳐 쓴다. 더 새 형식이면 쓰지 않는다.
  readonly ensureReady: () => Promise<Result<null, AppError>>;
  readonly updateFeature: (
    featureId: string,
    patch: Readonly<Record<string, unknown>>,
  ) => Promise<Result<{ revision: number }, AppError>>;
}

export function createSettingsStore(deps: {
  readonly store: LocalStore;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly format: SettingsFormat;
  readonly features: readonly FeatureDefinition[];
  readonly record: (problem: Problem) => void;
}): SettingsStore {
  const enqueue = createSerialQueue();

  const recordRepairs = (repairs: readonly Repair[]) => {
    for (const repair of repairs) {
      if (repair.kind === 'corrupt') deps.record({ featureId: null, kind: 'unexpected' });
      if (repair.kind === 'corruptItems') {
        for (const featureId of repair.items) deps.record({ featureId, kind: 'unexpected' });
      }
    }
  };

  // 설정을 읽고, 읽기를 마친 시각을 함께 돌려준다.
  const read = async (): Promise<Result<{ raw: unknown; readAt: number }, AppError>> => {
    try {
      const raw = await deps.store.get(settingsKey);
      return ok({ raw, readAt: deps.now() });
    } catch {
      return err(appError('platform', '설정을 읽지 못했다.'));
    }
  };

  // revision을 정할 시각. 설정을 읽은 시각과 같은 밀리초이면 다음 밀리초까지 기다린다. 그래서 revision은
  // 그것을 정한 시각을 넘지 않고(같은 밀리초에 연달아 써도 시각보다 앞서지 않는다), 바꾸기 전 값을 모르는
  // 쓰기(처음 쓰기, 전체 손상 복구)도 앞에 쓴 어떤 값보다 크다(결정 0011 "세대 번호").
  // 시계가 뒤로 갔으면 기다리지 않는다. 그때는 nextRevision이 바꾸기 전 + 1을 쓴다.
  const timeAfter = async (readAt: number): Promise<number> => {
    let now = deps.now();
    while (now === readAt) {
      await deps.sleep(1);
      now = deps.now();
    }
    return now;
  };

  // 최종 값 전체를 검사한 뒤 쓴다. 저장 실패는 예상할 수 있는 실패다. 저장된 설정은 바꾸기 전 그대로다(COM-3.3).
  const write = async (
    value: StoredSettings,
    previous: StoredSettings | null,
  ): Promise<Result<null, AppError>> => {
    // 서비스 워커가 만든 값이 틀렸다. 일어나면 안 되는 일이다(quality 066). unexpected로 돌려주고,
    // 기록은 결과를 받는 쪽(서비스 워커 시작, 라우터)이 한다.
    const final = checkFinal(value, deps.format, deps.features);
    if (!final.ok) return final;
    // 형식 이전과 고쳐 쓰기는 크기 한도와 상관없이 한다(결정 0011 "크기 한도").
    if (previous !== null) {
      const size = checkSize(value, previous);
      if (!size.ok) return size;
    }
    try {
      await deps.store.set({ [settingsKey]: value });
      return ok(null);
    } catch {
      return err(appError('platform', '설정을 저장하지 못했다. 저장된 설정은 바뀌지 않았다.'));
    }
  };

  return {
    ensureReady: () =>
      enqueue(async () => {
        const loaded = await read();
        if (!loaded.ok) return loaded;
        const normalized = normalize(loaded.value.raw, deps.format, deps.features);
        if (!normalized.ok || normalized.value.repairs.length === 0) return ok(null);
        const { value, repairs } = normalized.value;
        const now = await timeAfter(loaded.value.readAt);
        const written = await write(
          { ...value, revision: nextRevision(value.revision, now) },
          null,
        );
        // 고쳐 쓴 뒤에만 기록한다. 쓰지 못했으면 다음에 다시 고치고 그때 기록한다.
        if (written.ok) recordRepairs(repairs);
        return written;
      }),

    updateFeature: (featureId, patch) =>
      enqueue(async () => {
        const feature = deps.features.find((candidate) => candidate.id === featureId);
        if (feature === undefined) {
          return err(appError('invalid-input', '모르는 기능의 설정이다.'));
        }
        const loaded = await read();
        if (!loaded.ok) return loaded;
        const normalized = normalize(loaded.value.raw, deps.format, deps.features);
        if (!normalized.ok) return normalized;
        const base = normalized.value.value;
        // 손상 항목은 normalize가 지웠으므로 남은 항목은 검증을 통과한 것이다. 없으면 기본값에서 시작한다.
        const stored = base.features[featureId];
        const current = typeof stored === 'object' && stored !== null ? stored : {};
        const merged = feature.settings.schema.safeParse({
          ...feature.settings.defaults,
          ...current,
          ...patch,
        });
        if (!merged.success) {
          return err(appError('invalid-input', '설정 값이 맞지 않아 저장하지 않았다.'));
        }
        const now = await timeAfter(loaded.value.readAt);
        const next: StoredSettings = {
          ...base,
          revision: nextRevision(base.revision, now),
          features: { ...base.features, [featureId]: merged.data },
        };
        const written = await write(next, base);
        if (!written.ok) return written;
        recordRepairs(normalized.value.repairs);
        return ok({ revision: next.revision });
      }),
  };
}
