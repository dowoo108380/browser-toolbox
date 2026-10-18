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
// - 정한 값은 보낸 저장이 모두 끝나고 저장된 값이 그 저장을 담을 때까지 그대로 보이고, 그동안 다시 정하면 그것도 보낸다.
//   저장은 서비스 워커가 들어온 차례로 하므로 마지막으로 정한 값이 남는다(결정 0030). 저장된 값이 그 저장을 담았는지는
//   응답과 바뀜 알림의 차례가 아니라 세대 번호(revision)로 가른다(결정 0036).
// - 저장이 실패하면 팝업이 알리고, 칸은 저장된 값으로 돌아간다(COM-3 기대 동작 3).
export const ui = defineUiPart(chatgptWidth, ({ feature, settings, revision, disabled, save }) => {
  // 쓰는 중인 글. null이면 정한 값을 보인다. 다른 화면이 바꾼 값은 쓰는 동안에는 덮지 않는다.
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  // 저장된 값 대신 보일 너비: 응답을 기다리는 동안은 마지막으로 정해 보낸 값, 모두 끝났지만 저장된 값이 아직 마지막 저장을
  // 담지 않았으면(응답이 바뀜 알림보다 먼저 옴) 그 저장의 값이다. null이면 저장된 값을 보인다.
  const [chosen, setChosen] = useState<number | null>(null);
  // 보낸 저장: 응답을 기다리는 수와, 저장한 것 가운데 세대 번호가 가장 큰 것(서비스 워커는 들어온 차례로 저장하므로 마지막에
  // 저장된 이 칸의 값이다).
  const sent = useRef<{ pending: number; written: { revision: number; width: number } | null }>({
    pending: 0,
    written: null,
  });
  // 지금 보이는 저장된 값의 세대 번호. 응답을 받은 때에는 그 저장을 보낸 때가 아니라 지금의 것과 견준다.
  const storedRevision = useRef(revision);

  // 보낸 저장이 모두 끝났으면 저장된 값과 맞춘다. 저장된 값이 이 칸의 마지막 저장을 담았으면(세대 번호가 작지 않음. 그 뒤
  // 다른 화면이 바꾼 값일 수도 있다) 저장된 값을, 아직 담지 않았으면 그 저장의 값을 보인다. 기본값으로 대신 쓰는 동안(세대
  // 번호 없음)은 저장된 값을 보인다.
  const reconcile = () => {
    const { pending, written } = sent.current;
    if (pending > 0) return;
    const stored = storedRevision.current;
    setChosen(
      written === null || stored === null || stored >= written.revision ? null : written.width,
    );
  };

  // 저장된 값이 바뀔 때마다(이 칸의 저장이 돌아옴, 다른 화면이 바꿈) 맞춘다. 기본값으로 대신 쓰면(설정 전체의 손상) 앞의
  // 저장을 잊는다. 고쳐 쓴 값의 세대 번호는 시계를 따라 정해져 그보다 작을 수 있다(결정 0011).
  useEffect(() => {
    storedRevision.current = revision;
    if (revision === null) sent.current.written = null;
    reconcile();
  }, [revision]);

  const shown = chosen ?? settings.width;

  const commit = (text: string) => {
    const width = parseWidth(text);
    setInvalid(width === null);
    if (width === null) return;
    setDraft(null);
    if (width === shown) return;
    setChosen(width);
    sent.current.pending += 1;
    void save({ width }).then((written) => {
      sent.current.pending -= 1;
      const last = sent.current.written;
      if (written !== null && (last === null || written > last.revision)) {
        sent.current.written = { revision: written, width };
      }
      // 마지막 응답이면 저장된 값과 맞춘다. 저장하지 못했으면 저장된 값(또는 아직 담기지 않은 앞의 저장)으로 돌아간다.
      reconcile();
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
