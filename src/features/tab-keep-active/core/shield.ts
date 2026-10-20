// 격리된 쪽(page.ts)과 페이지 쪽 방패(main.ts)가 주고받는 문서의 DOM 이벤트(아키텍처 4장 "페이지 쪽 ↔ 격리된 쪽", 결정 0041).
// 내용은 JSON 문자열 하나다. 웹 페이지도 같은 이벤트를 보내고 들을 수 있으므로 받는 쪽은 모양을 보고, 맞지 않으면 버린다. 웹
// 페이지가 흉내 내도 그 페이지의 방패가 켜지거나 꺼질 뿐이다(N-16과 같은 까닭으로 받아들인다).

// 격리된 쪽 → 페이지 쪽: 이 문서의 방패를 켜거나 끈다.
export const armEventName = 'browser-toolbox:keep-active';
// 페이지 쪽 → 격리된 쪽: 방패가 켜진 동안 이 문서가 실제로 숨김이 되었거나 다시 보인다(페이지에는 숨긴 바뀜).
export const nativeEventName = 'browser-toolbox:keep-active-native';

// 받는 쪽이 읽는 내용의 한도(글자 수).
const detailLimit = 64;

function parse(detail: unknown, key: string): boolean | null {
  if (typeof detail !== 'string' || detail.length > detailLimit) return null;
  let value: unknown;
  try {
    value = JSON.parse(detail);
  } catch {
    // 웹 페이지가 보낸 다른 글이다. 버린다.
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const field: unknown = Reflect.get(value, key);
  return typeof field === 'boolean' ? field : null;
}

export const armDetail = (on: boolean) => JSON.stringify({ on });

// 켜기(참), 끄기(거짓). 모양이 맞지 않으면 null이다.
export const parseArm = (detail: unknown) => parse(detail, 'on');

export const nativeDetail = (hidden: boolean) => JSON.stringify({ hidden });

// 숨김(참), 보임(거짓). 모양이 맞지 않으면 null이다.
export const parseNative = (detail: unknown) => parse(detail, 'hidden');
