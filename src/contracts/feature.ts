import type * as z from 'zod/mini';

// 팝업 범주. 요구사항 묶음과 같고, 팝업은 이 순서로 보인다(quality 017, 결정 0023). 설정 범주는 설정 페이지를 만들 때 더한다.
export const categories = ['media', 'youtube', 'subtitles', 'tabs', 'page', 'chatgpt'] as const;

export type Category = (typeof categories)[number];

// 기능이 요청하는 Chrome 권한. 기능을 만들며 필요한 것을 더한다(결정 0009).
type FeaturePermission = never;

// 콘텐츠 스크립트를 실을 곳. YouTube·chatgpt.com 전용 묶음은 그 사이트의 기능을 만들 때 더한다.
interface ContentTarget {
  readonly sites: 'all';
  readonly frames: 'all' | 'top';
}

// "켜고 끄기" 기능의 설정은 켜짐 여부를 가진다(COM-1).
export interface ToggleSettings {
  readonly enabled: boolean;
}

// 기능 하나의 원본(결정 0004, 아키텍처 3장). 다른 곳은 이것을 읽기만 한다. 종류마다 그 종류에만 뜻이 있는 것을 둔다(055).
// "탭마다 켜고 끄기" 종류는 그런 기능을 처음 만들 때 더한다.
interface FeatureBase {
  readonly id: string;
  // 이 기능이 맡는 요구사항 번호(예: MED-1).
  readonly requirements: readonly string[];
  readonly name: string;
  readonly description: string;
  readonly category: Category;
  readonly content: ContentTarget | null;
  readonly permissions: readonly FeaturePermission[];
}

// 켜 두면 계속 작용한다. 켜짐 여부와 그 밖의 설정을 저장한다(COM-1, COM-3).
export interface ToggleFeature<S extends ToggleSettings = ToggleSettings> extends FeatureBase {
  readonly kind: 'toggle';
  readonly settings: {
    readonly schema: z.ZodMiniType<S>;
    readonly defaults: S;
  };
}

// 누를 때 그 탭에서 작업 하나를 끝까지 한다(COM-10, 결정 0024). 작업의 일은 기능의 background.ts에 있다.
// 지금은 설정이 없다. 설정이 필요한 실행 기능이 생기면 그때 더한다.
export interface ActionFeature extends FeatureBase {
  readonly kind: 'action';
  readonly task: {
    // 작업 하나의 제한 시간(ms). 넘기면 일에 멈춤 신호를 보내고 timeout으로 끝낸다(quality 068).
    readonly timeoutMs: number;
  };
}

export type FeatureDefinition = ToggleFeature | ActionFeature;

export function defineFeature<S extends ToggleSettings>(
  definition: ToggleFeature<S>,
): ToggleFeature<S>;
export function defineFeature(definition: ActionFeature): ActionFeature;
export function defineFeature(definition: FeatureDefinition): FeatureDefinition {
  return definition;
}

// 설정을 저장하는 기능. 설정을 읽고 쓰는 곳(읽기 도우미, 서비스 워커의 설정 쓰기)은 이것만 받는다.
export function featuresWithSettings(
  features: readonly FeatureDefinition[],
): readonly ToggleFeature[] {
  return features.filter((feature) => feature.kind === 'toggle');
}
