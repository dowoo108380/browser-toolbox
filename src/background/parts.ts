// 기능의 서비스 워커 쪽 일(작업의 일 task-part.ts, 탭마다 켜고 끄는 일 tab-toggle-part.ts)을 그 기능과 짝짓는다. 그런 기능마다 일이
// 꼭 하나 있어야 한다. 빠지거나 겹치면 결함이므로 서비스 워커가 시작할 때 드러낸다(quality 066).

// 일이 맞지 않을 때 던지는 오류의 문구. 일의 종류마다 다르다.
export interface PartMismatch {
  // 맞는 기능이 없는 일.
  readonly orphan: (featureId: string) => string;
  // 일이 하나가 아닌 기능. count는 그 기능의 일의 수다.
  readonly count: (featureId: string, count: number) => string;
}

// features(그 일을 가져야 하는 기능)의 id → 그 기능과 일.
export function partsByFeature<
  F extends { readonly id: string },
  P extends { readonly featureId: string },
>(
  features: readonly F[],
  parts: readonly P[],
  mismatch: PartMismatch,
): ReadonlyMap<string, { readonly feature: F; readonly part: P }> {
  for (const part of parts) {
    if (!features.some((feature) => feature.id === part.featureId)) {
      throw new Error(mismatch.orphan(part.featureId));
    }
  }
  return new Map(
    features.map((feature) => {
      const matched = parts.filter((part) => part.featureId === feature.id);
      const [part] = matched;
      if (part === undefined || matched.length > 1) {
        throw new Error(mismatch.count(feature.id, matched.length));
      }
      return [feature.id, { feature, part }];
    }),
  );
}
