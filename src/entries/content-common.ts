import { startContentScript } from './content.ts';
import { pageParts } from './generated/content-common.ts';

// 모든 http·https 페이지(사이트 묶음이 있는 사이트는 빼고)의 모든 프레임에 실리는 콘텐츠 스크립트(아키텍처 2장).

startContentScript(pageParts, 'common');
