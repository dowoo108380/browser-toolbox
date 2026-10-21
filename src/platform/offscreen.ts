import {
  type OffscreenRequest,
  clipboardSettleMs,
  offscreenAnswerSchema,
  offscreenChannelName,
  offscreenCopyImage,
  offscreenEnvelopeSchema,
  offscreenRevoke,
  offscreenSettle,
  offscreenUrl,
  v,
} from '../contracts/index.ts';
import { type AppError, type Result, appError, err, ok, withTimeout } from '../shared/index.ts';

// 오프스크린 문서(아키텍처 2장, 결정 0047). 서비스 워커가 할 수 없는 일(Blob 주소 만들기, 클립보드에 그림 쓰기)을 맡는다. 이
// 확장의 오프스크린 문서는 한 번에 하나이고, 언제 열고 닫을지는 서비스 워커의 저장·클립보드 서비스(background/files.ts)가
// 정한다. 서비스 워커 쪽(열기, 닫기, 요청)과 문서 쪽(serveOffscreen)이 이 파일에 있다. 둘 사이는 BroadcastChannel이다
// (contracts/offscreen.ts).

const documentPath = 'offscreen.html';

// 이미 열린 문서를 다시 만들려 하면 Chrome이 이 글로 거절한다(문서는 확장마다 하나다). 연 것으로 본다.
function isAlreadyOpen(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Only a single offscreen');
}

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

// 문서가 없으면 연다. createDocument는 문서를 다 실은 뒤에 끝나므로, 끝나면 문서가 채널을 듣고 있다.
export async function openOffscreenDocument(): Promise<Result<null, AppError>> {
  try {
    if (await hasOffscreenDocument()) return ok(null);
    await chrome.offscreen.createDocument({
      url: documentPath,
      reasons: ['BLOBS', 'CLIPBOARD'],
      justification: '캡처한 그림을 파일로 저장하고 클립보드에 복사한다.',
    });
    return ok(null);
  } catch (error) {
    if (isAlreadyOpen(error)) return ok(null);
    return err(appError('platform', '파일을 저장할 확장의 문서를 열지 못했다.'));
  }
}

// 문서가 있으면 닫는다. 닫으면 그 문서가 만든 Blob 주소도 모두 사라진다.
export async function closeOffscreenDocument(): Promise<Result<null, AppError>> {
  try {
    if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
    return ok(null);
  } catch {
    return err(appError('platform', '파일을 저장한 확장의 문서를 닫지 못했다.'));
  }
}

export type OffscreenRequester = <Kind extends string, Payload, Value>(
  definition: OffscreenRequest<Kind, Payload, Value>,
  payload: Payload,
  timeoutMs: number,
) => Promise<Result<Value, AppError>>;

// 서비스 워커가 오프스크린 문서에 요청하는 함수. 채널은 처음 요청할 때 열고 서비스 워커가 사는 동안 둔다. 답이 제한 시간 안에
// 오지 않으면 timeout이다(문서가 닫혔거나 아직 열리지 않았으면 아무도 답하지 않는다).
export function offscreenRequester(): OffscreenRequester {
  let channel: BroadcastChannel | null = null;
  const waiting = new Map<string, (result: unknown) => void>();
  const open = () => {
    if (channel !== null) return channel;
    const opened = new BroadcastChannel(offscreenChannelName);
    opened.addEventListener('message', (event) => {
      const envelope = v.safeParse(offscreenEnvelopeSchema, event.data);
      if (!envelope.success || envelope.output.type !== 'answer') return;
      waiting.get(envelope.output.id)?.(envelope.output.result);
    });
    channel = opened;
    return opened;
  };
  return async (definition, payload, timeoutMs) => {
    const sending = open();
    const id = crypto.randomUUID();
    const answered = new Promise<unknown>((resolve) => {
      waiting.set(id, resolve);
    });
    try {
      sending.postMessage({ type: 'request', id, kind: definition.kind, payload });
      const result = await withTimeout(timeoutMs, () => answered);
      if (!result.done) {
        return err(appError('timeout', '확장의 문서가 답하지 않는다.'));
      }
      const parsed = v.safeParse(offscreenAnswerSchema(definition.value), result.value);
      if (!parsed.success) return err(appError('unexpected', '확장의 문서의 답 모양이 틀리다.'));
      return parsed.output.ok ? ok(parsed.output.value) : err(parsed.output.error);
    } finally {
      waiting.delete(id);
    }
  };
}

// 그림 문서를 싣고 그림을 바꿔 싣기를 기다리는 한도. 그림은 Blob을 읽어 곧 싣는다(2026-10-21 실험: 268M 화소도 2초 남짓).
const imageDocumentTimeoutMs = 20_000;

// 그림 문서로 여는 이 확장의 빈 그림(1×1 투명 PNG, 빌드가 확장에 넣는다).
const imageDocumentPath = 'clipboard.png';

// 그것이 실리면 참, 실리지 못하면 거짓이다.
function loadedOf(target: HTMLIFrameElement | HTMLImageElement): Promise<boolean> {
  return new Promise((resolve) => {
    target.addEventListener(
      'load',
      () => {
        resolve(true);
      },
      { once: true },
    );
    target.addEventListener(
      'error',
      () => {
        resolve(false);
      },
      { once: true },
    );
  });
}

