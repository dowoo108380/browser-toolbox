import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 시험 페이지(tests/fixtures/)에는 실행 코드를 두지 않는다. 자바스크립트 계열은 TypeScript(strict)로만 써서
// 타입 검사와 린트를 거치게 한다(quality 054, 100). 페이지를 꾸미는 코드는 시험 쪽(page.evaluate, addInitScript 등)에 둔다.
// HTML은 타입 검사와 린트가 보지 않으므로 여기서 본다.

const fixtures = path.resolve(import.meta.dirname, '..', 'fixtures');

// HTML에서 스크립트가 도는 자리: script 요소, 이벤트 처리 속성(onclick 등), javascript: 주소.
function executableParts(html: string): string[] {
  const found: string[] = [];
  if (/<script\b/i.test(html)) found.push('script 요소');
  if (/<[^>]*\son[a-z]+\s*=/i.test(html)) found.push('이벤트 처리 속성');
  if (/javascript:/i.test(html)) found.push('javascript: 주소');
  return found;
}

describe('시험 페이지에는 실행 코드가 없다', () => {
  it('검사가 script 요소, 이벤트 처리 속성, javascript: 주소를 잡고 그 밖의 것은 잡지 않는다', () => {
    expect(executableParts('<body><script>run()</script></body>')).toEqual(['script 요소']);
    expect(executableParts('<SCRIPT type="module" src="a.js"></SCRIPT>')).toEqual(['script 요소']);
    expect(executableParts('<img src="a.png" onerror="run()">')).toEqual(['이벤트 처리 속성']);
    expect(executableParts('<div\n  onClick = "run()">')).toEqual(['이벤트 처리 속성']);
    expect(executableParts('<a href="javascript:run()">')).toEqual(['javascript: 주소']);
    expect(
      executableParts(
        '<!doctype html><title>one=1</title><style>video { width: 1px }</style><div data-on="x" id="one"></div>',
      ),
    ).toEqual([]);
  });

  const files = readdirSync(fixtures, { recursive: true, encoding: 'utf8' }).filter((file) =>
    file.endsWith('.html'),
  );

  it('tests/fixtures에 HTML 시험 페이지가 있다', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s', (file) => {
    expect(executableParts(readFileSync(path.join(fixtures, file), 'utf8'))).toEqual([]);
  });
});
