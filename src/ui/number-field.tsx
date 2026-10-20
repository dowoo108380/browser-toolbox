import { useState } from 'preact/hooks';

// 기능의 화면 조각이 값 하나를 정하는 숫자 칸(결정 0030, 0039. GPT-2와 CLD-1의 너비 칸이 함께 쓴다). 칸의 문구와 값의 범위,
// 글을 값으로 읽는 법은 그 기능이 준다(문구는 그 기능 폴더, 범위는 그 기능의 core).
// - 쓰는 동안은 쓴 글을 보이고, 정하면(Enter, 초점을 옮김, ↑↓) 값으로 읽힐 때만 넘긴다. Chromium의 숫자 칸은 ↑↓를 누를 때마다,
//   글은 Enter와 초점을 옮길 때 change를 낸다(2026-10-18 실험). 다른 범주나 검색 칸을 누르거나 Ctrl+K로 칸이 없어질 때도 그
//   전에 change가 온다(확장 전체 시험, 결정 0037). 그래서 쓰던 글은 칸 안에만 둔다.
// - 읽히지 않으면 넘기지 않고 이유를 보인다. Esc는 쓰던 글을 버리고 보일 값으로 돌아간다. 쓰던 글이 없으면 Esc를 가로채지
//   않는다(팝업의 기본 동작).
// - 칸은 받은 값을 보인다. 다른 화면이 바꾼 값은 쓰는 동안에는 덮지 않는다. 넘긴 값을 저장하고, 저장될 때까지 그 값을 보이고,
//   실패하면 알리는 것은 팝업이다(결정 0036, 0037, COM-3 기대 동작 3).
interface NumberFieldProps {
  // 칸의 id. 안내와 이유의 id는 이 뒤에 -hint, -error를 붙인다.
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  // 정한 글이 값으로 읽히지 않을 때 보이는 이유.
  readonly invalid: string;
  readonly min: number;
  readonly max: number;
  // ↑↓ 한 번에 바뀌는 양.
  readonly step: number;
  // 정한 글을 값으로 읽는다. 받을 수 없으면 null이다. 받는 범위는 min–max와 같다(기능의 core가 같은 상수로 만든다).
  readonly parse: (text: string) => number | null;
  // 보일 값.
  readonly value: number;
  readonly disabled: boolean;
  // 값을 정했다.
  readonly onCommit: (value: number) => void;
}

export function NumberField({
  id,
  label,
  hint,
  invalid: invalidText,
  min,
  max,
  step,
  parse,
  value,
  disabled,
  onCommit,
}: NumberFieldProps) {
  // 쓰는 중인 글. null이면 받은 값을 보인다.
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);

  const commit = (text: string) => {
    const parsed = parse(text);
    setInvalid(parsed === null);
    if (parsed === null) return;
    setDraft(null);
    onCommit(parsed);
  };

  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div class="controls">
      <label for={id}>{label}</label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={step}
        value={draft ?? String(value)}
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
        {hint}
      </p>
      {invalid && (
        <p class="error" id={errorId}>
          {invalidText}
        </p>
      )}
    </div>
  );
}
