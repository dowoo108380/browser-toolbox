import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';
import { type FeatureDefinition, type TabStatus, defineFeature } from '../contracts/index.ts';
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

const ready: TabStatus = { page: 'ready', notFound: [] };
const denied: TabStatus = { page: 'denied' };
const reload: TabStatus = { page: 'reload' };
const missing = (featureId: string): TabStatus => ({
  page: 'ready',
  notFound: [{ featureId, element: { id: 'chatgpt.thread', name: 'ChatGPT 대화 열' } }],
});

describe('결정 0023 지금 탭에서 쓸 수 없는 이유', () => {
  it('COM-2.3 페이지에 작용하는 기능은 확장이 접근할 수 없는 탭에서 그 이유를 보인다', () => {
    expect(unavailableReason(onPages, denied)).toBe(
      '쓸 수 없음: 확장이 이 페이지에 접근할 수 없음',
    );
  });

  it('COM-7 기대 동작 2 실행 틀이 없는 탭은 새로 고쳐야 쓸 수 있다고 보인다', () => {
    expect(unavailableReason(onPages, reload)).toBe('쓸 수 없음: 이 탭을 새로 고쳐야 쓸 수 있음');
  });

  it('쓸 수 있거나 아직 모르면 이유가 없다', () => {
    expect(unavailableReason(onPages, ready)).toBeNull();
    expect(unavailableReason(onPages, null)).toBeNull();
  });

  it('페이지에 작용하지 않는 기능은 지금 탭과 상관없다', () => {
    for (const tab of [ready, reload, denied, missing('sample'), null]) {
      expect(unavailableReason(offPages, tab)).toBeNull();
    }
  });
});

describe('결정 0026 지금 탭에서 찾지 못한 외부 화면 요소', () => {
  it('COM-6 기대 동작 2 그 기능이 찾지 못한 요소의 이름을 "찾지 못함: (이름)"으로 보인다', () => {
    expect(unavailableReason(onPages, missing('sample'))).toBe('찾지 못함: ChatGPT 대화 열');
  });

  it('다른 기능이 찾지 못한 것은 이 기능의 이유가 아니다', () => {
    expect(unavailableReason(onPages, missing('other'))).toBeNull();
  });
});
