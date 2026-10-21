import { type AppError, type Result, appError, err, ok, withTimeout } from '../shared/index.ts';

// 다운로드(chrome.downloads, 결정 0047). 그 주소의 파일을 다운로드 폴더 안의 path(하위 폴더/이름)로 묻지 않고 저장한다. 같은
// 이름이 있으면 Chrome이 번호를 붙인다(uniquify, 2026-10-21 실험: "이름 (1).png"). Playwright나 CDP가 다운로드를 맡은
// 브라우저에서는 Chrome이 path를 쓰지 않고 주소의 이름으로 저장한다(같은 실험, R-11). 사용자의 Chrome은 그렇지 않다.
// 사용자가 Chrome 설정의 "다운로드 전에 각 파일의 저장 위치 확인"을 켰으면 Chrome이 saveAs: false여도 저장할 곳을 묻는다
// (Chromium download_target_determiner.cc: 그 설정이 확장의 다운로드에도 적용되고 확장은 끌 수 없다).

// 저장이 끝나기를 기다리는 한도. 확장의 문서에 있는 Blob을 디스크에 쓰는 시간과, 저장할 곳을 묻는 창에서 고르는 시간이다.
// 작업의 한도(캡처는 300초)보다 짧게 둔다.
const downloadTimeoutMs = 240_000;

const partsOf = (file: string) => file.split(/[\\/]/);

// 저장한 파일. name은 폴더를 뺀 이름(번호가 붙었으면 붙은 이름)이고, inFolder는 요청한 하위 폴더에 저장했는지다(저장할 곳을 묻는
// 창에서 다른 곳을 고르면 거짓). 폴더의 이름과 경로는 돌려주지 않는다(quality 082).
export interface SavedFile {
  readonly name: string;
  readonly inFolder: boolean;
}

// 다 저장되면 저장한 파일을 준다. 저장할 곳을 묻는 창에서 취소하면 cancelled이고, 그 밖에 중간에 멈추면(디스크가 가득 참 등)
// Chrome이 준 까닭의 이름을 붙여 platform으로 준다.
export async function downloadFile(
  url: string,
  path: string,
): Promise<Result<SavedFile, AppError>> {
  let target: number | null = null;
  let settle: (state: string) => void = () => undefined;
  const ended = new Promise<string>((resolve) => {
    settle = resolve;
  });
  // 끝남은 download()가 id를 주기 전에 올 수도 있어 먼저 듣고, id를 받은 뒤에는 지금 상태도 읽는다.
  const listener = (delta: chrome.downloads.DownloadDelta) => {
    const state = delta.state?.current;
    if (delta.id === target && state !== undefined && state !== 'in_progress') settle(state);
  };
  chrome.downloads.onChanged.addListener(listener);
  try {
    target = await chrome.downloads.download({
      url,
      filename: path,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    const id = target;
    const [now] = await chrome.downloads.search({ id });
    if (now !== undefined && now.state !== 'in_progress') settle(now.state);
    const state = await withTimeout(downloadTimeoutMs, () => ended);
    if (!state.done) return err(appError('timeout', '파일을 저장하는 데 너무 오래 걸렸다.'));
    const [item] = await chrome.downloads.search({ id });
    if (item?.error === 'USER_CANCELED') {
      return err(appError('cancelled', '저장할 곳을 묻는 창에서 취소해 저장하지 않았다.'));
    }
    if (state.value !== 'complete' || item === undefined) {
      const why = item?.error ?? '알 수 없음';
      return err(appError('platform', `파일을 저장하지 못했다(Chrome의 까닭: ${why}).`));
    }
    const saved = partsOf(item.filename);
    const asked = partsOf(path);
    return ok({
      name: saved.at(-1) ?? item.filename,
      inFolder: asked.length < 2 || saved.at(-2) === asked.at(-2),
    });
  } catch {
    return err(appError('platform', '파일을 저장하지 못했다.'));
  } finally {
    chrome.downloads.onChanged.removeListener(listener);
  }
}
