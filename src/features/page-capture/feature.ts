import { defineFeature } from '../../contracts/index.ts';

// 전체·영역 캡처(PAGE-1, 결정 0046–0048). 실행 기능이고 작업 종류가 둘이다. 페이지에는 누를 때만 스크립트를 넣는다(inject.ts).
// 설정이 없다(단축키도 두지 않는다, 사용자 2026-10-21).
export const pageCapture = defineFeature({
  id: 'page-capture',
  requirements: ['PAGE-1'],
  name: '캡처',
  description:
    '페이지 전체나 끌어서 고른 영역을 PNG로 다운로드 폴더에 저장하고 클립보드에도 복사한다.',
  category: 'page',
  kind: 'action',
  // 콘텐츠 스크립트의 실행 틀을 쓰지 않는다. 새로 고치기 전의 탭에서도 쓸 수 있다.
  content: null,
  injectedScript: true,
  // debugger: 전체와 화면보다 큰 영역 찍기. downloads, clipboardWrite: 저장과 복사(결정 0047). activeTab: 화면 안의 영역을 디버거
  // 없이 찍기(결정 0048).
  permissions: ['debugger', 'downloads', 'clipboardWrite', 'activeTab'],
  // 영역은 고르는 데 2분까지 기다린다(inject.ts). 전체는 큰 페이지에서 조각 수십 개와 이어 붙이기, 저장, 복사까지 1분 남짓이다
  // (2026-10-21 실험: 조각 하나 0.1–2.4초, 숨은 탭은 1.5초). 둘을 모두 덮게 둔다.
  task: { timeoutMs: 300_000 },
  actions: [
    { id: 'full', name: '전체 캡처' },
    { id: 'area', name: '영역 캡처' },
  ],
});
