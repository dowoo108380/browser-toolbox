import path from 'node:path';
import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

// 결정이 린터로 지키게 한 문법 제한(eslint.config.ts의 no-restricted-syntax)이 잡아야 할 것과 잡지 않아야 할 것.
// 실제 설정이 그 파일에 정한 no-restricted-syntax 규칙을 꺼내, 코드 조각에 그 규칙만 돌린다.

const root = path.resolve(import.meta.dirname, '..', '..');
const eslint = new ESLint({ cwd: root, flags: ['unstable_native_nodejs_ts_config'] });

interface Restriction {
  readonly selector: string;
  readonly message: string;
}

// 설정 값은 ESLint가 any로 주므로 모양을 확인하며 꺼낸다.
async function restrictionsFor(file: string): Promise<Restriction[]> {
  const config: unknown = await eslint.calculateConfigForFile(path.join(root, file));
  if (typeof config !== 'object' || config === null || !('rules' in config)) return [];
  const { rules } = config;
  if (typeof rules !== 'object' || rules === null || !('no-restricted-syntax' in rules)) return [];
  const entry: unknown = rules['no-restricted-syntax'];
  if (!Array.isArray(entry)) return [];
  const options: unknown[] = entry.slice(1);
  return options.flatMap((option) =>
    typeof option === 'object' &&
    option !== null &&
    'selector' in option &&
    typeof option.selector === 'string' &&
    'message' in option &&
    typeof option.message === 'string'
      ? [{ selector: option.selector, message: option.message }]
      : [],
  );
}

const isPageResource = (restriction: Restriction) => restriction.message.includes('결정 0014');

const linter = new Linter();

function reported(restrictions: readonly Restriction[], code: string): number {
  return linter.verify(
    code,
    [
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        rules: { 'no-restricted-syntax': ['error', ...restrictions] },
      },
    ],
    'sample.ts',
  ).length;
}

describe('결정 0014 페이지 쪽 자원 규칙', () => {
  const targets = [
    'src/features/media-speed/page.ts',
    'src/features/some-feature/page/part.ts',
    'src/sites/youtube/player.ts',
    'src/dom/isolated-host.ts',
  ];
  const others = [
    'src/dom/scope.ts',
    'src/dom/scope.dom.test.ts',
    'src/features/media-speed/page.dom.test.ts',
    'src/features/media-speed/feature.ts',
    'src/background/router.ts',
    'src/ui/popup-app.tsx',
  ];

  it.each(targets)('%s에 규칙이 걸린다', async (file) => {
    expect((await restrictionsFor(file)).filter(isPageResource)).not.toHaveLength(0);
  });

  it.each(others)('%s에는 규칙이 걸리지 않는다', async (file) => {
    expect((await restrictionsFor(file)).filter(isPageResource)).toHaveLength(0);
  });

  const mustReport = [
    "video.addEventListener('ratechange', f);",
    "addEventListener('resize', f);",
    'window.requestAnimationFrame(f);',
    'requestAnimationFrame(f);',
    'requestIdleCallback(f);',
    'setTimeout(f, 1);',
    'window.setTimeout(f, 1);',
    'setInterval(f, 1);',
    'queueMicrotask(f);',
    'window.queueMicrotask(f);',
    "window['setTimeout'](f, 1);",
    'const later = window.setTimeout.bind(window);',
    'new MutationObserver(f);',
    'new globalThis.MutationObserver(f);',
    'new window.ResizeObserver(f);',
    'new IntersectionObserver(f);',
    "new globalThis['MutationObserver'](f);",
  ];

  const mustNotReport = [
    "scope.listen(window, 'resize', f);",
    'scope.mutationObserver(f).observe(document, { childList: true });',
    "video.removeEventListener('ratechange', f);",
    "host.setAttribute('data-x', '1');",
  ];

  it.each(mustReport)('잡는다: %s', async (code) => {
    const restrictions = (await restrictionsFor(targets[0] ?? '')).filter(isPageResource);
    expect(reported(restrictions, code)).toBeGreaterThan(0);
  });

  it.each(mustNotReport)('잡지 않는다: %s', async (code) => {
    const restrictions = (await restrictionsFor(targets[0] ?? '')).filter(isPageResource);
    expect(reported(restrictions, code)).toBe(0);
  });
});

