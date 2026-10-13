import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// 요구사항의 인수 기준 번호(예: COM-3.10)가 테스트나 수동 확인 절차에 있는지 본다(quality 001, 102).
// 요구사항은 커밋하지 않는 docs/에 있으므로 docs/가 있는 로컬에서만 돈다(결정 0003).
// 기본은 보고만 한다. --strict이면 연결되지 않은 기준이 있을 때 실패한다(07단계).

const root = process.cwd();
const requirementsDirectory = path.join(root, 'docs', 'requirements');
const strict = process.argv.includes('--strict');

// 인수 기준 줄: "- COM-3.10 기능이 …"
const criterionLine = /^- ([A-Z]+-\d+\.\d+) /;

function filesUnder(directory: string, accept: (file: string) => boolean): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter(accept);
}

if (!existsSync(requirementsDirectory)) {
  console.log('docs/requirements/가 없어 연결 검사를 건너뛴다.');
} else {
  const criteria = filesUnder(requirementsDirectory, (file) => file.endsWith('.md')).flatMap(
    (file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line) => criterionLine.exec(line)?.[1])
        .filter((id) => id !== undefined),
  );
  // 근거로 읽는 파일: 시험 파일과 수동 확인 절차. tests/에는 확장 전체 시험(e2e, measure의 .spec.ts),
  // 실제 모듈 연결 시험(integration의 .test.ts·.test.tsx), 린트 규칙 시험, 수동 절차(manual의 .md)가 있다.
  // 시험 도우미(support)와 시험 페이지(fixtures)는 읽지 않는다. 새 시험 파일 이름 규칙을 더하면 여기를 고친다.
  const evidence = [
    ...filesUnder(path.join(root, 'src'), (file) => /\.test\.tsx?$/.test(file)),
    ...filesUnder(path.join(root, 'scripts'), (file) => file.endsWith('.test.ts')),
    ...filesUnder(path.join(root, 'tests'), (file) => /\.(spec\.ts|test\.tsx?|md)$/.test(file)),
  ]
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
  // COM-3.1이 COM-3.10에 걸리지 않게 뒤에 숫자가 이어지지 않는지 본다.
  const linked = (id: string) =>
    new RegExp(`(^|[^A-Z0-9-])${id.replace('.', '\\.')}(?![0-9])`).test(evidence);
  const missing = criteria.filter((id) => !linked(id));
  const groups = new Map<string, number>();
  for (const id of missing) {
    const group = id.split('-')[0] ?? id;
    groups.set(group, (groups.get(group) ?? 0) + 1);
  }
  console.log(
    `인수 기준 ${String(criteria.length)}개 중 ${String(criteria.length - missing.length)}개가 테스트나 수동 절차에 연결되어 있다.`,
  );
  if (missing.length > 0) {
    console.log(
      `연결되지 않은 기준(묶음별): ${[...groups].map(([group, count]) => `${group} ${String(count)}`).join(', ')}`,
    );
    if (strict) {
      console.log(missing.join(', '));
      process.exitCode = 1;
    }
  }
}
