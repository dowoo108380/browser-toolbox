import { defineFeature, v } from '../../contracts/index.ts';
import { defaultWidth, maxWidth, minWidth } from './core/width.ts';

// 너비는 px 정수다. 범위를 넓히거나 필드를 바꾸면 설정 형식 버전을 올린다(아키텍처 6장, 결정 0021).
const settingsSchema = v.object({
  enabled: v.boolean(),
  width: v.pipe(v.int(), v.minValue(minWidth), v.maxValue(maxWidth)),
});

export const claudeWidth = defineFeature({
  id: 'claude-width',
  requirements: ['CLD-1'],
  name: '대화 열·작성란 너비',
  description: 'claude.ai의 대화 열과 작성란의 최대 너비를 정한 값으로 바꾼다.',
  category: 'claude',
  kind: 'toggle',
  // claude.ai의 최상위 문서에만 작용한다(결정 0029, 0040).
  content: { sites: 'claude', frames: 'top' },
  permissions: [],
  // 처음 설치하면 꺼져 있다(Claude 머리말).
  settings: { schema: settingsSchema, defaults: { enabled: false, width: defaultWidth } },
});
