// 이 파일은 scripts/generate.ts가 기능 목록(src/features/list.ts)에서 만든다. 손으로 고치지 않는다.
// 기능을 더하거나 뺀 뒤 `pnpm generate`를 실행한다.
import type { FeaturePagePart } from '../../page/index.ts';
import { page as mediaSpeed } from '../../features/media-speed/page.ts';
import { page as tabKeepActive } from '../../features/tab-keep-active/page.ts';

export const pageParts: readonly FeaturePagePart[] = [mediaSpeed, tabKeepActive];
