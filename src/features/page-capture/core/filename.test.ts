import { describe, expect, it } from 'vitest';
import { capturePath, siteOf } from './filename.ts';

// 저장할 곳과 이름(PAGE-1 기대 동작 7, 사용자 2026-10-21).

describe('PAGE-1.19 저장할 곳', () => {
  // 이 컴퓨터의 시각대의 2026-10-21 09:05:07.
  const time = new Date(2026, 9, 21, 9, 5, 7).getTime();

  it('전체는 full_page_screenshots, 영역은 selected_area_screenshots 안에 YYYYMMDD_HHMMSS_사이트.png다', () => {
    expect(capturePath('full', time, 'www.example.com')).toBe(
      'full_page_screenshots/20261021_090507_example_com.png',
    );
    expect(capturePath('area', time, 'docs.example.com')).toBe(
      'selected_area_screenshots/20261021_090507_docs_example_com.png',
    );
  });

  it('사이트는 앞의 www.만 빼고 영문·숫자가 아닌 글자를 _로 바꿔 60자까지 쓴다', () => {
    expect(siteOf('www.example.com')).toBe('example_com');
    expect(siteOf('wwwexample.com')).toBe('wwwexample_com');
    expect(siteOf('shop.www.example.com')).toBe('shop_www_example_com');
    expect(siteOf('127.0.0.1')).toBe('127_0_0_1');
    expect(siteOf('xn--3e0b707e.kr')).toBe('xn__3e0b707e_kr');
    expect(siteOf('a-b_c.d')).toBe('a_b_c_d');
    expect(siteOf(`${'a'.repeat(70)}.com`)).toBe('a'.repeat(60));
  });
});
