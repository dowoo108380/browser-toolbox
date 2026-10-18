import { describe, expect, it } from 'vitest';
import {
  type FeatureDefinition,
  type TabStatus,
  type UnmetReason,
  defineFeature,
  v,
} from '../contracts/index.ts';
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
    settings: { schema: v.object({ enabled: v.boolean() }), defaults: { enabled: false } },
  });
}

const onPages = featureWith({ sites: 'all', frames: 'all' });
const offPages = featureWith(null);

const onChatgpt = featureWith({ sites: 'chatgpt', frames: 'top' });

const ready: TabStatus = { page: 'ready', bundle: 'common', unmet: [] };
const readyOnChatgpt: TabStatus = { page: 'ready', bundle: 'chatgpt', unmet: [] };
const denied: TabStatus = { page: 'denied' };
const reload: TabStatus = { page: 'reload' };
const unmet = (
  featureId: string,
  reason: UnmetReason = 'not-found',
  bundle: 'common' | 'chatgpt' = 'common',
): TabStatus => ({
  page: 'ready',
  bundle,
  unmet: [{ featureId, reason, element: { id: 'chatgpt.thread', name: 'ChatGPT 대화 열' } }],
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
    for (const tab of [ready, reload, denied, unmet('sample'), null]) {
      expect(unavailableReason(offPages, tab)).toBeNull();
    }
  });
});

describe('결정 0026 결정 0034 지금 탭에서 외부 화면에 기대한 것이 어긋난 기능', () => {
  it('COM-6 기대 동작 2 그 기능이 찾지 못한 요소의 이름을 "찾지 못함: (이름)"으로 보인다', () => {
    expect(unavailableReason(onPages, unmet('sample'))).toBe('찾지 못함: ChatGPT 대화 열');
  });

  it('COM-6 기대 동작 5 그 기능이 건 변경이 작용하지 않은 요소의 이름을 "적용되지 않음: (이름)"으로 보인다', () => {
    expect(unavailableReason(onPages, unmet('sample', 'not-applied'))).toBe(
      '적용되지 않음: ChatGPT 대화 열',
    );
  });

  it('다른 기능이 어긋난 것은 이 기능의 이유가 아니다', () => {
    expect(unavailableReason(onPages, unmet('other'))).toBeNull();
    expect(unavailableReason(onPages, unmet('other', 'not-applied'))).toBeNull();
  });
});

describe('결정 0029 사이트 전용 기능', () => {
  it('COM-2 기대 동작 4 그 사이트의 묶음이 실리지 않은 탭에서는 그 사이트에서만 쓸 수 있다고 보인다', () => {
    expect(unavailableReason(onChatgpt, ready)).toBe('쓸 수 없음: chatgpt.com에서만 쓸 수 있음');
  });

  it('그 사이트의 탭에서는 이유가 없고, 찾지 못한 요소가 있으면 그것을 보인다', () => {
    expect(unavailableReason(onChatgpt, readyOnChatgpt)).toBeNull();
    expect(unavailableReason(onChatgpt, unmet('sample', 'not-found', 'chatgpt'))).toBe(
      '찾지 못함: ChatGPT 대화 열',
    );
  });

  it('접근할 수 없는 탭과 새로 고쳐야 하는 탭은 그 이유가 먼저다', () => {
    expect(unavailableReason(onChatgpt, denied)).toBe(
      '쓸 수 없음: 확장이 이 페이지에 접근할 수 없음',
    );
    expect(unavailableReason(onChatgpt, reload)).toBe('쓸 수 없음: 이 탭을 새로 고쳐야 쓸 수 있음');
  });

  it('모든 사이트의 기능은 사이트 묶음의 탭에서도 쓸 수 있다', () => {
    expect(unavailableReason(onPages, readyOnChatgpt)).toBeNull();
  });
});
