// 격리된 쪽(page.ts)이 페이지 쪽 방패(main.ts)를 켜고 끄는 문서의 DOM 이벤트(아키텍처 4장 "페이지 쪽 ↔ 격리된 쪽", 결정 0041).
// 내용은 JSON 문자열 하나다. 웹 페이지도 같은 이벤트를 보내고 들을 수 있으므로 받는 쪽은 모양을 보고, 맞지 않으면 버린다. 웹
// 페이지가 흉내 내도 그 페이지의 방패가 켜지거나 꺼질 뿐이다(N-16과 같은 까닭으로 받아들인다). 방패가 막은 보임 바뀜을 확장에
// 알리는 것은 이 기능만의 것이 아니라 dom의 보임 알림이다(결정 0044).

// 격리된 쪽 → 페이지 쪽: 이 문서의 방패를 켜거나 끈다.
export const armEventName = 'browser-toolbox:keep-active';

// 받는 쪽이 읽는 내용의 한도(글자 수).
const detailLimit = 64;

export const armDetail = (on: boolean) => JSON.stringify({ on });

// 켜기(참), 끄기(거짓). 모양이 맞지 않으면 null이다.
export function parseArm(detail: unknown): boolean | null {
  if (typeof detail !== 'string' || detail.length > detailLimit) return null;
  let value: unknown;
  try {
    value = JSON.parse(detail);
  } catch {
    // 웹 페이지가 보낸 다른 글이다. 버린다.
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const on: unknown = Reflect.get(value, 'on');
  return typeof on === 'boolean' ? on : null;
}
