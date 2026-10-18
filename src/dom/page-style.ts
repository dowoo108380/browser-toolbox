import { ownElement } from './owned.ts';

// 페이지 자체의 모양을 바꾸는 스타일 요소(결정 0031). 격리된 화면 틀(isolated-host.ts)과 달리 그 문서의 요소에 걸린다.
// 문서 루트에 붙이고 확장의 표식을 달아, 옛 판 정리(결정 0008)가 찾을 수 있게 한다. 페이지 전역에 이름을 남기지 않는다.

interface PageStyle {
  readonly remove: () => void;
  // 규칙을 잠시 css로 바꾼 채 read를 부르고 되돌린다. 한 작업 안에서 끝나므로 그 사이가 화면에 그려지지 않는다. 그 규칙이
  // 실제로 작용하는지 잴 때 쓴다(결정 0034). read가 던져도 되돌린다.
  readonly measureWith: <T>(css: string, read: () => T) => T;
}

export function createPageStyle(
  document: Document,
  options: { readonly name: string; readonly css: string },
): PageStyle {
  const style = document.createElement('style');
  const remove = ownElement(style, options.name);
  style.textContent = options.css;
  document.documentElement.append(style);
  const measureWith = <T>(css: string, read: () => T): T => {
    style.textContent = css;
    try {
      return read();
    } finally {
      style.textContent = options.css;
    }
  };
  return { remove, measureWith };
}
