import type { Category, Site } from '../contracts/index.ts';

// 팝업의 문구(결정 0007). 기능의 이름과 설명은 기능 정의에 있다. 상태 문구는 모든 화면에서 같다(quality 018).

export const strings = {
  loading: '설정을 읽는 중이다.',
  on: '켜짐',
  off: '꺼짐',
  categoriesLabel: '범주',
  searchLabel: '기능 검색',
  searchPlaceholder: '기능 검색(Ctrl+K)',
  searchResultsLabel: '검색 결과',
  noResults: '맞는 기능이 없다.',
  // 지금 탭에서 쓸 수 없는 기능의 이유(quality 018, 026). '쓸 수 없음'은 모든 화면에서 같은 상태 문구다.
  unavailable: (reason: string) => `쓸 수 없음: ${reason}`,
  pageDenied: '확장이 이 페이지에 접근할 수 없음',
  pageReload: '이 탭을 새로 고쳐야 쓸 수 있음',
  // 사이트 전용 기능을 다른 사이트에서 열었을 때(결정 0029).
  siteOnly: {
    chatgpt: 'chatgpt.com에서만 쓸 수 있음',
  } satisfies Record<Site, string>,
  // 기능이 외부 화면에 기대한 것이 어긋났다(COM-6, 용어집). 둘 다 모든 화면에서 같은 상태 문구다.
  // 찾지 못함: 기능이 기대는 외부 화면 요소를 제한 시간 안에 찾지 못했다.
  notFound: (elementName: string) => `찾지 못함: ${elementName}`,
  // 적용되지 않음: 기능이 찾은 요소에 건 변경이 제한 시간 안에 작용하지 않았다(결정 0034).
  notApplied: (elementName: string) => `적용되지 않음: ${elementName}`,
  noCurrentTab: '지금 탭을 알 수 없어 기능을 쓸 수 있는지 확인하지 못했다.',
  categories: {
    media: '미디어',
    youtube: 'YouTube',
    subtitles: '자막',
    tabs: '탭',
    page: '페이지',
    chatgpt: 'ChatGPT',
  } satisfies Record<Category, string>,
  repairLabel: '설정 복구 알림',
  repairWhole: '저장된 설정을 읽을 수 없어 모든 설정을 기본값으로 바꿨다.',
  repairFeatures: (names: string) =>
    `다음 기능의 저장된 설정을 읽을 수 없어 기본값으로 바꿨다: ${names}.`,
  // 사이트 이름 뒤 괄호의 기능만 바꿨다. 괄호가 없으면 그 사이트의 설정 전부다.
  repairSites: (items: string) =>
    `다음 사이트의 저장된 설정을 읽을 수 없어 기본값으로 바꿨다: ${items}.`,
  siteItem: (host: string, featureName: string | null) =>
    featureName === null ? host : `${host}(${featureName})`,
  repairConfirm: '확인',
  newer:
    '더 새 버전의 확장이 저장한 설정이라 이 버전에서는 기능을 쓸 수 없다. 새 버전을 다시 설치한다.',
  // 이 탭의 작업(COM-10, 결정 0024). 실패 이유와 짧은 결과는 서비스 워커와 기능이 만든 글이다.
  taskRunning: (name: string) => `${name}: 진행 중이다.`,
  taskSucceeded: (name: string, summary: string | null) =>
    summary === null ? `${name}: 끝났다.` : `${name}: 끝났다. ${summary}`,
  taskFailed: (name: string, reason: string) => `${name}: 실패했다. ${reason}`,
  taskCancelled: (name: string, reason: string) => `${name}: 취소했다. ${reason}`,
  // 다른 실행 기능이 쓸 수 없는 이유(COM-10.7). '쓸 수 없음:' 뒤에 붙는다.
  runningHere: (name: string) => `이 탭에서 ${name} 진행 중`,
};
