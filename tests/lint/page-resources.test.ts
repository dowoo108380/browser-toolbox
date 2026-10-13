import path from 'node:path';
import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

// 결정 0014의 린트 규칙(eslint.config.ts의 pageResources)이 잡아야 할 것과 잡지 않아야 할 것.
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
    'scope.animationFrame(f);',
    'scope.mutationObserver(f).observe(document, { childList: true });',
    'scope.resizeObserver(f).observe(video);',
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
