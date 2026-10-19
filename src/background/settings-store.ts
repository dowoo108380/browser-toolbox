import { type ToggleFeature, v } from '../contracts/index.ts';
import type { KeyValueStore } from '../platform/index.ts';
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
  type RepairScope,
  type SettingsFormat,
  type StoredSettings,
  checkFinal,
  checkSize,
  isEmptyRepair,
  nextRevision,
  normalize,
  repairScopeOf,
  settingsKey,
} from '../storage/index.ts';
import type { Problem } from './problems.ts';

// 설정을 쓰는 곳은 이것 하나다(결정 0005, 0011). 쓰기는 들어온 순서대로 하나씩 하고, 쓰기 하나는
// 읽기 → 버전으로 나누어 지금 형식의 값 얻기 → 바꾸기 → (손상을 고치면 복구 알림, 결정 0016) → 새 revision
// → 최종 값 전체 검증 → 크기 확인 → set 한 번이다.

export interface SettingsStore {
  // 고칠 것(없음, 손상, 옛 형식, 손상 항목)이 있으면 바꾸기 없이 고쳐 쓴다. 더 새 형식이면 쓰지 않는다.
  readonly ensureReady: () => Promise<Result<null, AppError>>;
  readonly updateFeature: (
    featureId: string,
    patch: Readonly<Record<string, unknown>>,
  ) => Promise<Result<{ revision: number }, AppError>>;
}

export function createSettingsStore(deps: {
  readonly store: KeyValueStore;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly format: SettingsFormat;
  // 설정을 저장하는 기능만 받는다(featuresWithSettings).
  readonly features: readonly ToggleFeature[];
  readonly record: (problem: Problem) => void;
  // 손상을 기본값으로 고쳐 쓰기 전에 사용자에게 보일 복구 알림을 남긴다(결정 0016).
  readonly noticeRepair: (scope: RepairScope) => Promise<Result<null, AppError>>;
}): SettingsStore {
  const enqueue = createSerialQueue();

  // 고쳐 쓰기 전에 알림을 먼저 남긴다. 고쳐 쓴 직후 서비스 워커가 멈춰도 사용자가 모르고 지나가지 않게 하려는 것이다.
  // 알림을 남기지 못하면 고쳐 쓰지 않는다. 조용히 바꾸지 않는다(COM-3 기대 동작 4).
  // 알림만 남고 고쳐 쓰기가 실패해도 화면은 그 항목을 이미 기본값으로 쓰므로 알림 내용과 맞다.
  const noticeFirst = async (repairs: readonly Repair[]): Promise<Result<null, AppError>> => {
    const scope = repairScopeOf(repairs);
    if (isEmptyRepair(scope)) return ok(null);
    const noticed = await deps.noticeRepair(scope);
    if (noticed.ok) return noticed;
    return err(appError('platform', '손상된 설정을 고치지 못했다. 저장된 설정은 바뀌지 않았다.'));
  };

  // 문제 기록에는 사이트 이름을 넣지 않는다(COM-5 기대 동작 3). 사이트 항목은 그 기능(사이트 전체면 null)으로만 남긴다.
  const recordRepairs = (repairs: readonly Repair[]) => {
    for (const repair of repairs) {
      if (repair.kind === 'corrupt') deps.record({ featureId: null, kind: 'unexpected' });
      if (repair.kind === 'corruptItems') {
        for (const featureId of repair.features) deps.record({ featureId, kind: 'unexpected' });
        for (const { featureId } of repair.sites) deps.record({ featureId, kind: 'unexpected' });
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
  // 사용자가 하는 저장이면 크기를 지금 값(읽은 그대로의 값, 그것을 고쳐 쓰기·형식 이전만 한 값)과 비교한다.
  const write = async (
    value: StoredSettings,
    current: { readonly stored: unknown; readonly normalized: StoredSettings } | null,
  ): Promise<Result<null, AppError>> => {
    // 서비스 워커가 만든 값이 틀렸다. 일어나면 안 되는 일이다(quality 066). unexpected로 돌려주고,
    // 기록은 결과를 받는 쪽(서비스 워커 시작, 라우터)이 한다.
    const final = checkFinal(value, deps.format, deps.features);
    if (!final.ok) return final;
    // 형식 이전과 고쳐 쓰기만 하는 쓰기(current가 null)는 크기 한도와 상관없이 한다(결정 0011 "크기 한도").
    if (current !== null) {
      const size = checkSize(value, current.stored, current.normalized);
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
        const noticed = await noticeFirst(repairs);
        if (!noticed.ok) return noticed;
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
        const merged = v.safeParse(feature.settings.schema, {
          ...feature.settings.defaults,
          ...current,
          ...patch,
        });
        if (!merged.success) {
          return err(appError('invalid-input', '설정 값이 맞지 않아 저장하지 않았다.'));
        }
        const noticed = await noticeFirst(normalized.value.repairs);
        if (!noticed.ok) return noticed;
        const now = await timeAfter(loaded.value.readAt);
        // 저장하는 항목은 저장된 항목 위에 검증을 거친 값을 덮은 것이다. 이 판이 아는 필드는 검증을 거친 값이 되고, 모르는
        // 필드(같은 형식에서 더 새 판이 더한 것)는 저장된 값 그대로 남는다. 검증을 거친 값만 저장하면 스키마가 모르는 필드를
        // 지워, 새 판으로 다시 올렸을 때 사용자 값을 잃는다. 요청에 든 모르는 필드는 스키마가 걸러 저장하지 않는다(결정 0022).
        const next: StoredSettings = {
          ...base,
          revision: nextRevision(base.revision, now),
          features: { ...base.features, [featureId]: { ...current, ...merged.output } },
        };
        const written = await write(next, { stored: loaded.value.raw, normalized: base });
        if (!written.ok) return written;
        // 쓴 뒤에는 실패를 돌려주지 않는다. 실패로 답하면 저장하지 않은 것이라는 settings.update의 계약이다(결정 0036).
        recordRepairs(normalized.value.repairs);
        return ok({ revision: next.revision });
      }),
  };
}
