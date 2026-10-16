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

// 기능 하나의 원본(결정 0004, 아키텍처 3장). 다른 곳은 이것을 읽기만 한다.
// "실행", "탭마다 켜고 끄기" 종류는 그런 기능을 처음 만들 때 더한다.
export interface FeatureDefinition<S extends ToggleSettings = ToggleSettings> {
  readonly id: string;
  // 이 기능이 맡는 요구사항 번호(예: MED-1).
  readonly requirements: readonly string[];
  readonly name: string;
  readonly description: string;
  readonly category: Category;
  readonly kind: 'toggle';
  readonly content: ContentTarget | null;
  readonly permissions: readonly FeaturePermission[];
  readonly settings: {
    readonly schema: z.ZodMiniType<S>;
    readonly defaults: S;
  };
}

export function defineFeature<S extends ToggleSettings>(
  definition: FeatureDefinition<S>,
): FeatureDefinition<S> {
  return definition;
}
