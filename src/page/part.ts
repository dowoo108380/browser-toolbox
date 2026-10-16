import type { ToggleFeature, ToggleSettings } from '../contracts/index.ts';
import type { Scope } from '../dom/index.ts';
import { type Snapshot, settingsOf } from '../storage/index.ts';

// 기능의 페이지 쪽 일(features/<기능>/page.ts)이 실행 틀에 내놓는 모양(결정 0014).

export interface PageContext {
  readonly window: Window;
  readonly document: Document;
}

// 시작 함수가 받는 것. scope는 이번 시작에만 쓰는 자원 범위다.
export interface PageStart extends PageContext {
  readonly scope: Scope;
}

export interface PagePart {
  readonly featureId: string;
  // 이 기능의 설정이 켜짐이면 시작한다. 꺼짐이면 아무것도 하지 않는다.
  // 기능이 페이지에 더한 화면 요소, 이벤트 처리, 타이머, 관찰은 모두 만든 즉시 scope에 맡긴다.
  // 실행 틀이 scope를 닫으면 모두 사라진다(COM-1.3). 시작 도중에 예외를 던져도 그때까지 맡긴 것은 치운다.
  readonly start: (snapshot: Snapshot, context: PageStart) => void;
}

export function definePagePart<S extends ToggleSettings>(
  definition: ToggleFeature<S>,
  start: (settings: S, context: PageStart) => void,
): PagePart {
  return {
    featureId: definition.id,
    start: (snapshot, context) => {
      const settings = settingsOf(snapshot, definition);
      if (settings.enabled) start(settings, context);
    },
  };
}
