import { describe, expect, it } from 'vitest';
import { isWebPage } from './web-page.ts';

describe('웹 페이지(TAB-2 기대 동작 11)', () => {
  it.each([
    'https://example.com/',
    'http://127.0.0.1:4173/page.html',
    'https://chrome.google.com/search',
    'https://www.google.com/webstore',
  ])('http·https 주소는 웹 페이지다: %s', (url) => {
    expect(isWebPage(url)).toBe(true);
  });

  it.each([
    'chrome://newtab/',
    'chrome://extensions/',
    'chrome-extension://abc/popup.html',
    'file:///C:/a.html',
    'about:blank',
    'https://chromewebstore.google.com/detail/x',
    'https://chrome.google.com/webstore',
    'https://chrome.google.com/webstore/detail/x',
    '잘못된 주소',
  ])('웹 페이지가 아니다: %s', (url) => {
    expect(isWebPage(url)).toBe(false);
  });

  it('주소를 모르면 웹 페이지가 아니다', () => {
    expect(isWebPage(undefined)).toBe(false);
  });
});
