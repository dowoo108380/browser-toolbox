import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

// 웹 페이지에서 온 글을 HTML로 넣는 길을 막는다(quality 065).
const htmlInjection = [
  {
    selector: 'AssignmentExpression[left.property.name=/^(innerHTML|outerHTML)$/]',
    message: '문자열을 HTML로 넣지 않는다. textContent나 DOM API를 쓴다(quality 065).',
  },
  {
    selector:
      'CallExpression[callee.property.name=/^(insertAdjacentHTML|setHTMLUnsafe|createContextualFragment|write|writeln)$/]',
    message: '문자열을 HTML로 넣지 않는다(quality 065).',
  },
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: '문자열을 HTML로 넣지 않는다(quality 065).',
  },
];

// 클래스 상속을 쓰지 않는다(quality 048). 플랫폼이 요구하면 그 줄에서 이유와 함께 끈다.
const classInheritance = [
  {
    selector: 'ClassDeclaration[superClass], ClassExpression[superClass]',
    message: '클래스 상속을 쓰지 않는다(quality 048).',
  },
];

// 웹 페이지에서 도는 기능 코드는 이벤트 듣기, 관찰, 타이머를 자원 범위(scope)로만 만든다(결정 0014).
// 직접 만들면 시작 도중 실패할 때 남고, 콜백의 예외가 그 기능의 정리와 기록으로 이어지지 않는다.
const pageResources = [
  {
    selector:
      'CallExpression[callee.property.name=/^(addEventListener|requestAnimationFrame|requestIdleCallback|setTimeout|setInterval)$/]',
    message: '페이지 쪽 자원은 scope로 만든다(결정 0014).',
  },
  {
    selector:
      'CallExpression[callee.name=/^(addEventListener|requestAnimationFrame|requestIdleCallback|setTimeout|setInterval|queueMicrotask)$/]',
    message: '페이지 쪽 자원은 scope로 만든다(결정 0014).',
  },
  {
    selector: 'NewExpression[callee.name=/Observer$/]',
    message: '관찰은 scope로 만든다(결정 0014).',
  },
];

// 이름 규칙(quality 028): 값은 camelCase, 타입은 PascalCase.
const namingConvention = [
  { selector: 'default', format: ['camelCase'], leadingUnderscore: 'forbid' },
  // 쓰지 않는 매개변수는 _로 시작한다(noUnusedParameters).
  { selector: 'parameter', format: ['camelCase'], leadingUnderscore: 'allow' },
  { selector: 'import', format: ['camelCase', 'PascalCase'] },
  { selector: 'variable', modifiers: ['const'], format: ['camelCase', 'PascalCase'] },
  { selector: 'function', format: ['camelCase', 'PascalCase'] },
  { selector: 'typeLike', format: ['PascalCase'] },
  // 메시지 이름, CSS 속성, HTTP 머리글처럼 밖에서 정한 이름은 그대로 쓴다.
  {
    selector: ['objectLiteralProperty', 'typeProperty'],
    format: null,
    modifiers: ['requiresQuotes'],
  },
];

export default defineConfig(
  {
    ignores: [
      'dist/',
      'coverage/',
      'reports/',
      'test-results/',
      'playwright-report/',
      '.stryker-tmp/',
      'artifacts/',
    ],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // 확장 코드와 Node 코드는 타입 환경이 달라 tsconfig가 둘이다.
        project: ['./tsconfig.json', './tsconfig.node.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      'no-restricted-syntax': ['error', ...htmlInjection, ...classInheritance],
      eqeqeq: 'error',
      // 런타임 검증은 zod/mini 방식 하나만 쓴다(결정 0006).
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'zod', message: 'zod/mini를 쓴다(결정 0006).' }],
          patterns: [{ group: ['zod/*', '!zod/mini'], message: 'zod/mini를 쓴다(결정 0006).' }],
        },
      ],
      // 타입 단언은 신뢰 경계에서만 쓰고, 그 줄에서 이유를 적어 이 규칙을 끈다(quality 054).
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/naming-convention': ['error', ...namingConvention],
    },
  },
  {
    // 웹 페이지에서 도는 기능 코드와 그 도우미. 자원 범위 자체(scope.ts)와 테스트는 뺀다.
    files: [
      'src/features/*/page.ts',
      'src/features/*/page/**/*.ts',
      'src/sites/**/*.ts',
      'src/dom/**/*.ts',
    ],
    ignores: ['src/dom/scope.ts', '**/*.test.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...htmlInjection, ...classInheritance, ...pageResources],
    },
  },
  {
    // manifest의 키 이름은 Chrome이 정했다(snake_case).
    files: ['scripts/manifest.ts'],
    rules: {
      '@typescript-eslint/naming-convention': [
        'error',
        ...namingConvention,
        { selector: 'objectLiteralProperty', format: ['camelCase', 'snake_case'] },
      ],
    },
  },
);
