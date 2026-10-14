import type { FeatureDefinition, ToggleSettings } from '../contracts/index.ts';
import { type SettingsFormat, classify } from './format.ts';
import { type FeatureSettingsSpec, checkItems } from './items.ts';
import { type RepairScope, wholeRepair } from './repair-notice.ts';

// 읽는 쪽의 공통 계약(결정 0011)을 순수 함수로 둔다. 받은 값(읽기 결과나 바뀜 알림의 새 값)마다
// (지금 상태, 받은 값) → (새 상태, 할 일)을 계산한다. 받는 순서에 기대지 않는다.

// 기능이 쓰는 설정 전체의 한 시점.
export interface Snapshot {
  // 검증을 통과한 기능 설정. 없는 기능은 기본값을 쓴다.
  readonly features: ReadonlyMap<string, unknown>;
  // 검증을 통과한 사이트 항목: 사이트(호스트) → 기능 id → 값. 없는 항목은 기본값이다(결정 0017).
  readonly sites: ReadonlyMap<string, ReadonlyMap<string, unknown>>;
}

export interface ReaderState {
  // 받아들인 값의 revision. null이면 받아들인 값이 없거나 잊었다.
  readonly accepted: number | null;
  // 기능이 쓰는 설정. null이면 아직 없다(기능 시작 전).
  readonly snapshot: Snapshot | null;
  // 더 새 형식을 보았으면 그 버전. 그 뒤로는 아무것도 받아들이지 않는다.
  readonly newer: number | null;
}

export const initialReaderState: ReaderState = { accepted: null, snapshot: null, newer: null };

export type ReaderEffect =
  | { readonly kind: 'apply'; readonly snapshot: Snapshot }
  | { readonly kind: 'ensureReady' }
  // 기본값으로 대신 쓰는 범위(설정 전체이거나 손상 항목).
  | { readonly kind: 'corrupt'; readonly scope: RepairScope }
  | { readonly kind: 'newer'; readonly version: number };

export interface ReaderStep {
  readonly state: ReaderState;
  readonly effects: readonly ReaderEffect[];
}

const defaultsSnapshot: Snapshot = { features: new Map(), sites: new Map() };

export function receive(
  state: ReaderState,
  raw: unknown,
  format: SettingsFormat,
  specs: readonly FeatureSettingsSpec[],
): ReaderStep {
  if (state.newer !== null) return { state, effects: [] };
  const classified = classify(raw, format);
  switch (classified.kind) {
    // 순서를 매길 수 없는 값이다. 받아들인 revision을 잊는다. 늦게 온 값이었으면 다시 읽은 값이
    // 같은 revision이라도 받아들여야 하고, 시계가 뒤로 간 뒤의 복구 값도 받아들여야 한다.
    case 'missing':
      return { state: { ...state, accepted: null }, effects: [{ kind: 'ensureReady' }] };
    case 'corrupt':
      return {
        state: { accepted: null, snapshot: defaultsSnapshot, newer: null },
        effects: [
          { kind: 'apply', snapshot: defaultsSnapshot },
          { kind: 'corrupt', scope: wholeRepair },
          { kind: 'ensureReady' },
        ],
      };
    case 'newer':
      return {
        state: { accepted: null, snapshot: null, newer: classified.version },
        effects: [{ kind: 'newer', version: classified.version }],
      };
    // 옛 형식은 손상이 아니다. 지금 상태를 바꾸지 않고 서비스 워커의 이전을 기다린다.
    case 'older':
      return { state, effects: [{ kind: 'ensureReady' }] };
    case 'current': {
      const { revision } = classified.value;
      if (state.accepted !== null && revision <= state.accepted) return { state, effects: [] };
      const { features, sites, corruptFeatures, corruptSites } = checkItems(
        classified.value,
        specs,
      );
      const snapshot: Snapshot = { features, sites };
      const effects: ReaderEffect[] = [{ kind: 'apply', snapshot }];
      // 손상 항목이 있으면 서비스 워커에 고쳐 쓰기를 부탁한다. 서비스 워커는 고쳐 쓰기 전에 복구 알림을 남기므로,
      // 화면이 알림에 쓴 "기본값으로 바꿨다"가 저장소에서도 곧 참이 된다(결정 0016).
      if (corruptFeatures.length > 0 || corruptSites.length > 0) {
        effects.push(
          {
            kind: 'corrupt',
            scope: { whole: false, features: corruptFeatures, sites: corruptSites },
          },
          { kind: 'ensureReady' },
        );
      }
      return { state: { accepted: revision, snapshot, newer: null }, effects };
    }
  }
}

// 한 기능의 설정. 없으면 기본값이다(결정 0011).
export function settingsOf<S extends ToggleSettings>(
  snapshot: Snapshot,
  definition: FeatureDefinition<S>,
): S {
  const value = snapshot.features.get(definition.id);
  if (value === undefined) return definition.settings.defaults;
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- receive가 이 정의의 스키마로 검증한 값만 이 맵에 넣는다(checkFeatureItems).
  return value as S;
}
