import * as z from 'zod/mini';
import { defineFeature } from '../../contracts/index.ts';

// 05단계 뼈대에서는 배속 표시창만 있다. 배속 조절, 단축키, 탭 배속 복원은 06단계에서 더한다.
const settingsSchema = z.object({
  enabled: z.boolean(),
});

export const mediaSpeed = defineFeature({
  id: 'media-speed',
  requirements: ['MED-1', 'MED-2', 'MED-3', 'MED-4'],
  name: '미디어 배속',
  description: '영상 위에 지금 배속을 보여 준다.',
  category: 'media',
  kind: 'toggle',
  // 모든 http·https 페이지의 모든 프레임에 있는 미디어가 대상이다(MED 머리말).
  content: { sites: 'all', frames: 'all' },
  permissions: [],
  // 처음 설치하면 꺼져 있다(COM-1 기대 동작 2).
  settings: { schema: settingsSchema, defaults: { enabled: false } },
});
