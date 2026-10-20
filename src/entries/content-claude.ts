import { startContentScript } from './content.ts';
import { pageParts } from './generated/content-claude.ts';

// claude.ai의 모든 프레임에 실리는 콘텐츠 스크립트(아키텍처 2장, 결정 0029). 모든 사이트의 기능과 Claude 기능을 담는다.

startContentScript(pageParts, 'claude');
