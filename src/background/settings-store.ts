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

  const read = async (): Promise<Result<unknown, AppError>> => {
    try {
      return ok(await deps.store.get(settingsKey));
    } catch {
      return err(appError('platform', '설정을 읽지 못했다.'));
    }
  };

  // 최종 값 전체를 검사한 뒤 쓴다. 저장 실패는 예상할 수 있는 실패다. 저장된 설정은 바꾸기 전 그대로다(COM-3.3).
  const write = async (
    value: StoredSettings,
    previous: StoredSettings | null,
  ): Promise<Result<null, AppError>> => {
    const final = checkFinal(value, deps.format, deps.features);
    if (!final.ok) {
      // 서비스 워커가 만든 값이 틀렸다. 일어나면 안 되는 일이므로 기록한다(quality 066).
      deps.record({ featureId: null, kind: 'unexpected' });
      return final;
    }
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
        const raw = await read();
        if (!raw.ok) return raw;
        const normalized = normalize(raw.value, deps.format, deps.features);
        if (!normalized.ok || normalized.value.repairs.length === 0) return ok(null);
        const { value, repairs } = normalized.value;
        const written = await write(
          { ...value, revision: nextRevision(value.revision, deps.now()) },
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
        const raw = await read();
        if (!raw.ok) return raw;
        const normalized = normalize(raw.value, deps.format, deps.features);
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
        const next: StoredSettings = {
          ...base,
          revision: nextRevision(base.revision, deps.now()),
          features: { ...base.features, [featureId]: merged.data },
        };
        const written = await write(next, base);
        if (!written.ok) return written;
        recordRepairs(normalized.value.repairs);
        return ok({ revision: next.revision });
      }),
  };
}
