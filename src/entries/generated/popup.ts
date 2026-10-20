// 이 파일은 scripts/generate.ts가 기능 목록(src/features/list.ts)에서 만든다. 손으로 고치지 않는다.
// 기능을 더하거나 뺀 뒤 `pnpm generate`를 실행한다.
import type { FeatureUiPart } from '../../ui/index.ts';
import { ui as chatgptWidth } from '../../features/chatgpt-width/ui.tsx';
import { ui as claudeWidth } from '../../features/claude-width/ui.tsx';

export const uiParts: readonly FeatureUiPart[] = [chatgptWidth, claudeWidth];