// iframe에 이 확장의 빈 그림을 그림 문서로 열고, 그 문서의 그림을 그 주소의 그림으로 바꿔 싣는다. 그 문서를 준다(못 하면 null).
async function imageDocumentOf(frame: HTMLIFrameElement, url: string): Promise<Document | null> {
  const opened = loadedOf(frame);
  frame.src = imageDocumentPath;
  document.body.append(frame);
  const image = (await opened) ? frame.contentDocument : null;
  // 그림 문서의 그림은 본문의 첫 요소다(Chromium editing_utilities.cc의 ImageElementFromImageDocument).
  const [element] = image?.images ?? [];
  if (image?.contentType !== 'image/png' || element === undefined) return null;
  if (image.body.firstChild !== element) return null;
  const shown = loadedOf(element);
  element.src = url;
  return (await shown) ? image : null;
}

// PNG 그림을 클립보드에 그림으로 복사한다(결정 0047). 오프스크린 문서는 초점을 가질 수 없어 navigator.clipboard.write가
// "Document is not focused"로 거절된다(Chromium clipboard_promise.cc, 2026-10-21 실험). 그림 문서(그림 주소를 연 문서)에서
// 고른 것 없이 복사하면 Chrome이 그 문서의 그림(본문의 첫 img)을 클립보드에 쓴다(Chromium clipboard_commands.cc의
// ExecuteCopy). 그래서 iframe에 그림 문서를 열고 그 문서에서 복사한다. 같은 확장의 출처라 그 문서를 다룰 수 있다.
// 그림 문서는 Blob 주소가 아니라 이 확장의 빈 그림으로 열고 그 img의 주소만 Blob으로 바꾼다. Chrome의 "낯선 사이트에서
// JavaScript 최적화 끄기"(V8 optimizer, 고급 세이프 브라우징과 실험으로 켜진다)는 blob: 주소를 낯선 곳으로 보고 그 iframe을
// 다른 프로세스에 띄워 문서에 닿을 수 없게 한다. chrome-extension:// 주소는 낯익은 곳이다(Chromium
// site_familiarity_fetcher.cc. 2026-10-21 실험: 실험 기능을 켠 Chromium에서 Blob 주소의 iframe은 문서가 null이었고 이 길은
// 복사됐다). 그림을 바꿔 싣는 것은 문서를 여는 것이 아니라 그 검사를 거치지 않는다.
// 클립보드에는 그림(PNG, 비트맵)과 함께 그 Blob 주소를 가리키는 HTML과 북마크가 들어간다(SystemClipboard::WriteImageWithTag).
// clipboardWrite 권한이 없으면 복사가 거짓이다. 그림 문서의 img에 decode()를 부르면 Chromium 156의 렌더러가 죽었다(같은
// 실험). 부르지 않는다. 복사한 그림 문서는 곧 거두지 않고 clipboardSettleMs 뒤에 거둔다(contracts/offscreen.ts). 답은 곧 한다.
async function copyImageInDocument(blob: Blob, title: string): Promise<boolean> {
  const url = URL.createObjectURL(blob);
  const frame = document.createElement('iframe');
  let copied = false;
  try {
    const opened = await withTimeout(imageDocumentTimeoutMs, () => imageDocumentOf(frame, url));
    const image = opened.done ? opened.value : null;
    if (image === null) return false;
    image.title = title;
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- 초점 없는 확장 문서가 클립보드에 그림을 쓰는 길이 이것뿐이다(결정 0047).
    copied = image.execCommand('copy');
    return copied;
  } finally {
    if (copied) {
      removeAfterSettle(frame, url);
    } else {
      frame.remove();
      URL.revokeObjectURL(url);
    }
  }
}

// 거두기를 기다리는 그림 문서들. 문서를 닫기 전에 다 거두기를 기다린다(offscreenSettle).
const settling = new Set<Promise<void>>();

function removeAfterSettle(frame: HTMLIFrameElement, url: string): void {
  const removed = new Promise<void>((resolve) => {
    setTimeout(() => {
      frame.remove();
      URL.revokeObjectURL(url);
      resolve();
    }, clipboardSettleMs);
  });
  settling.add(removed);
  void removed.then(() => settling.delete(removed));
}

// 오프스크린 문서 쪽: 채널의 요청을 받아 하고 답한다. 문서가 실릴 때 한 번 부른다(entries/offscreen.ts).
export function serveOffscreen(): void {
  const channel = new BroadcastChannel(offscreenChannelName);
  const answer = (id: string, result: Result<unknown, AppError>) => {
    channel.postMessage({ type: 'answer', id, result });
  };
  const handle = async (kind: string, payload: unknown): Promise<Result<unknown, AppError>> => {
    if (kind === offscreenUrl.kind) {
      const request = v.safeParse(offscreenUrl.payload, payload);
      if (!request.success) return err(appError('invalid-input', '요청 모양이 틀리다.'));
      return ok({ url: URL.createObjectURL(request.output.blob) });
    }
    if (kind === offscreenRevoke.kind) {
      const request = v.safeParse(offscreenRevoke.payload, payload);
      if (!request.success) return err(appError('invalid-input', '요청 모양이 틀리다.'));
      URL.revokeObjectURL(request.output.url);
      return ok(null);
    }
    if (kind === offscreenSettle.kind) {
      await Promise.all(settling);
      return ok(null);
    }
    const request = v.safeParse(offscreenCopyImage.payload, payload);
    if (!request.success) return err(appError('invalid-input', '요청 모양이 틀리다.'));
    return ok({ copied: await copyImageInDocument(request.output.blob, request.output.title) });
  };
  channel.addEventListener('message', (event) => {
    const envelope = v.safeParse(offscreenEnvelopeSchema, event.data);
    if (!envelope.success || envelope.output.type !== 'request') return;
    const { id, kind, payload } = envelope.output;
    handle(kind, payload).then(
      (result) => {
        answer(id, result);
      },
      () => {
        answer(id, err(appError('unexpected', '확장의 문서가 요청을 끝내지 못했다.')));
      },
    );
  });
}
