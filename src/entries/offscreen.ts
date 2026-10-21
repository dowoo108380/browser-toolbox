import { serveOffscreen } from '../platform/index.ts';

// 오프스크린 문서(아키텍처 2장, 결정 0047). 서비스 워커의 저장·클립보드 서비스가 필요할 때 열고, 다 쓰면 닫는다.
serveOffscreen();
