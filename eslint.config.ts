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

// 외부 웹사이트나 다른 확장의 메시지를 받지 않는다(결정 0006). manifest에 externally_connectable도 두지 않는다.
const externalMessaging = [
  {
    selector: 'MemberExpression[property.name=/^(onMessageExternal|onConnectExternal)$/]',
    message: '외부 메시지를 받지 않는다(결정 0006).',
  },
];

// 실행 코드를 문자열로 쓰지 않는다. 문자열 안의 코드는 타입 검사와 린트를 거치지 않는다(quality 054, 100).
// 페이지나 서비스 워커에서 돌릴 코드는 타입 검사를 받는 함수로 쓰고 Playwright의 evaluate 등에 함수로 넘긴다.
// 페이지의 스크립트로 돌려야 하면 그 함수를 직렬화해 스크립트 요소로 넣고, 그 줄에서 이유와 함께 이 규칙을 끈다.
// 문자열을 변수에 담아 넘기는 경우(예: 타입 검사를 받은 코드를 묶은 결과)는 문법으로 가릴 수 없어 검토로 본다.
// 잡아야 하는 사례와 잡지 않아야 하는 사례는 tests/lint/restricted-syntax.test.ts에 있다.
const executableStringMessage =
  '실행 코드를 문자열로 쓰지 않는다. 타입 검사를 받는 함수로 쓴다(quality 054, 100).';
const executableStrings = [
  {
    selector: "CallExpression[callee.property.name='createElement'][arguments.0.value=/^script$/i]",
    message: executableStringMessage,
  },
  {
    selector:
      'CallExpression[callee.property.name=/^(evaluate|evaluateHandle|evaluateAll|addInitScript)$/][arguments.0.type=/^(Literal|TemplateLiteral|BinaryExpression|ObjectExpression)$/]',
    message: executableStringMessage,
  },
  {
    selector: "CallExpression[callee.property.name='addScriptTag']",
    message: executableStringMessage,
  },
];

// 모든 파일에 거는 문법 제한.
const baseRestrictions = [
  ...htmlInjection,
  ...classInheritance,
  ...externalMessaging,
  ...executableStrings,
];

// 웹 페이지에서 도는 기능 코드는 이벤트 듣기, 관찰, 타이머를 자원 범위(scope)로만 만든다(결정 0014).
// 직접 만들면 시작 도중 실패할 때 남고, 콜백의 예외가 그 기능의 정리와 기록으로 이어지지 않는다.
// 이름으로 잡으므로 이름을 감춘 경우(전역 이름을 변수에 담기, 구조 분해, Reflect.get)는 검토로 본다.
// 잡아야 하는 사례와 잡지 않아야 하는 사례는 tests/lint/restricted-syntax.test.ts에 있다.
const resourceNames =
  'addEventListener|requestAnimationFrame|requestIdleCallback|setTimeout|setInterval|queueMicrotask';
const observerNames = '[A-Z][A-Za-z]*Observer';
const pageResourceMessage =
  '페이지 쪽 자원(이벤트 듣기, 관찰, 타이머)은 scope로 만든다(결정 0014).';
const pageResources = [
  // 전역 함수를 이름으로 부름: setTimeout(...), queueMicrotask(...)
  { selector: `CallExpression[callee.name=/^(${resourceNames})$/]`, message: pageResourceMessage },
  // 속성으로 부르거나 꺼냄: video.addEventListener(...), window.queueMicrotask(...), window.setTimeout.bind(...), window['setTimeout'](...)
  {
    selector: `MemberExpression[property.name=/^(${resourceNames})$/]`,
    message: pageResourceMessage,
  },
  {
    selector: `MemberExpression[property.value=/^(${resourceNames})$/]`,
    message: pageResourceMessage,
  },
  // 관찰 생성자: new MutationObserver(...), new globalThis.MutationObserver(...), globalThis['ResizeObserver']
  { selector: `NewExpression[callee.name=/^${observerNames}$/]`, message: pageResourceMessage },
  {
    selector: `MemberExpression[property.name=/^${observerNames}$/]`,
    message: pageResourceMessage,
  },
  {
    selector: `MemberExpression[property.value=/^${observerNames}$/]`,
    message: pageResourceMessage,
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
      'no-restricted-syntax': ['error', ...baseRestrictions],
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
      'no-restricted-syntax': ['error', ...baseRestrictions, ...pageResources],
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
