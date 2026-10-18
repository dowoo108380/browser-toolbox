import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { type BuildOptions, type Plugin, build } from 'esbuild';
import { features as productFeatures } from '../src/features/list.ts';
import { pageScriptBudgetBytes } from './budgets.ts';
import { createManifest, minimumChromeVersion } from './manifest.ts';
import { contentBundles, syncGenerated } from './registry.ts';

// dist/에 압축 해제된 확장을 만든다(결정 0002, 아키텍처 10장).
// --fixture이면 시험 빌드를 dist-fixture/에 만든다(결정 0025): 진입점이 가져오는 기능 목록과 서비스 워커·콘텐츠
// 스크립트의 등록 목록만 tests/extension/의 것(제품의 목록에 시험 기능을 덧붙인 것)으로 바꾸고 나머지는 제품과 같다.
// 배포물은 늘 dist/다.

const root = process.cwd();
const fixture = process.argv.includes('--fixture');
const outdir = path.join(root, fixture ? 'dist-fixture' : 'dist');
const watch = process.argv.includes('--watch');
// 제품 빌드는 시험 코드를 읽지 않는다.
const features = fixture
  ? (await import('../tests/extension/features.ts')).features
  : productFeatures;

// 진입점(src/entries/)이 가져오는 세 목록을 시험 빌드의 것으로 바꾼다. 시험 빌드의 목록이 제품의 목록을 가져올 때는
// 바꾸지 않는다(가져오는 곳이 진입점이 아니다).
const fixtureLists: Plugin = {
  name: 'fixture-lists',
  setup(builder) {
    const entries = path.join(root, 'src', 'entries');
    const replace = (target: string) => (args: { importer: string }) =>
      path.dirname(args.importer) === entries
        ? { path: path.join(root, 'tests', 'extension', target) }
        : undefined;
    builder.onResolve({ filter: /\/features\/list\.ts$/ }, replace('features.ts'));
    builder.onResolve({ filter: /\/generated\/sw\.ts$/ }, replace('task-parts.ts'));
    builder.onResolve({ filter: /\/generated\/content-common\.ts$/ }, replace('page-parts.ts'));
  },
};

interface PackageJson {
  readonly version: string;
  readonly dependencies: Readonly<Record<string, string>>;
}

function readPackageJson(): PackageJson {
  const parsed: unknown = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- 저장소의 package.json이다. 쓰는 두 필드는 이 저장소가 늘 둔다.
  return parsed as PackageJson;
}

const stale = await syncGenerated(productFeatures, root, false);
if (stale.length > 0) {
  throw new Error(
    `등록 목록이 기능 목록과 맞지 않는다(${stale.join(', ')}). pnpm generate를 실행한다.`,
  );
}

const packageJson = readPackageJson();
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const common: BuildOptions = {
  bundle: true,
  outdir,
  target: `chrome${minimumChromeVersion}`,
  platform: 'browser',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  // 타사 라이선스는 THIRD_PARTY_NOTICES.txt에 모은다.
  legalComments: 'none',
  logLevel: 'warning',
  plugins: fixture ? [fixtureLists] : [],
};

const builds: BuildOptions[] = [
  // 서비스 워커와 확장 화면은 ES 모듈이다.
  {
    ...common,
    entryPoints: {
      sw: 'src/entries/sw.ts',
      popup: 'src/entries/popup.tsx',
    },
    format: 'esm',
  },
  // 콘텐츠 스크립트는 manifest에서 모듈로 쓸 수 있다는 문서가 없어 묶음마다 파일 하나로 묶는다(N-08). 사이트 묶음은
  // 그 사이트 전용 기능이 있을 때만 있다(결정 0029).
  {
    ...common,
    entryPoints: Object.fromEntries(
      contentBundles(features).map((bundle) => [
        `content-${bundle}`,
        `src/entries/content-${bundle}.ts`,
      ]),
    ),
    format: 'iife',
  },
];

for (const options of builds) await build(options);

// 웹 페이지에 실리는 묶음은 크기 예산을 넘으면 빌드를 멈춘다(quality 111).
for (const file of contentBundles(features).map((bundle) => `content-${bundle}.js`)) {
  const size = statSync(path.join(outdir, file)).size;
  if (size > pageScriptBudgetBytes) {
    throw new Error(
      `${file}이 크기 예산(${String(pageScriptBudgetBytes)}바이트)을 넘었다: ${String(size)}바이트.`,
    );
  }
  console.log(`${file}: ${String(size)}바이트(예산 ${String(pageScriptBudgetBytes)})`);
}

for (const file of ['popup.html', 'popup.css']) {
  copyFileSync(path.join(root, 'src', 'entries', file), path.join(outdir, file));
}
copyFileSync(path.join(root, 'LICENSE'), path.join(outdir, 'LICENSE'));

// 확장 실행 중에 쓰는 의존성의 라이선스를 배포물에 함께 넣는다(quality 128). 파일 이름은 패키지마다 다르다
// (preact는 LICENSE, valibot은 LICENSE.md). 없으면 빌드를 멈춘다.
const licenseFiles = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'];
const notices = Object.keys(packageJson.dependencies)
  .sort()
  .map((name) => {
    const file = licenseFiles
      .map((candidate) => path.join(root, 'node_modules', name, candidate))
      .find((candidate) => existsSync(candidate));
    if (file === undefined) throw new Error(`${name}의 라이선스 파일을 찾지 못했다.`);
    const license = readFileSync(file, 'utf8');
    return `${name}\n${'='.repeat(name.length)}\n\n${license.trim()}\n`;
  });
writeFileSync(path.join(outdir, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n'));

writeFileSync(
  path.join(outdir, 'manifest.json'),
  `${JSON.stringify(createManifest(features, packageJson.version), null, 2)}\n`,
);

console.log(`빌드했다: ${path.relative(root, outdir)}`);
if (watch) console.log('감시 모드는 아직 없다. 바꾼 뒤 다시 빌드한다.');
