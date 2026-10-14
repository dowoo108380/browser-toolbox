import { type AppError, type Result, appError, err, ok } from '../shared/index.ts';
import {
  type SettingsFormat,
  type StoredSettings,
  classify,
  emptySettings,
  migrateToCurrent,
} from './format.ts';
import { type FeatureSettingsSpec, type SiteItem, checkItems, withoutItems } from './items.ts';

// 서비스 워커가 settings를 쓰기 전에 하는 순수한 계산(결정 0011 "쓰기", "세대 번호", "크기 한도").

export type Repair =
  | { readonly kind: 'missing' }
  | { readonly kind: 'corrupt' }
  | { readonly kind: 'migrated'; readonly from: number }
  | {
      readonly kind: 'corruptItems';
      readonly features: readonly string[];
      readonly sites: readonly SiteItem[];
    };

export interface Normalized {
  readonly value: StoredSettings;
  // 비어 있지 않으면 바꾸기가 없어도 고쳐 써야 한다.
  readonly repairs: readonly Repair[];
}

// 읽은 값을 버전으로 나누어 지금 형식의 값으로 만든다. 더 새 버전이면 손대지 않는다.
export function normalize(
  raw: unknown,
  format: SettingsFormat,
  specs: readonly FeatureSettingsSpec[],
): Result<Normalized, AppError> {
  const classified = classify(raw, format);
  let value: StoredSettings;
  const repairs: Repair[] = [];
  switch (classified.kind) {
    case 'newer':
      return err(
        appError(
          'unavailable',
          '더 새 버전의 확장이 저장한 설정이라 이 버전에서는 바꿀 수 없다. 새 버전을 다시 설치한다.',
        ),
      );
    case 'missing':
      value = emptySettings(format);
      repairs.push({ kind: 'missing' });
      break;
    case 'corrupt':
      value = emptySettings(format);
      repairs.push({ kind: 'corrupt' });
      break;
    case 'older': {
      const migrated = migrateToCurrent(classified.version, classified.value, format);
      if (migrated === 'corrupt') {
        value = emptySettings(format);
        repairs.push({ kind: 'corrupt' });
      } else {
        value = migrated;
        repairs.push({ kind: 'migrated', from: classified.version });
      }
      break;
    }
    case 'current':
      value = classified.value;
      break;
  }
  const { corruptFeatures, corruptSites } = checkItems(value, specs);
  if (corruptFeatures.length > 0 || corruptSites.length > 0) {
    value = withoutItems(value, corruptFeatures, corruptSites);
    repairs.push({ kind: 'corruptItems', features: corruptFeatures, sites: corruptSites });
  }
  return ok({ value, repairs });
}

// 바꾸기 전 값보다 크게 정한다. 바꾸기 전 값을 읽을 수 없으면 previous는 0이다.
// now는 설정을 읽은 시각보다 큰 시각이어야 한다(서비스 워커가 기다려 맞춘다). 그래야 처음 쓰거나 고쳐 쓴 값도
// 앞에 쓴 어떤 값보다 크다(결정 0011 "세대 번호").
export function nextRevision(previous: number, now: number): number {
  return Math.max(previous + 1, Math.trunc(now));
}

// 쓰기 직전의 최종 값(revision을 정한 값) 전체를 읽는 쪽과 같은 기준으로 검사한다. 틀린 값을 쓰면 다음 읽기에서
// 설정 전체의 손상이 되어 모든 설정을 잃으므로, 틀리면 쓰지 않는다(결정 0011 "쓰기", quality 066).
// 예: revision이 Number.MAX_SAFE_INTEGER인 값에서 다음 revision은 안전한 정수가 아니다.
export function checkFinal(
  value: StoredSettings,
  format: SettingsFormat,
  specs: readonly FeatureSettingsSpec[],
): Result<StoredSettings, AppError> {
  const classified = classify(value, format);
  if (classified.kind === 'current') {
    const { corruptFeatures, corruptSites } = checkItems(classified.value, specs);
    if (corruptFeatures.length === 0 && corruptSites.length === 0) return ok(value);
  }
  return err(
    appError(
      'unexpected',
      '저장할 설정이 형식에 맞지 않아 저장하지 않았다. 저장된 설정은 바뀌지 않았다.',
    ),
  );
}

export const settingsSizeLimit = 262_144;

// 설정을 JSON으로 쓴 UTF-8 바이트 수. 문자열 길이(UTF-16 코드 단위)가 아니다(결정 0011 "크기 한도").
// 저장된 값은 무엇이든(옛 형식, 손상 값) 읽은 그대로 같은 단위로 잰다. 저장된 값이 없으면 0이다.
export function settingsSize(value: unknown): number {
  if (value === undefined) return 0;
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

// 사용자가 하는 저장의 결과(next)가 한도를 넘고 지금보다 커지면 막는다. 줄이는 저장은 언제나 된다.
// 지금은 저장된 값(stored, 읽은 그대로)이다. 손상 항목을 지운 값이 아니다. 알리는 지금 크기도 이것이다.
// 같은 쓰기에 형식 이전이 섞여 커졌으면 그 커진 만큼은 막지 않는다: 이전만 한 값(normalized, 손상 항목도 지운 값)보다
// 커지지 않는 저장도 한다. 형식 이전과 고쳐 쓰기는 한도와 상관없이 하므로, 그것을 먼저 따로 써 두었다면 되었을 저장이다.
export function checkSize(
  next: StoredSettings,
  stored: unknown,
  normalized: StoredSettings,
): Result<number, AppError> {
  const size = settingsSize(next);
  if (size <= settingsSizeLimit) return ok(size);
  const storedSize = settingsSize(stored);
  if (size <= storedSize || size <= settingsSize(normalized)) return ok(size);
  return err(
    appError(
      'limit',
      `설정이 크기 한도(${String(settingsSizeLimit)}바이트)를 넘게 되어 저장하지 않았다. 지금 크기는 ${String(storedSize)}바이트다. 쓰지 않는 사이트 규칙을 지운다.`,
    ),
  );
}
