import { useState } from 'preact/hooks';
import { defineUiPart } from '../../ui/index.ts';
import { maxWidth, minWidth, parseWidth, widthStep } from './core/width.ts';
import { chatgptWidth } from './feature.ts';
import { strings } from './strings.ts';

// 팝업에서 대화 열·작성란의 최대 너비를 정하는 숫자 칸(결정 0030, 사용자 2026-10-18).
// - 쓰는 동안은 쓴 글을 보이고, 정하면(Enter, 초점을 옮김, ↑↓) 범위 안의 정수일 때만 저장한다. Chromium의 숫자 칸은 ↑↓를
//   누를 때마다, 글은 Enter와 초점을 옮길 때 change를 낸다(2026-10-18 실험). 다른 범주나 검색 칸을 누르거나 Ctrl+K로 칸이
//   없어질 때도 그 전에 change가 온다(확장 전체 시험, 결정 0037). 그래서 쓰던 글은 칸 안에만 둔다. 저장한 값은 열린
//   chatgpt.com 탭에 바로 걸린다.
// - 범위 밖이면 저장하지 않고 이유를 보인다. Esc는 쓰던 글을 버리고 정한 값으로 돌아간다. 쓰던 글이 없으면 Esc를
//   가로채지 않는다(팝업의 기본 동작).
// - 칸은 팝업이 준 설정을 보인다. 정한 값은 저장되어 보일 때까지 그대로 보이고 그동안 다시 정한 값도 보내며, 저장이 실패하면
//   팝업이 알리고 저장된 값으로 돌아간다. 이 차례는 팝업이 정한 값의 기억으로 맞춘다(결정 0036, 0037, COM-3 기대 동작 3).
export const ui = defineUiPart(chatgptWidth, ({ feature, settings, disabled, choose }) => {
  // 쓰는 중인 글. null이면 정한 값을 보인다. 다른 화면이 바꾼 값은 쓰는 동안에는 덮지 않는다.
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);

  const commit = (text: string) => {
    const width = parseWidth(text);
    setInvalid(width === null);
    if (width === null) return;
    setDraft(null);
    choose({ width });
  };

  const inputId = `${feature.id}-width`;
  const hintId = `${feature.id}-width-hint`;
  const errorId = `${feature.id}-width-error`;
  return (
    <div class="controls">
      <label for={inputId}>{strings.widthLabel}</label>
      <input
        id={inputId}
        type="number"
        inputMode="numeric"
        min={minWidth}
        max={maxWidth}
        step={widthStep}
        value={draft ?? String(settings.width)}
        disabled={disabled}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${errorId} ${hintId}` : hintId}
        onInput={(event) => {
          setDraft(event.currentTarget.value);
          setInvalid(false);
        }}
        onChange={(event) => {
          commit(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || (draft === null && !invalid)) return;
          event.preventDefault();
          event.stopPropagation();
          setDraft(null);
          setInvalid(false);
        }}
      />
      <p class="hint" id={hintId}>
        {strings.widthHint}
      </p>
      {invalid && (
        <p class="error" id={errorId}>
          {strings.widthInvalid}
        </p>
      )}
    </div>
  );
});
