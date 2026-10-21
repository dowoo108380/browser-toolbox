import { responseSchema } from './messages.ts';
import * as v from './schema.ts';

// 서비스 워커와 오프스크린 문서 사이의 통로(아키텍처 4장, 결정 0047). 서비스 워커에는 URL.createObjectURL과 초점 있는 문서가
// 없어 Blob 주소 만들기와 클립보드 쓰기를 오프스크린 문서에 맡긴다(R-11, R-16). chrome.runtime의 메시지는 JSON이라 Blob을 싣지
// 못하고 64MiB를 넘지 못하므로(2026-10-21 실험: 63MiB는 되고 64MiB는 거절), 이 확장의 출처 안에서만 오가는 BroadcastChannel로
// 구조화 복제해 보낸다(300MB Blob이 바로 닿았다). 웹 페이지와 다른 확장은 이 이름의 채널에 닿지 않는다(출처마다 따로다).

export const offscreenChannelName = 'browser-toolbox:offscreen';

export interface OffscreenRequest<Kind extends string, Payload, Value> {
  readonly kind: Kind;
  readonly payload: v.Schema<Payload>;
  readonly value: v.Schema<Value>;
}

function defineOffscreenRequest<Kind extends string, Payload, Value>(
  definition: OffscreenRequest<Kind, Payload, Value>,
): OffscreenRequest<Kind, Payload, Value> {
  return definition;
}

// Blob의 주소를 만든다. 다운로드(chrome.downloads)가 그 주소에서 파일을 읽는다. 다 쓰면 거둔다(offscreenRevoke).
export const offscreenUrl = defineOffscreenRequest({
  kind: 'url',
  payload: v.object({ blob: v.blob() }),
  value: v.object({ url: v.string() }),
});

export const offscreenRevoke = defineOffscreenRequest({
  kind: 'revoke',
  payload: v.object({ url: v.string() }),
  value: v.null(),
});

// PNG 그림을 클립보드에 복사한다. title은 클립보드의 HTML에 들어가는 그림의 대체 글이다. Chrome이 허락하지 않으면(clipboardWrite
// 권한이 없음 등) copied가 거짓이다.
export const offscreenCopyImage = defineOffscreenRequest({
  kind: 'copyImage',
  payload: v.object({ blob: v.blob(), title: v.pipe(v.string(), v.maxLength(200)) }),
  value: v.object({ copied: v.boolean() }),
});

// 클립보드에 복사한 그림 문서를 거두기 전에 두는 시간. 복사한 그림은 그 그림 문서의 연결로 브라우저에 가는데, 그 문서를 곧
// 거두면 브라우저가 쓰기를 다 받기 전에 연결이 닫혀 클립보드에 아무것도 남지 않는다(Chromium ClipboardHostImpl의 소멸자가 끝나지
// 않은 쓰기를 버린다. 2026-10-21 실험: 곧 거두면 3번 모두 비었고, 10ms 두면 작은 그림은 남고 43M 화소는 비었고, 50ms 두면 43M
// 화소도 남았다). 브라우저가 쓰기를 끝냈는지 문서가 알 길은 클립보드 읽기 권한뿐이라, 실험에서 든 시간보다 넉넉히 둔다.
export const clipboardSettleMs = 2000;

// 복사한 그림 문서를 다 거두면(문서를 닫아도 되면) 답한다. 서비스 워커가 문서를 닫기 전에 묻는다. clipboardSettleMs 안에 답한다.
export const offscreenSettle = defineOffscreenRequest({
  kind: 'settle',
  payload: v.null(),
  value: v.null(),
});

const offscreenKinds = [
  offscreenUrl.kind,
  offscreenRevoke.kind,
  offscreenCopyImage.kind,
  offscreenSettle.kind,
] as const;

// 채널의 봉투. 요청은 서비스 워커가, 답은 오프스크린 문서가 보낸다. 같은 채널에 둘 다 오므로 type으로 가른다. 답의 result는
// 공용 메시지의 응답(결과 값)과 같은 모양이고, 요청한 쪽이 그 요청의 value로 검증한다.
export const offscreenEnvelopeSchema = v.union([
  v.object({
    type: v.literal('request'),
    id: v.string(),
    kind: v.picklist(offscreenKinds),
    payload: v.unknown(),
  }),
  v.object({ type: v.literal('answer'), id: v.string(), result: v.unknown() }),
]);

export function offscreenAnswerSchema<Value>(value: v.Schema<Value>) {
  return responseSchema(value);
}
