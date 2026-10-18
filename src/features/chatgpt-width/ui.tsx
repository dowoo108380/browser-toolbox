import { useEffect, useRef, useState } from 'preact/hooks';
import { defineUiPart } from '../../ui/index.ts';
import { maxWidth, minWidth, parseWidth, widthStep } from './core/width.ts';
import { chatgptWidth } from './feature.ts';
import { strings } from './strings.ts';

// 팝업에서 대화 열·작성란의 최대 너비를 정하는 숫자 칸(결정 0030, 사용자 2026-10-18).
// - 쓰는 동안은 쓴 글을 보이고, 정하면(Enter, 초점을 옮김, ↑↓) 범위 안의 정수일 때만 저장한다. Chromium의 숫자 칸은 ↑↓를
//   누를 때마다, 글은 Enter와 초점을 옮길 때 change를 낸다(2026-10-18 실험). 저장한 값은 열린 chatgpt.com 탭에 바로 걸린다.
// - 범위 밖이면 저장하지 않고 이유를 보인다. Esc는 쓰던 글을 버리고 정한 값으로 돌아간다. 쓰던 글이 없으면 Esc를
//   가로채지 않는다(팝업의 기본 동작).
// - 정한 값은 저장이 끝나 저장된 값으로 돌아올 때까지 그대로 보이고, 그동안 다시 정하면 그것도 보낸다. 저장은 서비스 워커가
//   들어온 차례로 하므로 마지막으로 정한 값이 남는다(결정 0030).
// - 저장이 실패하면 팝업이 알리고, 칸은 저장된 값으로 돌아간다(COM-3 기대 동작 3).
export const ui = defineUiPart(chatgptWidth, ({ feature, settings, disabled, save }) => {
  // 쓰는 중인 글. null이면 정한 값을 보인다. 다른 화면이 바꾼 값은 쓰는 동안에는 덮지 않는다.
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  // 이 칸에서 마지막으로 정해 저장을 보낸 너비. 저장된 값(settings.width)은 보낸 저장을 아직 담지 않았을 수 있어(응답과
  // 바뀜 알림이 늦게 온다), 그동안 사용자가 마지막으로 정한 값은 이것이다. null이면 저장된 값이다.
  const [chosen, setChosen] = useState<number | null>(null);
  // 응답을 기다리는 저장의 수.
  const pending = useRef(0);

  // 보낸 저장이 모두 끝난 뒤 저장된 값이 바뀌면 그것을 따른다(이 칸의 저장이 돌아옴, 다른 화면이 바꿈).
  useEffect(() => {
    if (pending.current === 0) setChosen(null);
  }, [settings.width]);

  const shown = chosen ?? settings.width;

  const commit = (text: string) => {
    const width = parseWidth(text);
    setInvalid(width === null);
    if (width === null) return;
    setDraft(null);
    if (width === shown) return;
    setChosen(width);
    pending.current += 1;
    void save({ width }).then((saved) => {
      pending.current -= 1;
      // 저장하지 못했으면, 그 뒤에 정한 값이 없을 때 저장된 값으로 돌아간다.
      if (!saved) setChosen((latest) => (latest === width ? null : latest));
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
        value={draft ?? String(shown)}
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
