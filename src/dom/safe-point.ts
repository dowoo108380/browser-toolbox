// 가짜 입력을 보낼 안전한 곳(TAB-2 기대 동작 7, 결정 0041). 그 점에 있는 요소와 그 조상 중 어느 것도 링크, 버튼, 입력란(입력·
// 선택·편집 가능한 영역), 메뉴(메뉴 역할이거나 펼침 메뉴를 여는 요소)가 아니고, 마우스를 올리면 손 모양 커서가 되지 않으며,
// 영상·오디오·iframe이 차지한 영역 밖이다. 점은 최상위 문서의 보이는 영역 기준 CSS 픽셀이다(Input.dispatchMouseEvent의 좌표).
// 문서와 열린 shadow root를 따라간다. 닫힌 root 안은 그 host로 본다.

export interface Point {
  readonly x: number;
  readonly y: number;
}

// 1픽셀씩 번갈아 쓰는 두 점. 둘 다 안전해야 한다.
interface PointPair {
  readonly first: Point;
  readonly second: Point;
}

// 누르거나 입력받는 요소.
const controlTags = new Set(['button', 'input', 'select', 'textarea', 'option', 'summary']);
// 그 영역이 안전하지 않은 요소(영상·오디오·iframe과 그것을 담는 요소).
const mediaTags = new Set(['video', 'audio', 'iframe', 'frame', 'embed', 'object']);
const unsafeRoles = new Set([
  'link',
  'button',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'slider',
  'spinbutton',
]);

// 그 요소 자체가 안전하지 않은지(커서는 따로 본다).
function isControl(element: Element): boolean {
  const tag = element.localName;
  if ((tag === 'a' || tag === 'area') && element.hasAttribute('href')) return true;
  if (controlTags.has(tag) || mediaTags.has(tag)) return true;
  if (element instanceof HTMLElement && element.isContentEditable) return true;
  const role = element.getAttribute('role')?.trim().toLowerCase();
  if (role !== undefined && unsafeRoles.has(role)) return true;
  const popup = element.getAttribute('aria-haspopup');
  if (popup !== null && popup !== 'false') return true;
  // 펼치고 접는 요소(펼침 메뉴를 여는 단추 등).
  return element.hasAttribute('aria-expanded');
}

// 그 점에 그려진 가장 안쪽 요소. 열린 shadow root 안으로 들어간다.
function deepElementAt(document: Document, point: Point): Element | null {
  let element = document.elementFromPoint(point.x, point.y);
  while (element?.shadowRoot) {
    const inner = element.shadowRoot.elementFromPoint(point.x, point.y);
    if (inner === null || inner === element) break;
    element = inner;
  }
  return element;
}

// 요소와 그 조상(shadow root의 host를 거쳐).
function* ancestry(element: Element): Generator<Element> {
  for (let current: Element | null = element; current !== null;) {
    yield current;
    const root = current.getRootNode();
    current = current.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  }
}

// 영상·오디오·iframe이 차지한 영역(문서에 있는 것). 한 번 묻는 동안 같은 것을 쓴다.
function mediaAreas(document: Document): readonly DOMRect[] {
  return [...document.querySelectorAll([...mediaTags].join(','))].map((element) =>
    element.getBoundingClientRect(),
  );
}

const inside = (rect: DOMRect, point: Point) =>
  point.x >= rect.left && point.x < rect.right && point.y >= rect.top && point.y < rect.bottom;

function isSafe(document: Document, areas: readonly DOMRect[], point: Point): boolean {
  const { clientWidth, clientHeight } = document.documentElement;
  if (point.x < 0 || point.y < 0 || point.x >= clientWidth || point.y >= clientHeight) return false;
  if (areas.some((rect) => inside(rect, point))) return false;
  const element = deepElementAt(document, point);
  if (element === null) return false;
  const view = document.defaultView;
  for (const current of ancestry(element)) {
    if (isControl(current)) return false;
    if (view !== null && view.getComputedStyle(current).cursor === 'pointer') return false;
  }
  return true;
}

const pairAt = (point: Point): PointPair => ({
  first: point,
  second: { x: point.x + 1, y: point.y },
});

// 보이는 영역을 이만큼씩 나눈 격자의 점을 차례로 본다(마지막 위치를 모르거나 안전하지 않을 때).
const gridDivisions = 9;

// 안전한 두 점. keep(지난번에 쓴 두 점)이 아직 안전하면 그대로, 아니면 사용자가 마지막으로 마우스를 둔 곳(last)과 그 오른쪽 한
// 픽셀, 그것도 아니면 보이는 영역의 격자에서 처음 찾은 두 점이다. 없으면 null이다. 문서 전체를 되풀이해 훑지 않는다(묻는 때만,
// 정한 수의 점만 본다, quality 078).
export function safePair(
  document: Document,
  keep: PointPair | null,
  last: Point | null,
): PointPair | null {
  const areas = mediaAreas(document);
  const safe = (pair: PointPair) =>
    isSafe(document, areas, pair.first) && isSafe(document, areas, pair.second);
  if (keep !== null && safe(keep)) return keep;
  if (last !== null) {
    const rounded = { x: Math.round(last.x), y: Math.round(last.y) };
    for (const candidate of [pairAt(rounded), pairAt({ x: rounded.x - 1, y: rounded.y })]) {
      if (safe(candidate)) return candidate;
    }
  }
  const { clientWidth, clientHeight } = document.documentElement;
  for (let row = 1; row < gridDivisions; row += 1) {
    for (let column = 1; column < gridDivisions; column += 1) {
      const candidate = pairAt({
        x: Math.round((clientWidth * column) / gridDivisions),
        y: Math.round((clientHeight * row) / gridDivisions),
      });
      if (safe(candidate)) return candidate;
    }
  }
  return null;
}