describe('quality 054 실행 코드를 문자열로 쓰지 않는다', () => {
  const isExecutableString = (restriction: Restriction) =>
    restriction.message.includes('quality 054, 100');

  it.each([
    'tests/e2e/reload.spec.ts',
    'tests/integration/retire-old-scripts.test.ts',
    'src/features/media-speed/page.ts',
    'src/background/router.ts',
  ])('%s에 규칙이 걸린다', async (file) => {
    expect((await restrictionsFor(file)).filter(isExecutableString)).not.toHaveLength(0);
  });

  it.each([
    ['잡는다', "document.createElement('script');", true],
    ['잡는다', "frame.contentDocument.createElement('SCRIPT');", true],
    ['잡는다', "page.evaluate('document.title');", true],
    ['잡는다', 'worker.evaluate(`${code}\\nrun()`);', true],
    ['잡는다', "page.evaluate('run(' + value + ')');", true],
    ['잡는다', "frame.evaluateHandle('window');", true],
    ['잡는다', "page.addInitScript('window.x = 1');", true],
    ['잡는다', "page.addInitScript({ content: 'window.x = 1' });", true],
    ['잡는다', "page.addScriptTag({ path: 'a.js' });", true],
    ['잡지 않는다', 'page.evaluate(() => document.title);', false],
    ['잡지 않는다', "page.evaluate((value) => value, 'text');", false],
    ['잡지 않는다', 'page.addInitScript(() => undefined);', false],
    ['잡지 않는다', "page.$eval('p', (node) => node.textContent);", false],
    ['잡지 않는다', "document.createElement('style');", false],
    // 변수에 담은 문자열은 잡지 못한다(검토로 본다). 묶은 코드를 싣는 경우가 이렇다.
    ['잡지 않는다', 'worker.evaluate(code);', false],
  ])('%s: %s', async (_label, code, expected) => {
    const restrictions = (await restrictionsFor('tests/e2e/reload.spec.ts')).filter(
      isExecutableString,
    );
    expect(reported(restrictions, code) > 0).toBe(expected);
  });
});

describe('결정 0006 외부 메시지를 받지 않는다', () => {
  const isExternal = (restriction: Restriction) => restriction.message.includes('결정 0006');

  it.each([
    'src/background/router.ts',
    'src/platform/messaging.ts',
    'src/features/media-speed/page.ts',
  ])('%s에 규칙이 걸린다', async (file) => {
    expect((await restrictionsFor(file)).filter(isExternal)).not.toHaveLength(0);
  });

  it.each([
    ['잡는다', 'chrome.runtime.onMessageExternal.addListener(f);', true],
    ['잡는다', 'chrome.runtime.onConnectExternal.addListener(f);', true],
    ['잡지 않는다', 'chrome.runtime.onMessage.addListener(f);', false],
  ])('%s: %s', async (_label, code, expected) => {
    const restrictions = (await restrictionsFor('src/platform/messaging.ts')).filter(isExternal);
    expect(reported(restrictions, code) > 0).toBe(expected);
  });
});

describe('결정 0044 방패가 막는 창의 초점·보임 이벤트를 격리된 쪽이 직접 듣지 않는다', () => {
  const isShielded = (restriction: Restriction) => restriction.message.includes('결정 0044');

  it.each([
    'src/page/runtime.ts',
    'src/dom/find.ts',
    'src/sites/chatgpt/index.ts',
    'src/features/tab-keep-active/page.ts',
    'src/features/some-feature/page/part.ts',
  ])('%s에 규칙이 걸린다', async (file) => {
    expect((await restrictionsFor(file)).filter(isShielded)).not.toHaveLength(0);
  });

  it.each([
    // 방패 자신(페이지의 세계)과 시험, 확장 화면과 서비스 워커는 방패가 없는 곳이거나 그것을 막는 곳이다.
    'src/features/tab-keep-active/main.ts',
    'src/page/runtime.dom.test.ts',
    'src/ui/popup-app.tsx',
    'src/background/router.ts',
  ])('%s에는 규칙이 걸리지 않는다', async (file) => {
    expect((await restrictionsFor(file)).filter(isShielded)).toHaveLength(0);
  });

  it.each([
    ['잡는다', "document.addEventListener('visibilitychange', f);", true],
    ['잡는다', "scope.listen(document, 'visibilitychange', f);", true],
    ['잡는다', "scope.listen(window, 'blur', f);", true],
    ['잡는다', "window.addEventListener('focus', f, true);", true],
    ['잡는다', 'document.onvisibilitychange = f;', true],
    ['잡는다', 'window.onblur = f;', true],
    [
      '잡지 않는다',
      'for (const type of visibilityEventNames) scope.listen(document, type, f);',
      false,
    ],
    ['잡지 않는다', "scope.listen(window, 'resize', f);", false],
    ['잡지 않는다', "document.removeEventListener('visibilitychange', f);", false],
    ['잡지 않는다', "if (document.visibilityState !== 'visible') return;", false],
    ['잡지 않는다', 'input.focus();', false],
  ])('%s: %s', async (_label, code, expected) => {
    const restrictions = (await restrictionsFor('src/page/runtime.ts')).filter(isShielded);
    expect(reported(restrictions, code) > 0).toBe(expected);
  });
});
