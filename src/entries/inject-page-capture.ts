import { installPageApi } from '../features/page-capture/inject.ts';

// 캡처의 페이지 쪽(결정 0046). 누를 때 서비스 워커가 그 탭의 최상위 문서의 확장의 격리된 세계에 넣는다.
installPageApi();
