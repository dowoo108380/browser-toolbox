import path from 'node:path';
import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

// 결정 0028: 런타임 검증은 contracts의 v 하나로 하고, valibot은 그 어휘를 정한 src/contracts/schema.ts만 가져온다. 실제 설정이
// 그 파일에 정한 가져오기 제한(no-restricted-imports)과 동적 가져오기의 문법 제한(no-restricted-syntax)을 꺼내 코드 조각에 돌린다.

const root = path.resolve(import.meta.dirname, '..', '..');
const eslint = new ESLint({ cwd: root, flags: ['unstable_native_nodejs_ts_config'] });
const linter = new Linter();

const severities: readonly unknown[] = [0, 1, 2, 'off', 'warn', 'error'];

function isRuleEntry(entry: unknown): entry is Linter.RuleEntry {
  return Array.isArray(entry) && severities.includes(entry[0]);
}

// 설정 값은 ESLint가 any로 주므로 모양을 확인하며 꺼낸다.
async function ruleEntry(file: string, rule: string): Promise<Linter.RuleEntry> {
  const config: unknown = await eslint.calculateConfigForFile(path.join(root, file));
  if (typeof config !== 'object' || config === null || !('rules' in config)) return 'off';
  const { rules } = config;
  if (typeof rules !== 'object' || rules === null) return 'off';
  const entry: unknown = Reflect.get(rules, rule);
  return isRuleEntry(entry) ? entry : 'off';
}

async function reported(file: string, code: string): Promise<number> {
  const rules = {
    'no-restricted-imports': await ruleEntry(file, 'no-restricted-imports'),
    'no-restricted-syntax': await ruleEntry(file, 'no-restricted-syntax'),
  };
  const messages = linter.verify(
    code,
    [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser }, rules }],
    'sample.ts',
  );
  // 조각을 읽지 못한 것(문법 오류)은 규칙이 잡은 것이 아니다.
  const fatal = messages.find((message) => message.fatal === true);
  if (fatal !== undefined) throw new Error(`조각을 읽지 못했다: ${fatal.message}`);
  return messages.filter((message) => message.ruleId !== null).length;
}

const schemaModule = 'src/contracts/schema.ts';
const others = [
  'src/storage/format.ts',
  'src/background/router.ts',
  'src/features/media-speed/feature.ts',
  'tests/integration/schema-acceptance.test.ts',
  'tests/extension/fixture-tasks.ts',
  'scripts/build.ts',
];

// 어디에서도 가져오지 않는다.
const otherLibraries = [
  "import * as z from 'zod/mini';",
  "import { z } from 'zod';",
  "export * from 'zod';",
  "import * as yup from 'yup';",
  "import Ajv from 'ajv';",
  "import { Type } from '@sinclair/typebox';",
  "import { Schema } from 'effect';",
  "const lazy = await import('zod');",
  "const lazy = await import('valibot');",
];

// 어휘를 정하는 곳만 가져온다.
const valibotImports = [
  "import * as valibot from 'valibot';",
  "import { object } from 'valibot';",
  "export { object } from 'valibot';",
  "import type { GenericSchema } from 'valibot';",
];

describe('결정 0028 런타임 검증 라이브러리를 가져오는 곳', () => {
  it.each([schemaModule, ...others].flatMap((file) => otherLibraries.map((code) => [file, code])))(
    '%s: 잡는다 %s',
    async (file, code) => {
      expect(await reported(file, code)).toBeGreaterThan(0);
    },
  );

  it.each(others.flatMap((file) => valibotImports.map((code) => [file, code])))(
    '%s: 잡는다 %s',
    async (file, code) => {
      expect(await reported(file, code)).toBeGreaterThan(0);
    },
  );

  it.each(valibotImports)(`${schemaModule}: 잡지 않는다 %s`, async (code) => {
    expect(await reported(schemaModule, code)).toBe(0);
  });

  it.each(others)('%s: contracts의 v는 잡지 않는다', async (file) => {
    expect(await reported(file, "import { v } from '../contracts/index.ts';")).toBe(0);
  });
});
