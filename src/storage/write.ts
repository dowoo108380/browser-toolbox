import { type AppError, type Result, appError, err, ok } from '../shared/index.ts';
import {
  type SettingsFormat,
  type StoredSettings,
  classify,
  emptySettings,
  migrateToCurrent,
} from './format.ts';
import { type FeatureSettingsSpec, checkFeatureItems } from './items.ts';

// 서비스 워커가 settings를 쓰기 전에 하는 순수한 계산(결정 0011 "쓰기", "세대 번호", "크기 한도").

export type Repair =
  | { readonly kind: 'missing' }
  | { readonly kind: 'corrupt' }
  | { readonly kind: 'migrated'; readonly from: number }
  | { readonly kind: 'corruptItems'; readonly items: readonly string[] };

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
  const { corrupt } = checkFeatureItems(value.features, specs);
  if (corrupt.length > 0) {
    const features = Object.fromEntries(
      Object.entries(value.features).filter(([id]) => !corrupt.includes(id)),
    );
    value = { ...value, features };
    repairs.push({ kind: 'corruptItems', items: corrupt });
  }
  return ok({ value, repairs });
}

// 앞의 어떤 값보다 크게 정한다. 바꾸기 전 값을 읽을 수 없으면 previous는 0이다(결정 0011 "세대 번호").
export function nextRevision(previous: number, now: number): number {
  return Math.max(previous + 1, Math.trunc(now));
}

export const settingsSizeLimit = 262_144;

// 설정을 JSON으로 쓴 UTF-8 바이트 수. 문자열 길이(UTF-16 코드 단위)가 아니다(결정 0011 "크기 한도").
export function settingsSize(value: StoredSettings): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

// 한도를 넘고 지금보다 커지는 저장만 막는다. 줄이는 저장은 언제나 된다.
export function checkSize(
  next: StoredSettings,
  previous: StoredSettings,
): Result<number, AppError> {
  const size = settingsSize(next);
  const currentSize = settingsSize(previous);
  if (size <= settingsSizeLimit || size <= currentSize) return ok(size);
  return err(
    appError(
      'limit',
      `설정이 크기 한도(${String(settingsSizeLimit)}바이트)를 넘게 되어 저장하지 않았다. 지금 크기는 ${String(currentSize)}바이트다. 쓰지 않는 사이트 규칙을 지운다.`,
    ),
  );
}
