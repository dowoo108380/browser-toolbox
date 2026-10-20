import type { TabTogglePart, TaskPart } from '../../src/background/index.ts';
import {
  taskParts as productParts,
  tabToggleParts as productTabToggleParts,
} from '../../src/entries/generated/sw.ts';
import { fixtureParts } from './fixture-tasks.ts';

// 시험 빌드의 서비스 워커 등록 목록(결정 0025): 제품의 목록에 시험 기능의 일을 덧붙인 것. 탭마다 켜고 끄는 기능의 일은 제품의
// 것 그대로다.
export const taskParts: readonly TaskPart[] = [...productParts, ...fixtureParts];
export const tabToggleParts: readonly TabTogglePart[] = productTabToggleParts;
