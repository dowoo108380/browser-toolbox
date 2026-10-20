import { describe, expect, it } from 'vitest';
import { composer, contentWidthCss, expectedElements, thread } from './index.ts';

describe('claude.ai의 대화 열·작성란 너비 규칙(결정 0040)', () => {
  it('CLD-1.1 CLD-1.3 대화 화면은 사이트의 열 너비 변수를, 새 채팅 화면은 작성란 자리와 그 틀의 최대 너비를 쓴다', () => {
    expect(contentWidthCss(1000).split('\n')).toEqual([
      '* { --transcript-width: 1000px !important; }',
      '[data-chorus-card-slot] { max-width: 1000px !important; }',
      ':has(> [data-chorus-card-slot]) { max-width: max(var(--container-7xl, 80rem), calc(1000px + 7rem)) !important; }',
    ]);
  });
});

describe('claude.ai의 화면마다 있어야 할 요소(결정 0040)', () => {
  const at = (pathname: string) => expectedElements({ pathname }).map((element) => element.id);

  it('새 채팅 화면에는 작성란만 있다(대화 열은 메시지를 보내야 생긴다)', () => {
    expect(at('/new')).toEqual([composer.id]);
  });

  it('대화 화면에는 대화 열과 작성란이 있다', () => {
    for (const pathname of ['/chat/6ad475f9-7114-43ea-8096-1cb8cc2a5ece', '/chat/abc/']) {
      expect(at(pathname), pathname).toEqual([thread.id, composer.id]);
    }
  });

  it('있어야 할지 모르는 화면에서는 찾지 않는다', () => {
    for (const pathname of [
      '/',
      '/new/',
      '/recents',
      '/projects',
      '/project/abc',
      '/chat',
      '/chat/',
      '/chat/abc/extra',
      '/chats/abc',
    ]) {
      expect(at(pathname), pathname).toEqual([]);
    }
  });

  it('요소의 이름은 사람이 알아볼 이름이다(COM-6 기대 동작 1)', () => {
    expect([thread.name, composer.name]).toEqual(['Claude 대화 열', 'Claude 작성란']);
    expect([thread.id, composer.id]).toEqual(['claude.thread', 'claude.composer']);
  });
});
