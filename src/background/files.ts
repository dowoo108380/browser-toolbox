import {
  clipboardSettleMs,
  offscreenCopyImage,
  offscreenRevoke,
  offscreenSettle,
  offscreenUrl,
} from '../contracts/index.ts';
import type { OffscreenRequester, SavedFile } from '../platform/index.ts';
import {
  type AppError,
  type Result,
  appError,
  createSerialQueue,
  err,
  ok,
} from '../shared/index.ts';
import type { Problem } from './problems.ts';
import { strings } from './strings.ts';

// 서비스 워커의 저장·클립보드 서비스(아키텍처 2장, 결정 0047). 파일 저장은 Blob 주소가, 클립보드의 그림은 초점 없는 문서의 그림
// 문서가 필요해 오프스크린 문서에 맡긴다. 오프스크린 문서는 확장마다 하나이므로 그 수명을 여기 한 곳에서 정한다: 쓰는 일이 있는
// 동안 열어 두고, 다 끝나면 닫는다(만든 Blob 주소도 함께 사라진다). 열기와 닫기는 들어온 차례대로 하나씩 한다. 그래서 한 일이
// 닫는 사이에 다른 일이 열어도 어긋나지 않는다. 닫기 전에 문서가 복사한 그림 문서를 다 거두기를 기다린다(offscreenSettle,
// clipboardSettleMs): 곧 닫으면 브라우저가 받던 클립보드 쓰기가 버려진다. 그동안 새 일이 오면 닫지 않는다.
// 문서를 연 채 서비스 워커가 멈추면 다음 서비스 워커가 시작할 때 기다리지 않고 닫는다(recover). 그 문서에는 사용자가 볼 상태가
// 없고, 쓰던 일은 앞 서비스 워커와 함께 끝났다(결정 0038의 차례: 문서를 쓰는 작업의 기록은 작업 실행이 남긴다). 서비스 워커는
// 보통 마지막 일에서 30초가 지나야 멈추므로 그 클립보드 쓰기도 그 전에 끝났다.

export interface FileService {
  // 그 Blob을 다운로드 폴더 안의 path(하위 폴더/이름)로 묻지 않고 저장한다. 같은 이름이 있으면 Chrome이 번호를 붙인다. 저장한
  // 파일(이름, 그 하위 폴더에 저장했는지)을 준다.
  readonly save: (blob: Blob, path: string) => Promise<Result<SavedFile, AppError>>;
  // PNG Blob을 클립보드에 그림으로 복사한다. title은 클립보드의 HTML에 들어가는 대체 글이다.
  readonly copyImage: (blob: Blob, title: string) => Promise<Result<null, AppError>>;
  // 서비스 워커가 시작할 때 앞 서비스 워커가 연 채 남긴 오프스크린 문서를 닫는다.
  readonly recover: () => Promise<void>;
}

export interface FileDeps {
  readonly openDocument: () => Promise<Result<null, AppError>>;
  readonly closeDocument: () => Promise<Result<null, AppError>>;
  readonly request: OffscreenRequester;
  // 그 주소의 파일을 다운로드 폴더 안의 path로 저장하고 저장한 파일을 준다(platform의 downloadFile).
  readonly download: (url: string, path: string) => Promise<Result<SavedFile, AppError>>;
  readonly record: (problem: Problem) => void;
}

// 오프스크린 문서의 답을 기다리는 한도. 주소 만들기와 거두기는 곧 끝나고, 그림 복사는 그림을 싣는 시간까지 든다(2026-10-21
// 실험: 268M 화소 2초 남짓).
const requestTimeoutMs = 5000;
const copyTimeoutMs = 30_000;
const settleTimeoutMs = clipboardSettleMs + requestTimeoutMs;

export function createFileService(deps: FileDeps): FileService {
  const enqueue = createSerialQueue();
  // 지금 문서를 쓰는 일의 수.
  let users = 0;
  // 이 서비스 워커가 문서를 열었고 아직 닫지 않았다. 열지 못했으면 기다릴 문서가 없다.
  let opened = false;

  const close = async () => {
    const closed = await deps.closeDocument();
    if (closed.ok) opened = false;
    else deps.record({ featureId: null, kind: closed.error.kind });
  };

  // 쓰는 일이 더 없으면 문서가 클립보드 쓰기를 끝내기를 기다려 닫는다. 기다리는 동안 새 일이 오면 닫지 않는다.
  const closeIfIdle = async () => {
    if (users > 0) return;
    if (opened) {
      const settled = await deps.request(offscreenSettle, null, settleTimeoutMs);
      if (!settled.ok) deps.record({ featureId: null, kind: settled.error.kind });
      if (users > 0) return;
    }
    await close();
  };

  // 문서를 열고 그 일을 한 뒤, 쓰는 일이 더 없으면 닫는다. 닫지 못해도 일의 결과는 그대로다(닫지 못한 것은 기록한다. 다음에 열
  // 때 그 문서를 그대로 쓰고, 다음 서비스 워커가 시작할 때 닫는다).
  const withDocument = async <T>(
    work: () => Promise<Result<T, AppError>>,
  ): Promise<Result<T, AppError>> => {
    users += 1;
    try {
      const open = await enqueue(async () => {
        const result = await deps.openDocument();
        if (result.ok) opened = true;
        return result;
      });
      if (!open.ok) return open;
      return await work();
    } finally {
      users -= 1;
      // 닫기는 기다리지 않는다. 문서가 클립보드 쓰기를 끝내기를 기다리는 동안 이 일의 결과를 붙잡지 않는다.
      enqueue(closeIfIdle).catch(() => {
        deps.record({ featureId: null, kind: 'unexpected' });
      });
    }
  };

  return {
    save: (blob, path) =>
      withDocument(async () => {
        const made = await deps.request(offscreenUrl, { blob }, requestTimeoutMs);
        if (!made.ok) return made;
        const saved = await deps.download(made.value.url, path);
        // 다 저장했으면 주소는 쓸 데가 없다. 거두지 못해도 문서를 닫으면 사라진다.
        const revoked = await deps.request(
          offscreenRevoke,
          { url: made.value.url },
          requestTimeoutMs,
        );
        if (!revoked.ok) deps.record({ featureId: null, kind: revoked.error.kind });
        return saved;
      }),
    copyImage: (blob, title) =>
      withDocument(async () => {
        const copied = await deps.request(offscreenCopyImage, { blob, title }, copyTimeoutMs);
        if (!copied.ok) return copied;
        return copied.value.copied ? ok(null) : err(appError('permission', strings.copyRefused));
      }),
    recover: async () => {
      await enqueue(async () => {
        if (users === 0) await close();
      });
    },
  };
}
