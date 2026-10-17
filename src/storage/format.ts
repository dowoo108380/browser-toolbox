import { v } from '../contracts/index.ts';

// 설정 저장 형식(결정 0011). storage.local의 settings 키 하나에 설정 전체를 둔다.

export const settingsKey = 'settings';

export interface StoredSettings {
  readonly version: number;
  readonly revision: number;
  readonly features: Readonly<Record<string, unknown>>;
  readonly sites: Readonly<Record<string, unknown>>;
}

// 어떤 형식에서도 바꾸지 않는 것은 이것 하나다: 객체이고 최상위에 1 이상의 정수 version이 있다.
// 옛 릴리스가 더 새 형식을 알아보는 단서가 이것뿐이다(결정 0011).
const envelopeSchema = v.looseObject({ version: v.pipe(v.int(), v.minValue(1)) });

// 지금 형식의 구조. 시험에서 가짜 옛 버전을 끼울 수 있게 버전을 받는다.
export function currentStructure(version: number): v.Schema<StoredSettings> {
  return v.object({
    version: v.literal(version),
    revision: v.pipe(v.int(), v.minValue(1)),
    features: v.record(v.string(), v.unknown()),
    sites: v.record(v.string(), v.unknown()),
  });
}

// 버전 N의 값을 N+1의 값으로 바꾸는 순수 함수와, 그 함수가 받을 버전 N의 구조.
// 이전 함수는 항목 손상을 고치거나 버리지 않고 그대로 넘기고, revision도 옮긴다(결정 0011).
interface Migration {
  readonly structure: v.Schema;
  readonly migrate: (value: unknown) => unknown;
}

export interface SettingsFormat {
  readonly version: number;
  readonly structure: v.Schema<StoredSettings>;
  // 키는 이전 함수가 받는 버전이다.
  readonly migrations: ReadonlyMap<number, Migration>;
}

export const settingsFormat: SettingsFormat = {
  version: 1,
  structure: currentStructure(1),
  migrations: new Map(),
};

export type Classified =
  | { readonly kind: 'missing' }
  // 버전을 알 수 없거나, 같은 버전인데 구조가 틀림. 설정 전체의 손상이다.
  | { readonly kind: 'corrupt' }
  | { readonly kind: 'newer'; readonly version: number }
  | { readonly kind: 'older'; readonly version: number; readonly value: unknown }
  | { readonly kind: 'current'; readonly value: StoredSettings };

// 버전을 먼저 보고 나눈다. 같은 버전일 때만 지금 구조를 검사한다(결정 0011 읽는 쪽 계약 2).
export function classify(raw: unknown, format: SettingsFormat): Classified {
  if (raw === undefined) return { kind: 'missing' };
  const envelope = v.safeParse(envelopeSchema, raw);
  if (!envelope.success) return { kind: 'corrupt' };
  const { version } = envelope.output;
  if (version > format.version) return { kind: 'newer', version };
  if (version < format.version) return { kind: 'older', version, value: raw };
  const current = v.safeParse(format.structure, raw);
  return current.success ? { kind: 'current', value: current.output } : { kind: 'corrupt' };
}

// 옛 버전의 값을 지금 형식으로 바꾼다. 처음 버전의 구조가 틀리면 설정 전체의 손상이다.
// 이전 함수가 틀린 값을 만들면 결함이므로 던진다(quality 066).
export function migrateToCurrent(
  version: number,
  value: unknown,
  format: SettingsFormat,
): StoredSettings | 'corrupt' {
  let current = value;
  for (let from = version; from < format.version; from += 1) {
    const migration = format.migrations.get(from);
    if (migration === undefined) throw new Error(`설정 형식 ${String(from)}의 이전 함수가 없다.`);
    const parsed = v.safeParse(migration.structure, current);
    if (!parsed.success) {
      if (from === version) return 'corrupt';
      throw new Error(`설정 형식 ${String(from - 1)}의 이전 함수가 틀린 값을 만들었다.`);
    }
    current = migration.migrate(parsed.output);
  }
  const result = v.safeParse(format.structure, current);
  if (!result.success) {
    throw new Error(`설정 형식 ${String(format.version - 1)}의 이전 함수가 틀린 값을 만들었다.`);
  }
  return result.output;
}

export function emptySettings(format: SettingsFormat): StoredSettings {
  // revision 0은 아직 쓴 적이 없다는 뜻이다. 쓸 때 nextRevision으로 1 이상이 된다.
  return { version: format.version, revision: 0, features: {}, sites: {} };
}
