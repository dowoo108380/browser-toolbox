import { describe, expect, it } from 'vitest';
import { type Category, defineFeature, v } from '../contracts/index.ts';
import { isSearchShortcut, searchFeatures, searchKeyAction } from './search.ts';

function featureIn(id: string, category: Category, name: string, description: string) {
  return defineFeature({
    id,
    requirements: [],
    name,
    description,
    category,
    kind: 'toggle',
    content: null,
    permissions: [],
    settings: { schema: v.object({ enabled: v.boolean() }), defaults: { enabled: false } },
  });
}

const features = [
  featureIn('notice', 'youtube', '배속 변경 알림', 'YouTube에서 배속을 바꾸면 알린다.'),
  featureIn('speed', 'media', '미디어 배속', '영상 위에 지금 배속을 보여 준다.'),
  featureIn('width', 'chatgpt', 'ChatGPT Width', '대화 열 너비를 넓힌다.'),
  featureIn('capture', 'page', '전체 캡처', '페이지 전체를 그림으로 저장한다.'),
];

const ids = (query: string) => searchFeatures(features, query).map((feature) => feature.id);

describe('COM-2.1 기능 검색', () => {
  it('이름이나 설명에 검색어가 들어간 기능만 범주 순서로 돌려준다', () => {
    // 미디어가 YouTube보다 앞 범주다. 기능 목록의 순서와 상관없다.
    expect(ids('배속')).toEqual(['speed', 'notice']);
    expect(ids('너비')).toEqual(['width']);
  });

  it('대소문자를 가리지 않고 앞뒤 공백을 뺀다', () => {
    expect(ids('  chatgpt width ')).toEqual(['width']);
    expect(ids('YOUTUBE')).toEqual(['notice']);
  });

  it('검색어가 비거나 공백뿐이면 결과가 없다(범주 화면을 보인다)', () => {
    expect(ids('')).toEqual([]);
    expect(ids('   ')).toEqual([]);
  });

  it('맞는 기능이 없으면 빈 목록이다', () => {
    expect(ids('자막')).toEqual([]);
  });
});

describe('COM-2 기대 동작 3 검색 칸의 키', () => {
  const state = { composing: false, query: '배속', active: null, count: 3 };

  it('아래·위는 결과를 고르고, 끝에서는 반대쪽 끝으로 간다. 고른 것이 없으면 처음·끝에서 시작한다', () => {
    expect(searchKeyAction('ArrowDown', state)).toEqual({ kind: 'select', index: 0 });
    expect(searchKeyAction('ArrowUp', state)).toEqual({ kind: 'select', index: 2 });
    expect(searchKeyAction('ArrowDown', { ...state, active: 0 })).toEqual({
      kind: 'select',
      index: 1,
    });
    expect(searchKeyAction('ArrowUp', { ...state, active: 2 })).toEqual({
      kind: 'select',
      index: 1,
    });
    expect(searchKeyAction('ArrowDown', { ...state, active: 2 })).toEqual({
      kind: 'select',
      index: 0,
    });
    expect(searchKeyAction('ArrowUp', { ...state, active: 0 })).toEqual({
      kind: 'select',
      index: 2,
    });
  });

  it('Enter는 고른 결과로 가고, 고른 것이 없으면 첫 결과로 간다(COM-2.1)', () => {
    expect(searchKeyAction('Enter', state)).toEqual({ kind: 'go', index: 0 });
    expect(searchKeyAction('Enter', { ...state, active: 1 })).toEqual({ kind: 'go', index: 1 });
  });

  it('결과가 없으면 방향키와 Enter는 할 일이 없다', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter']) {
      expect(searchKeyAction(key, { ...state, count: 0 })).toBeNull();
    }
  });

  it('Esc는 검색어가 있으면 지우고, 없으면 할 일이 없다(Chrome의 기본 동작에 맡긴다)', () => {
    expect(searchKeyAction('Escape', state)).toEqual({ kind: 'clear' });
    expect(searchKeyAction('Escape', { ...state, query: ' ' })).toEqual({ kind: 'clear' });
    expect(searchKeyAction('Escape', { ...state, query: '', count: 0 })).toBeNull();
  });

  it('N-01 한글을 조합하는 중의 Enter·방향키·Esc는 조합을 끝내는 데 쓰이므로 할 일이 없다', () => {
    for (const key of ['Enter', 'ArrowDown', 'ArrowUp', 'Escape']) {
      expect(searchKeyAction(key, { ...state, composing: true })).toBeNull();
    }
  });

  it('그 밖의 키는 할 일이 없다', () => {
    for (const key of ['ArrowLeft', 'Tab', 'Home', 'a'])
      expect(searchKeyAction(key, state)).toBeNull();
  });
});

describe('COM-2.1 Ctrl+K', () => {
  const plain = { code: 'KeyK', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false };

  it('Ctrl+K만 검색 칸으로 가는 키다. 글자가 아니라 자판의 자리로 본다(한글 자판에서도 같다)', () => {
    expect(isSearchShortcut(plain)).toBe(true);
    expect(isSearchShortcut({ ...plain, ctrlKey: false })).toBe(false);
    expect(isSearchShortcut({ ...plain, shiftKey: true })).toBe(false);
    expect(isSearchShortcut({ ...plain, altKey: true })).toBe(false);
    expect(isSearchShortcut({ ...plain, metaKey: true })).toBe(false);
    expect(isSearchShortcut({ ...plain, code: 'KeyJ' })).toBe(false);
  });
});
