import { type ComponentChild, h } from 'preact';
import type { ToggleFeature, ToggleSettings } from '../contracts/index.ts';
import { type Snapshot, settingsOf } from '../storage/index.ts';

// 기능의 팝업 화면 조각(features/<기능>/ui.tsx, 결정 0030). 팝업은 그 기능 항목의 설명 아래에 그리고, 싣고 저장하고 알리는
// 일만 한다. 조각의 조작과 문구는 그 기능 폴더에 있다.

// 조각이 받는 것.
interface UiPartProps<S extends ToggleSettings> {
  readonly feature: ToggleFeature<S>;
  // 칸에 보일 그 기능의 설정. 읽기 도우미가 받아들인 설정(없으면 기본값)에, 이 조각이 정했지만 아직 담기지 않은 값을 얹은
  // 것이다(결정 0036, 0037). 기능이 꺼져 있어도 값을 정할 수 있다.
  readonly settings: S;
  // 서비스 워커가 깨어나기 전에는 조작을 막는다(N-12).
  readonly disabled: boolean;
  // 값을 정한다. 팝업은 칸에 보이는 값과 다를 때만 그 기능의 설정 바꾸기를 보내고, 실패하면 알림 줄에 이유를 보인다. 조각은
  // settings를 보이면 된다. 정한 값이 저장되어 보일 때까지와 실패 뒤 저장된 값으로 돌아가는 것은 팝업이 맞춘다(COM-3 기대
  // 동작 3).
  readonly choose: (patch: Partial<Omit<S, 'enabled'>>) => void;
}

// 팝업이 그 기능 항목에 붙여 그리는 것.
export interface FeatureUiPart {
  readonly featureId: string;
  readonly render: (
    snapshot: Snapshot,
    host: {
      // 그 기능의 정했지만 아직 담기지 않은 값(설정 키 → 값). 저장된 설정 대신 보인다.
      readonly chosen: ReadonlyMap<string, unknown>;
      readonly disabled: boolean;
      readonly choose: (patch: Readonly<Record<string, unknown>>) => void;
    },
  ) => ComponentChild;
}

// part는 조각의 컴포넌트다(훅을 쓸 수 있다). 조각이 사라졌다 다시 그려져도 정한 값의 기억은 팝업에 남는다(결정 0037).
export function defineUiPart<S extends ToggleSettings>(
  definition: ToggleFeature<S>,
  part: (props: UiPartProps<S>) => ComponentChild,
): FeatureUiPart {
  return {
    featureId: definition.id,
    render: (snapshot, { chosen, disabled, choose }) =>
      h(part, {
        feature: definition,
        settings: withChosen(settingsOf(snapshot, definition), chosen),
        disabled,
        choose,
      }),
  };
}

// 저장된 설정에 정했지만 아직 담기지 않은 값을 얹는다. chosen에는 이 조각의 choose가 정한 값(Partial<Omit<S, 'enabled'>>)만
// 있다. 팝업은 그 기능 id의 기억만 그 기능의 조각에 넘기고, 기능 id와 조각은 하나씩 짝이다(등록 목록).
function withChosen<S extends ToggleSettings>(
  settings: S,
  chosen: ReadonlyMap<string, unknown>,
): S {
  return chosen.size === 0 ? settings : { ...settings, ...Object.fromEntries(chosen) };
}
