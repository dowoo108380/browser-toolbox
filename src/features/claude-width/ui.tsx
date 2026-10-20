import { NumberField, defineUiPart } from '../../ui/index.ts';
import { maxWidth, minWidth, parseWidth, widthStep } from './core/width.ts';
import { claudeWidth } from './feature.ts';
import { strings } from './strings.ts';

// 팝업에서 claude.ai의 대화 열·작성란의 최대 너비를 정하는 숫자 칸(결정 0030, 0039). 칸의 동작(쓰는 동안, 정할 때, Esc)은
// 너비 기능이 함께 쓰는 ui의 NumberField에 있다. 정한 값은 팝업이 저장하고, 저장한 값은 열린 claude.ai 탭에 바로 걸린다.
export const ui = defineUiPart(claudeWidth, ({ feature, settings, disabled, choose }) => (
  <NumberField
    id={`${feature.id}-width`}
    label={strings.widthLabel}
    hint={strings.widthHint}
    invalid={strings.widthInvalid}
    min={minWidth}
    max={maxWidth}
    step={widthStep}
    parse={parseWidth}
    value={settings.width}
    disabled={disabled}
    onCommit={(width) => {
      choose({ width });
    }}
  />
));
