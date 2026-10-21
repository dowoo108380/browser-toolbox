// 캡처를 저장할 곳(PAGE-1 기대 동작 7, 사용자 2026-10-21): 다운로드 폴더 안의 하위 폴더와 YYYYMMDD_HHMMSS_사이트.png.

export type CaptureKind = 'full' | 'area';

const folders: Readonly<Record<CaptureKind, string>> = {
  full: 'full_page_screenshots',
  area: 'selected_area_screenshots',
};

// 이름에 쓰는 사이트의 글자 수.
const siteLength = 60;

const pad = (value: number, length: number) => String(value).padStart(length, '0');

// 호스트 이름에서 앞의 www.를 빼고, 영문·숫자가 아닌 글자를 _로 바꾼 것(60자까지).
export function siteOf(hostname: string): string {
  const name = hostname.startsWith('www.') ? hostname.slice('www.'.length) : hostname;
  return name.replace(/[^A-Za-z0-9]/g, '_').slice(0, siteLength);
}

// 그 시각(이 컴퓨터의 시각대)에 그 사이트에서 찍은 그 종류의 캡처의 경로(하위 폴더/이름).
export function capturePath(kind: CaptureKind, time: number, hostname: string): string {
  const at = new Date(time);
  const date = `${pad(at.getFullYear(), 4)}${pad(at.getMonth() + 1, 2)}${pad(at.getDate(), 2)}`;
  const clock = `${pad(at.getHours(), 2)}${pad(at.getMinutes(), 2)}${pad(at.getSeconds(), 2)}`;
  return `${folders[kind]}/${date}_${clock}_${siteOf(hostname)}.png`;
}
