import { describe, expect, it } from 'vitest';
import { type Category, defineFeature, v } from '../contracts/index.ts';
import { categoryIndexAfterKey, visibleCategories } from './categories.ts';

function featureIn(id: string, category: Category) {
  return defineFeature({
    id,
    requirements: [],
    name: id,
    description: '시험용',
    category,
    kind: 'toggle',
    content: null,
    permissions: [],
    settings: { schema: v.object({ enabled: v.boolean() }), defaults: { enabled: false } },
  });
}

describe('결정 0023 보이는 범주', () => {
  it('기능이 있는 범주만 요구사항 묶음의 순서로 보인다(기능 목록의 순서와 상관없다)', () => {
    const features = [
      featureIn('c', 'chatgpt'),
      featureIn('a', 'media'),
      featureIn('p', 'page'),
      featureIn('b', 'media'),
    ];
    expect(visibleCategories(features)).toEqual(['media', 'page', 'chatgpt']);
  });

  it('기능이 없으면 범주도 없다', () => {
    expect(visibleCategories([])).toEqual([]);
  });
});

describe('COM-2.2 범주 목록의 키', () => {
  it('아래·위는 다음·이전 범주이고 끝에서는 반대쪽 끝으로 간다', () => {
    expect(categoryIndexAfterKey('ArrowDown', 0, 3)).toBe(1);
    expect(categoryIndexAfterKey('ArrowDown', 2, 3)).toBe(0);
    expect(categoryIndexAfterKey('ArrowUp', 1, 3)).toBe(0);
    expect(categoryIndexAfterKey('ArrowUp', 0, 3)).toBe(2);
  });

  it('Home·End는 처음·끝 범주다', () => {
    expect(categoryIndexAfterKey('Home', 2, 3)).toBe(0);
    expect(categoryIndexAfterKey('End', 0, 3)).toBe(2);
  });

  it('범주가 하나면 어느 키든 그 범주에 머문다', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
      expect(categoryIndexAfterKey(key, 0, 1)).toBe(0);
    }
  });

  it('그 밖의 키는 초점을 옮기지 않는다', () => {
    for (const key of ['ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Tab', 'k']) {
      expect(categoryIndexAfterKey(key, 1, 3)).toBeNull();
    }
  });
});
