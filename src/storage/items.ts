import type * as z from 'zod/mini';

// 설정 항목(기능 하나의 설정)을 검증하는 데 필요한 것. 기능 정의(feature.ts)가 준다.
export interface FeatureSettingsSpec {
  readonly id: string;
  readonly settings: { readonly schema: z.ZodMiniType };
}

export interface CheckedItems {
  // 검증을 통과한 항목. 값은 그 기능의 스키마를 거친 결과다.
  readonly valid: ReadonlyMap<string, unknown>;
  // 아는 기능인데 검증에 실패한 항목. 그 항목만 기본값으로 쓰고 알린다(COM-3.4).
  readonly corrupt: readonly string[];
}

// 모르는 기능 id의 항목은 손상이 아니다. 같은 형식 버전에서 기능을 더한 새 릴리스를 쓰다가
// 되돌린 경우일 수 있으므로, 읽는 쪽은 무시하고 서비스 워커는 그대로 둔다(결정 0011).
export function checkFeatureItems(
  features: Readonly<Record<string, unknown>>,
  specs: readonly FeatureSettingsSpec[],
): CheckedItems {
  const valid = new Map<string, unknown>();
  const corrupt: string[] = [];
  for (const spec of specs) {
    if (!Object.hasOwn(features, spec.id)) continue;
    const parsed = spec.settings.schema.safeParse(features[spec.id]);
    if (parsed.success) valid.set(spec.id, parsed.data);
    else corrupt.push(spec.id);
  }
  return { valid, corrupt };
}
