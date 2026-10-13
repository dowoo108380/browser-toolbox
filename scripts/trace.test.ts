import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// 요구사항 연결 검사(scripts/trace.ts)가 어느 파일을 근거로 읽는지 본다(quality 102).
// 임시 폴더에 요구사항과 시험 파일을 만들고 실제 스크립트를 그 폴더에서 돌린다.

const traceScript = path.resolve(import.meta.dirname, 'trace.ts');

let directory: string | null = null;
afterEach(() => {
  if (directory !== null) rmSync(directory, { recursive: true, force: true });
  directory = null;
});

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'trace-'));
  directory = root;
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  return root;
}

function trace(root: string) {
  const result = spawnSync(process.execPath, [traceScript, '--strict'], {
    cwd: root,
    encoding: 'utf8',
  });
  return { output: result.stdout, status: result.status };
}

describe('요구사항 연결 검사', () => {
  it('시험 폴더마다의 시험 파일과 수동 절차를 근거로 읽고, 시험 도우미는 읽지 않는다', () => {
    const root = project({
      'docs/requirements/sample.md': [1, 2, 3, 4, 5, 6, 7]
        .map((index) => `- ABC-1.${String(index)} 기준`)
        .join('\n'),
      'src/storage/a.test.ts': "it('ABC-1.1 단위', () => {});",
      'scripts/b.test.ts': "it('ABC-1.2 스크립트', () => {});",
      'tests/e2e/c.spec.ts': "test('ABC-1.3 확장 전체', () => {});",
      'tests/manual/d.md': '## ABC-1.4 수동 절차',
      // 실제 모듈끼리 연결한 시험(tests/integration). .ts와 .tsx 모두.
      'tests/integration/e.dom.test.ts': "it('ABC-1.5 연결', () => {});",
      'tests/integration/f.dom.test.tsx': "it('ABC-1.6 연결', () => {});",
      // 시험 도우미는 시험이 아니다.
      'tests/support/g.ts': '// ABC-1.7',
    });
    const { output, status } = trace(root);
    expect(output).toContain('인수 기준 7개 중 6개가');
    expect(output).toContain('ABC-1.7');
    expect(output).not.toMatch(/ABC-1\.[1-6]/);
    expect(status).toBe(1);
  });
});
