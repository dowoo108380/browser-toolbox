import { type ComponentChild, h } from 'preact';
import type { ToggleFeature, ToggleSettings } from '../contracts/index.ts';
import { type Snapshot, settingsOf } from '../storage/index.ts';

// 기능의 팝업 화면 조각(features/<기능>/ui.tsx, 결정 0030). 팝업은 그 기능 항목의 설명 아래에 그리고, 싣고 저장하고 알리는
// 일만 한다. 조각의 조작과 문구는 그 기능 폴더에 있다.

// 조각이 받는 것.
interface UiPartProps<S extends ToggleSettings> {
  readonly feature: ToggleFeature<S>;
  // 읽기 도우미가 받아들인 그 기능의 설정(저장된 값). 기능이 꺼져 있어도 값을 정할 수 있다. 이 조각이 보낸 저장은 늦게
  // 담긴다(응답과 바뀜 알림이 늦게 온다). 그래서 보낼지는 이 값이 아니라 마지막으로 보낸 값과 견준다(아키텍처 4장).
  readonly settings: S;
  // 서비스 워커가 깨어나기 전에는 조작을 막는다(N-12).
  readonly disabled: boolean;
  // 설정 바꾸기를 보내고 저장했는지 돌려준다. 거절하지 않는다. 실패의 이유는 팝업이 알림 줄에 보인다(COM-3 기대 동작 3).
  readonly save: (patch: Partial<Omit<S, 'enabled'>>) => Promise<boolean>;
}

// 팝업이 그 기능 항목에 붙여 그리는 것.
export interface FeatureUiPart {
  readonly featureId: string;
  readonly render: (
    snapshot: Snapshot,
    host: {
      readonly disabled: boolean;
      readonly save: (patch: Readonly<Record<string, unknown>>) => Promise<boolean>;
    },
  ) => ComponentChild;
}

// part는 조각의 컴포넌트다(훅을 쓸 수 있다).
export function defineUiPart<S extends ToggleSettings>(
  definition: ToggleFeature<S>,
  part: (props: UiPartProps<S>) => ComponentChild,
): FeatureUiPart {
  return {
    featureId: definition.id,
    render: (snapshot, { disabled, save }) =>
      h(part, { feature: definition, settings: settingsOf(snapshot, definition), disabled, save }),
  };
}
