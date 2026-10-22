import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// 요구사항 연결 검사(scripts/trace.ts)가 어느 파일을 근거로 읽는지, 기능 하나만 볼 때 무엇을 세고 언제 실패하는지 본다(quality 102).
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

function trace(root: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [traceScript, ...args], {
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
    const { output, status } = trace(root, '--strict');
    expect(output).toContain('인수 기준 7개 중 6개가');
    expect(output).toContain('ABC-1.7');
    expect(output).not.toMatch(/ABC-1\.[1-6]/);
    expect(status).toBe(1);
  });
});

describe('기능 하나만 보는 연결 검사(--feature)', () => {
  // ABC-1의 기준 둘과, 이름이 비슷한 다른 기능(ABC-10, ABD-1)의 연결되지 않은 기준.
  const requirements = [
    '- ABC-1.1 기준',
    '- ABC-1.2 기준',
    '- ABC-10.1 기준',
    '- ABD-1.1 기준',
  ].join('\n');

  it('그 기능의 기준만 세고, 다 연결되어 있으면 통과한다. 다른 기능의 빠진 기준은 보지 않는다', () => {
    const root = project({
      'docs/requirements/sample.md': requirements,
      'src/a.test.ts': "it('ABC-1.1 단위', () => {}); it('ABC-1.2 단위', () => {});",
    });
    const { output, status } = trace(root, '--feature', 'ABC-1');
    expect(output).toContain('ABC-1의 인수 기준 2개 중 2개가');
    expect(output).not.toMatch(/ABC-10|ABD-1/);
    expect(status).toBe(0);
  });

  it('그 기능의 기준이 하나라도 연결되지 않으면 실패하고 그 기준을 적는다', () => {
    const root = project({
      'docs/requirements/sample.md': requirements,
      'tests/manual/a.md': '| 1 | ABC-1.1 |',
    });
    const { output, status } = trace(root, '--feature=ABC-1');
    expect(output).toContain('ABC-1의 인수 기준 2개 중 1개가');
    expect(output).toContain('연결되지 않은 기준: ABC-1.2');
    expect(status).toBe(1);
  });

  it.each([
    ['요구사항에 없는 기능', ['--feature', 'ABC-2'], '인수 기준이 docs/requirements/에 없다'],
    ['기능 번호의 모양이 아님', ['--feature', 'abc-1'], '기능 번호의 모양이 아니다'],
    ['기능 번호가 없음', ['--feature'], '쓰는 법'],
    ['선택이 아닌 인자', ['ABC-1'], '쓰는 법'],
  ])('%s이면 실패한다', (_name, args, message) => {
    const root = project({ 'docs/requirements/sample.md': requirements });
    const { output, status } = trace(root, ...args);
    expect(output).toContain(message);
    expect(status).toBe(1);
  });

  it('요구사항 폴더가 없으면 전체 보고는 건너뛰고(통과), 기능 하나는 볼 수 없어 실패한다', () => {
    const root = project({ 'src/a.test.ts': "it('ABC-1.1 단위', () => {});" });
    expect(trace(root).status).toBe(0);
    const { output, status } = trace(root, '--feature', 'ABC-1');
    expect(output).toContain('docs/requirements/가 없어');
    expect(status).toBe(1);
  });
});
