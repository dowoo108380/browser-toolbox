import type { FeatureDefinition } from '../../src/contracts/index.ts';
import { features as productFeatures } from '../../src/features/list.ts';
import { fixtureOther, fixtureTask } from './fixture-tasks.ts';

// 시험 빌드의 기능 목록(결정 0025): 제품의 기능 목록에 시험 기능을 덧붙인 것. 빌드가 진입점의 기능 목록을 이것으로 바꾼다.
export const features: readonly FeatureDefinition[] = [
  ...productFeatures,
  fixtureTask,
  fixtureOther,
];
