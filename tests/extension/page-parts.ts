import { pageParts as productParts } from '../../src/entries/generated/content-common.ts';
import type { PagePart } from '../../src/page/index.ts';
import { fixtureElementPart } from './fixture-elements.ts';

// 시험 빌드의 콘텐츠 스크립트 등록 목록(결정 0025, 0026): 제품의 목록에 시험 기능의 페이지 쪽 일을 덧붙인 것.
export const pageParts: readonly PagePart[] = [...productParts, fixtureElementPart];
