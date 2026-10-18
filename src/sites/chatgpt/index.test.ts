import { describe, expect, it } from 'vitest';
import { composer, expectedElements, thread } from './index.ts';

describe('chatgpt.com의 화면마다 있어야 할 요소(결정 0031)', () => {
  const at = (pathname: string) => expectedElements({ pathname }).map((element) => element.id);

  it('새 대화 화면에는 작성란만 있다(대화 열은 메시지를 보내야 생긴다)', () => {
    expect(at('/')).toEqual([composer.id]);
  });

  it('대화 화면에는 대화 열과 작성란이 있다', () => {
    for (const pathname of [
      '/uc/6ad475f9-7114-83ea-8096-1cb8cc2a5ece',
      '/c/6ad475f9-7114-83ea-8096-1cb8cc2a5ece',
      '/c/abc/',
      '/g/g-p-123-project/c/abc',
      '/g/g-abc-name/c/abc',
    ]) {
      expect(at(pathname), pathname).toEqual([thread.id, composer.id]);
    }
  });

  it('있어야 할지 모르는 화면에서는 찾지 않는다', () => {
    for (const pathname of [
      '/gpts',
      '/library',
      '/c',
      '/c/',
      '/c/abc/extra',
      '/g/g-abc',
      '/cc/abc',
    ]) {
      expect(at(pathname), pathname).toEqual([]);
    }
  });

  it('요소의 이름은 사람이 알아볼 이름이다(COM-6 기대 동작 1)', () => {
    expect([thread.name, composer.name]).toEqual(['ChatGPT 대화 열', 'ChatGPT 작성란']);
    expect([thread.id, composer.id]).toEqual(['chatgpt.thread', 'chatgpt.composer']);
  });
});
