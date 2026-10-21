import { createIsolatedHost } from '../dom/index.ts';
import type { PageContext } from './part.ts';

// 페이지 위 작업 결과 알림(COM-10 기대 동작 4, 결정 0024). 팝업이 닫힌 동안 작업이 끝나면 서비스 워커가 그 탭의 최상위
// 프레임에 글을 보내고, 실행 틀이 페이지 오른쪽 위에 잠깐 보인다. 닫힌 shadow root 안에 두고(결정 0007), popover로 최상위
// 층에 띄워 전체 화면 위에도 보인다(결정 0018: 나중에 띄운 것이 위에 그려진다). 누르기를 가로채지 않는다.

export const noticeMs = 3000;

// :host의 !important 선언은 shadow 안쪽의 것이라 host의 인라인 스타일(all: initial !important)과 페이지 CSS, popover의
// 브라우저 기본 스타일(가운데, 테두리, 바탕)보다 앞선다(결정 0018의 실험).
const css = `
:host {
  position: fixed !important;
  inset: 16px 16px auto auto !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  background: transparent !important;
  max-width: min(360px, calc(100vw - 32px)) !important;
  overflow: visible !important;
  pointer-events: none !important;
}
.notice {
  padding: 8px 12px;
  border-radius: 6px;
  background: rgb(0 0 0 / 0.85);
  color: #fff;
  font: 14px/1.4 system-ui, sans-serif;
  box-shadow: 0 2px 8px rgb(0 0 0 / 0.3);
  overflow-wrap: anywhere;
}
`;

export interface NoticeBoard {
  // 글을 noticeMs 동안 보인다. 앞의 알림이 남아 있으면 바꾼다. 문서가 보이지 않으면 띄우지 않는다(배지만 남는다).
  readonly show: (text: string) => void;
  // 남은 알림을 지운다(실행 틀이 물러날 때).
  readonly close: () => void;
}

export function createNoticeBoard(context: PageContext): NoticeBoard {
  let shown: { readonly remove: () => void; readonly timer: number } | null = null;
  const close = () => {
    if (shown === null) return;
    context.window.clearTimeout(shown.timer);
    shown.remove();
    shown = null;
  };
  return {
    show: (text) => {
      if (context.document.visibilityState !== 'visible') return;
      close();
      const { root, remove } = createIsolatedHost(context.document, {
        name: 'task-notice',
        css,
        parent: context.document.documentElement,
        topLayer: {},
      });
      const box = context.document.createElement('div');
      box.className = 'notice';
      // 화면 낭독기가 끊지 않고 읽는다.
      box.setAttribute('role', 'status');
      box.textContent = text;
      root.append(box);
      shown = { remove, timer: context.window.setTimeout(close, noticeMs) };
    },
    close,
  };
}
