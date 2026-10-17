import { v } from '../contracts/index.ts';
import type { StoredSettings } from './format.ts';

// 설정 항목(기능 하나의 설정, 사이트 하나에서 기능 하나의 설정)을 검증하는 데 필요한 것. 기능 정의(feature.ts)가 준다.
export interface FeatureSettingsSpec {
  readonly id: string;
  readonly settings: { readonly schema: v.Schema };
  // 사이트마다 따로 정하는 설정(사이트 규칙, 사이트 예외)이 있는 기능만 둔다. 사이트 항목은 없으면 기본값이다(결정 0017).
  readonly siteSettings?: { readonly schema: v.Schema };
}

// 사이트 항목 하나. featureId가 null이면 그 사이트의 값이 객체가 아니어서 사이트 전체를 읽을 수 없다는 뜻이다(결정 0017).
export interface SiteItem {
  readonly host: string;
  readonly featureId: string | null;
}

export interface CheckedItems {
  // 검증을 통과한 기능 설정. 값은 그 기능의 스키마를 거친 결과다.
  readonly features: ReadonlyMap<string, unknown>;
  // 검증을 통과한 사이트 항목: 사이트(호스트) → 기능 id → 그 기능의 사이트 스키마를 거친 값. 통과한 항목이 없는 사이트는 없다.
  readonly sites: ReadonlyMap<string, ReadonlyMap<string, unknown>>;
  // 아는 항목인데 검증에 실패한 것. 그 항목만 기본값으로 쓰고 알린다(COM-3.4).
  readonly corruptFeatures: readonly string[];
  readonly corruptSites: readonly SiteItem[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 모르는 기능 id의 항목은 손상이 아니다. 같은 형식 버전에서 기능을 더한 새 릴리스를 쓰다가 되돌린 경우일 수 있으므로,
// 읽는 쪽은 무시하고 서비스 워커는 그대로 둔다(결정 0011). 사이트 항목도 같다: 사이트 설정을 정하지 않은 기능(모르는 기능
// 포함)의 사이트 항목은 보지 않는다. 새 릴리스가 기존 기능에 사이트 설정을 더했다가 되돌린 경우일 수 있다(결정 0017).
export function checkItems(
  value: StoredSettings,
  specs: readonly FeatureSettingsSpec[],
): CheckedItems {
  const features = new Map<string, unknown>();
  const corruptFeatures: string[] = [];
  for (const spec of specs) {
    if (!Object.hasOwn(value.features, spec.id)) continue;
    const parsed = v.safeParse(spec.settings.schema, value.features[spec.id]);
    if (parsed.success) features.set(spec.id, parsed.output);
    else corruptFeatures.push(spec.id);
  }

  const sites = new Map<string, ReadonlyMap<string, unknown>>();
  const corruptSites: SiteItem[] = [];
  for (const [host, entry] of Object.entries(value.sites)) {
    // 사이트 값의 모양(기능 id → 값)은 형식이 정한다. 객체가 아니면 어느 기능의 것인지도 알 수 없다.
    if (!isRecord(entry)) {
      corruptSites.push({ host, featureId: null });
      continue;
    }
    const valid = new Map<string, unknown>();
    for (const spec of specs) {
      if (spec.siteSettings === undefined || !Object.hasOwn(entry, spec.id)) continue;
      const parsed = v.safeParse(spec.siteSettings.schema, entry[spec.id]);
      if (parsed.success) valid.set(spec.id, parsed.output);
      else corruptSites.push({ host, featureId: spec.id });
    }
    if (valid.size > 0) sites.set(host, valid);
  }
  return { features, sites, corruptFeatures, corruptSites };
}

// 받은 손상 항목(checkItems가 찾은 것)만 지운 값. 지운 항목은 기본값이 된다. 나머지는 저장된 값 그대로 둔다(스키마를 거친
// 값이 아니다. 더 새 릴리스가 더한 필드도 남는다). 사이트 하나에서 손상된 기능의 항목만 빠지고 다른 기능의 항목은 남는다.
// 항목이 모두 빠진 사이트는 빈 객체로 남는다(빈 객체도 맞는 값이다).
export function withoutItems(
  value: StoredSettings,
  corruptFeatures: readonly string[],
  corruptSites: readonly SiteItem[],
): StoredSettings {
  const features = Object.fromEntries(
    Object.entries(value.features).filter(([id]) => !corruptFeatures.includes(id)),
  );
  const isCorrupt = (host: string, featureId: string | null) =>
    corruptSites.some((item) => item.host === host && item.featureId === featureId);
  const sites = Object.fromEntries(
    Object.entries(value.sites).flatMap(([host, entry]) => {
      if (isCorrupt(host, null)) return [];
      if (!isRecord(entry)) return [[host, entry]];
      return [
        [host, Object.fromEntries(Object.entries(entry).filter(([id]) => !isCorrupt(host, id)))],
      ];
    }),
  );
  return { ...value, features, sites };
}
