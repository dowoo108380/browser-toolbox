import type { SelectionEnd } from './core/capture.ts';
import type { Size } from './core/geometry.ts';

// 캡처의 문구(결정 0007). 작업의 결과(짧은 결과)와 실패 이유다. 페이지 주소는 넣지 않는다. 저장한 파일 이름(사이트 이름이 든다)은
// 짧은 결과에만 넣는다(COM-10 기대 동작 2).

const count = (value: number) => value.toLocaleString('en-US');
const pixels = (size: Size) => `가로 ${count(size.width)} × 세로 ${count(size.height)} 화소`;

export const strings = {
  // 짧은 결과(팝업의 작업 칸, 배지의 제목, 페이지 위 안내).
  saved: (folder: string, name: string) => `다운로드 폴더의 ${folder}에 ${name}로 저장했다.`,
  // Chrome이 저장할 곳을 물어 사용자가 다른 곳을 골랐다.
  savedElsewhere: (name: string) => `고른 곳에 ${name}로 저장했다.`,
  copied: '클립보드에도 복사했다.',
  tooBigToCopy: (size: Size, limit: number) =>
    `그림이 커서(${pixels(size)}) 클립보드에는 복사하지 않았다(${count(limit)} 화소까지 복사한다).`,
  copyFailed: '클립보드에는 복사하지 못했다.',
  partial: {
    'no-box': '화면 대부분을 차지하는 스크롤 상자를 찾지 못해 보이는 화면만 찍었다.',
    'box-stuck': '스크롤 상자를 펼쳐 이어 찍을 수 없어 보이는 화면만 찍었다.',
  },
  // 실패 이유.
  webPageOnly: '웹 페이지(http·https)에서만 찍을 수 있다.',
  tabGone: '찍을 탭이 없다.',
  tooLarge: (size: Size, side: number, area: number) =>
    `페이지가 너무 크다(${pixels(size)}). 한 변 ${count(side)}화소, 넓이 ${count(area)}화소까지 찍을 수 있다.`,
  pageChanged: '찍는 동안 페이지가 바뀌어 저장하지 않았다.',
  ended: {
    escape: 'Esc를 눌러 영역 고르기를 멈췄다.',
    'right-click': '오른쪽 클릭으로 영역 고르기를 멈췄다.',
    left: '페이지를 떠나 영역 고르기를 멈췄다.',
    timeout: '2분 안에 영역을 고르지 않아 멈췄다.',
    error: '영역을 고르는 화면이 예상하지 못한 오류로 멈췄다.',
  } satisfies Record<SelectionEnd, string>,
  debuggerCancelled: '디버깅 안내 막대에서 취소해 캡처를 멈췄다.',
  debuggerClosed: '찍는 동안 페이지가 바뀌거나 탭이 닫혀 캡처를 멈췄다.',
  aborted: '캡처를 멈췄다.',
  answerShape: '페이지에 넣은 스크립트의 답 모양이 틀리다.',
  pageSlow: '페이지가 제때 답하지 않아 캡처를 멈췄다. 페이지가 바쁘면 잠시 뒤 다시 한다.',
  unexpected: '캡처 중에 예상하지 못한 오류가 났다.',
  shotShape: '디버거가 준 그림의 모양이 틀리다.',
  metricsShape: '디버거가 준 페이지 확대 정보의 모양이 틀리다.',
  composeFailed: '찍은 그림을 이어 붙이지 못했다.',
  // 영역을 고르는 화면의 안내(페이지 위).
  hint: '끌어서 찍을 영역을 고른다. Esc나 오른쪽 클릭은 취소.',
  hintTooSmall: '영역이 너무 작다. 더 크게 끌어서 고른다.',
  // 끄는 동안 고른 네모 밑의 크기 표시. 저장될 그림의 화소 크기라 결과와 "…화소" 안내와 같은 단위다(사용자, 2026-10-22).
  selectionSize: (size: Size) => `${count(size.width)} × ${count(size.height)}`,
};
