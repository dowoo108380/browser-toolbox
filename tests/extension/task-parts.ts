import type { TaskPart } from '../../src/background/index.ts';
import { taskParts as productParts } from '../../src/entries/generated/sw.ts';
import { fixtureParts } from './fixture-tasks.ts';

// 시험 빌드의 서비스 워커 등록 목록(결정 0025): 제품의 목록에 시험 기능의 일을 덧붙인 것.
export const taskParts: readonly TaskPart[] = [...productParts, ...fixtureParts];
