import { retireEventName } from '../contracts/index.ts';
import { installShield } from '../features/tab-keep-active/main.ts';

// 페이지 활성 상태 유지의 페이지 쪽 방패(아키텍처 2장, 결정 0041). 페이지의 세계(MAIN)에서 모든 http·https 프레임에
// document_start로 실린다. 이 탭에서 켜졌다고 격리된 쪽이 알리기 전에는 아무것도 바꾸지 않는다.
installShield(window, Document.prototype, retireEventName);
