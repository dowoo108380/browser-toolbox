import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';
import { type FeatureDefinition, defineFeature } from '../contracts/index.ts';
import { unavailableReason } from './availability.ts';

function featureWith(content: FeatureDefinition['content']) {
  return defineFeature({
    id: 'sample',
    requirements: [],
    name: '시험 기능',
    description: '시험용',
    category: 'media',
    kind: 'toggle',
    content,
    permissions: [],
    settings: { schema: z.object({ enabled: z.boolean() }), defaults: { enabled: false } },
  });
}

const onPages = featureWith({ sites: 'all', frames: 'all' });
const offPages = featureWith(null);

describe('결정 0023 지금 탭에서 쓸 수 없는 이유', () => {
  it('COM-2.3 페이지에 작용하는 기능은 확장이 접근할 수 없는 탭에서 그 이유를 보인다', () => {
    expect(unavailableReason(onPages, 'denied')).toBe(
      '쓸 수 없음: 확장이 이 페이지에 접근할 수 없음',
    );
  });

  it('COM-7 기대 동작 2 실행 틀이 없는 탭은 새로 고쳐야 쓸 수 있다고 보인다', () => {
    expect(unavailableReason(onPages, 'reload')).toBe('쓸 수 없음: 이 탭을 새로 고쳐야 쓸 수 있음');
  });

  it('쓸 수 있거나 아직 모르면 이유가 없다', () => {
    expect(unavailableReason(onPages, 'ready')).toBeNull();
    expect(unavailableReason(onPages, null)).toBeNull();
  });

  it('페이지에 작용하지 않는 기능은 지금 탭과 상관없다', () => {
    for (const page of ['ready', 'reload', 'denied', null] as const) {
      expect(unavailableReason(offPages, page)).toBeNull();
    }
  });
});
