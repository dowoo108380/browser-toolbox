import type { FeatureDefinition } from '../contracts/index.ts';
import { chatgptWidth } from './chatgpt-width/feature.ts';
import { mediaSpeed } from './media-speed/feature.ts';

// 기능 목록. 한 줄에 기능 하나다(결정 0004). 빌드가 이것에서 manifest와 등록 목록을 만든다.
export const features: readonly FeatureDefinition[] = [mediaSpeed, chatgptWidth];
