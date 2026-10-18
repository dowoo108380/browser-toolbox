import { useEffect, useState } from 'preact/hooks';
import { defineUiPart } from '../../ui/index.ts';
import { maxWidth, minWidth, parseWidth, widthStep } from './core/width.ts';
import { chatgptWidth } from './feature.ts';
import { strings } from './strings.ts';

// 팝업에서 대화 열·작성란의 최대 너비를 정하는 숫자 칸(결정 0030, 사용자 2026-10-18).
// - 쓰는 동안은 쓴 글을 보이고, 정하면(Enter, 초점을 옮김, ↑↓) 범위 안의 정수일 때만 저장한다. Chromium의 숫자 칸은 ↑↓를
//   누를 때마다, 글은 Enter와 초점을 옮길 때 change를 낸다(2026-10-18 실험). 저장한 값은 열린 chatgpt.com 탭에 바로 걸린다.
// - 범위 밖이면 저장하지 않고 이유를 보인다. Esc는 쓰던 글을 버리고 저장된 값으로 돌아간다. 쓰던 글이 없으면 Esc를
//   가로채지 않는다(팝업의 기본 동작).
// - 저장이 실패하면 팝업이 알리고, 칸은 저장된 값으로 돌아간다(COM-3 기대 동작 3).
export const ui = defineUiPart(chatgptWidth, ({ feature, settings, disabled, save }) => {
  // 쓰는 중인 글. null이면 저장된 값을 보인다.
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);

  // 저장한 값이 돌아오면 쓰던 글을 놓는다. 다른 화면이 바꾼 값은 쓰는 동안에는 덮지 않는다.
  useEffect(() => {
    if (draft !== null && parseWidth(draft) === settings.width) setDraft(null);
  }, [draft, settings.width]);

  const commit = (text: string) => {
    const width = parseWidth(text);
    setInvalid(width === null);
    if (width === null) return;
    if (width === settings.width) {
      setDraft(null);
      return;
    }
    void save({ width }).then((saved) => {
      if (!saved) setDraft(null);
    });
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
