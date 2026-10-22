import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

// 요구사항의 인수 기준 번호(예: COM-3.10)가 테스트나 수동 확인 절차에 있는지 본다(quality 001, 102).
// 요구사항은 커밋하지 않는 docs/에 있으므로 docs/가 있는 로컬에서만 돈다(결정 0003).
// 기본은 모든 기준을 보고만 한다. --strict이면 연결되지 않은 기준이 있을 때 실패한다(07단계).
// --feature 기능 번호(예: --feature PAGE-1)이면 그 기능의 기준만 보고, 연결되지 않은 기준이 하나라도 있거나 그 기능의 기준을
// 찾지 못하면 실패한다. 기능 하나를 끝낼 때 쓴다(principles.md 2부 "기능 하나를 끝낼 때").

const root = process.cwd();
const requirementsDirectory = path.join(root, 'docs', 'requirements');
const usage = '쓰는 법: pnpm trace [--strict] [--feature 기능 번호(예: PAGE-1)]';

// 인수 기준 줄: "- COM-3.10 기능이 …"
const criterionLine = /^- ([A-Z]+-\d+\.\d+) /;
// 기능 번호: "PAGE-1", "COM-10". 그 기능의 인수 기준은 이 번호 뒤에 "."과 숫자가 붙는다.
const featureNumber = /^[A-Z]+-\d+$/;

function filesUnder(directory: string, accept: (file: string) => boolean): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter(accept);
}

function readCriteria(): string[] {
  return filesUnder(requirementsDirectory, (file) => file.endsWith('.md')).flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => criterionLine.exec(line)?.[1])
      .filter((id) => id !== undefined),
  );
}

// 근거로 읽는 파일: 시험 파일과 수동 확인 절차. tests/에는 확장 전체 시험(e2e, measure의 .spec.ts),
// 실제 모듈 연결 시험(integration의 .test.ts·.test.tsx), 린트 규칙 시험, 수동 절차(manual의 .md)가 있다.
// 시험 도우미(support)와 시험 페이지(fixtures)는 읽지 않는다. 새 시험 파일 이름 규칙을 더하면 여기를 고친다.
function readEvidence(): string {
  return [
    ...filesUnder(path.join(root, 'src'), (file) => /\.test\.tsx?$/.test(file)),
    ...filesUnder(path.join(root, 'scripts'), (file) => file.endsWith('.test.ts')),
    ...filesUnder(path.join(root, 'tests'), (file) => /\.(spec\.ts|test\.tsx?|md)$/.test(file)),
  ]
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
}

// 근거에 그 번호가 없는 기준. COM-3.1이 COM-3.10에 걸리지 않게 뒤에 숫자가 이어지지 않는지 본다.
function unlinked(criteria: readonly string[], evidence: string): string[] {
  return criteria.filter(
    (id) => !new RegExp(`(^|[^A-Z0-9-])${id.replace('.', '\\.')}(?![0-9])`).test(evidence),
  );
}

// 모든 기준의 보고. 실패면 1이다.
function reportAll(criteria: readonly string[], missing: readonly string[], strict: boolean) {
  console.log(
    `인수 기준 ${String(criteria.length)}개 중 ${String(criteria.length - missing.length)}개가 테스트나 수동 절차에 연결되어 있다.`,
  );
  if (missing.length === 0) return 0;
  const groups = new Map<string, number>();
  for (const id of missing) {
    const group = id.split('-')[0] ?? id;
    groups.set(group, (groups.get(group) ?? 0) + 1);
  }
  console.log(
    `연결되지 않은 기준(묶음별): ${[...groups].map(([group, count]) => `${group} ${String(count)}`).join(', ')}`,
  );
  if (!strict) return 0;
  console.log(missing.join(', '));
  return 1;
}

// 기능 하나의 보고. 그 기능의 기준이 없거나 연결되지 않은 기준이 있으면 1이다.
function reportFeature(feature: string, criteria: readonly string[], missing: readonly string[]) {
  if (criteria.length === 0) {
    console.log(`${feature}의 인수 기준이 docs/requirements/에 없다. 기능 번호를 확인한다.`);
    return 1;
  }
  console.log(
    `${feature}의 인수 기준 ${String(criteria.length)}개 중 ${String(criteria.length - missing.length)}개가 테스트나 수동 절차에 연결되어 있다.`,
  );
  if (missing.length === 0) return 0;
  console.log(`연결되지 않은 기준: ${missing.join(', ')}`);
  return 1;
}

// 명령줄의 선택. 모르는 선택, 값이 없는 --feature, 선택이 아닌 인자는 던진다.
function readOptions(args: readonly string[]) {
  return parseArgs({
    args: [...args],
    options: { strict: { type: 'boolean', default: false }, feature: { type: 'string' } },
  }).values;
}

function main(args: readonly string[]): number {
  let options: ReturnType<typeof readOptions>;
  try {
    options = readOptions(args);
  } catch (error) {
    console.log(`${error instanceof Error ? error.message : String(error)}\n${usage}`);
    return 1;
  }
  const { strict, feature } = options;
  if (feature !== undefined && !featureNumber.test(feature)) {
    console.log(`기능 번호의 모양이 아니다: ${feature}\n${usage}`);
    return 1;
  }
  if (!existsSync(requirementsDirectory)) {
    // 기능 하나를 보는 것은 끝났다고 말하기 전의 확인이라, 볼 수 없으면 통과로 치지 않는다.
    console.log('docs/requirements/가 없어 연결 검사를 건너뛴다.');
    return feature === undefined ? 0 : 1;
  }
  const criteria = readCriteria();
  const evidence = readEvidence();
  if (feature === undefined) return reportAll(criteria, unlinked(criteria, evidence), strict);
  const own = criteria.filter((id) => id.startsWith(`${feature}.`));
  return reportFeature(feature, own, unlinked(own, evidence));
}

process.exitCode = main(process.argv.slice(2));
