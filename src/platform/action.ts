// 확장 아이콘(chrome.action)의 탭마다의 배지와 제목(COM-10, 결정 0024). 탭마다 단 값은 그 탭이 다른 문서로 이동하면
// Chrome이 지운다(결정 0024의 실험 1). 그래서 부르는 쪽이 이동 때 다시 단다.

export interface TabBadge {
  // 배지 글자. 네 글자 남짓만 보인다.
  readonly text: string;
  // 배지 바탕색(#rrggbb). 글자는 흰색이다.
  readonly color: string;
  // 아이콘의 제목(마우스를 올리면 보이고 화면 낭독기가 읽는 이름).
  readonly title: string;
}

// manifest의 기본 제목(action.default_title). getManifest의 타입은 모든 값이 any라 모양을 확인한다.
function defaultTitle(): string {
  const action: unknown = chrome.runtime.getManifest()['action'];
  if (typeof action !== 'object' || action === null) return '';
  const title: unknown = Reflect.get(action, 'default_title');
  return typeof title === 'string' ? title : '';
}

// 닫힌 탭이면 Chrome이 "No tab with id: …"로 거절한다(결정 0024의 실험 3).
function isClosedTab(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('No tab with id');
}

// 그 탭에 배지와 제목을 단다. null이면 배지를 지우고 제목을 manifest의 기본 제목으로 돌린다. 닫힌 탭이면 할 일이 없다.
// 그 밖의 실패는 던진다.
export async function setTabBadge(tabId: number, badge: TabBadge | null): Promise<void> {
  try {
    if (badge === null) {
      await chrome.action.setBadgeText({ tabId, text: '' });
      await chrome.action.setTitle({ tabId, title: defaultTitle() });
      return;
    }
    await chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color });
    await chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' });
    await chrome.action.setBadgeText({ tabId, text: badge.text });
    await chrome.action.setTitle({ tabId, title: badge.title });
  } catch (error) {
    if (!isClosedTab(error)) throw error;
  }
}
