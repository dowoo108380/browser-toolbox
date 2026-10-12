import type { FeatureDefinition, ToggleSettings } from '../contracts/index.ts';
import { type Snapshot, settingsOf } from '../storage/index.ts';

// 기능의 페이지 쪽 일(features/<기능>/page.ts)이 실행 틀에 내놓는 모양.

export type Dispose = () => void;

export interface PageContext {
  readonly window: Window;
  readonly document: Document;
}

export interface PagePart {
  readonly featureId: string;
  // 이 기능의 설정이 켜짐이면 시작하고 정리 함수를 돌려준다. 꺼짐이면 null이다.
  // 정리 함수는 그 기능이 페이지에 더한 화면 요소, 이벤트 처리, 타이머, 관찰을 모두 없앤다(COM-1.3).
  readonly start: (snapshot: Snapshot, context: PageContext) => Dispose | null;
}

export function definePagePart<S extends ToggleSettings>(
  definition: FeatureDefinition<S>,
  start: (settings: S, context: PageContext) => Dispose,
): PagePart {
  return {
    featureId: definition.id,
    start: (snapshot, context) => {
      const settings = settingsOf(snapshot, definition);
      return settings.enabled ? start(settings, context) : null;
    },
  };
}
