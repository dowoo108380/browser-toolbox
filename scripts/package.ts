import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { packageBudgetBytes } from './budgets.ts';
import { createZip } from './zip.ts';

// dist/를 배포 ZIP 하나로 묶고 SHA-256 체크섬을 만든다(quality 117, 아키텍처 10장).

const root = process.cwd();
const dist = path.join(root, 'dist');
const outdir = path.join(root, 'artifacts');

function filesIn(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dist, path.join(entry.parentPath, entry.name)));
}

const manifest: unknown = JSON.parse(readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
const version =
  typeof manifest === 'object' && manifest !== null && 'version' in manifest
    ? String(manifest.version)
    : null;
if (version === null) throw new Error('dist/manifest.json에 version이 없다. 먼저 빌드한다.');

const zip = createZip(
  filesIn(dist).map((file) => ({
    name: file.split(path.sep).join('/'),
    data: readFileSync(path.join(dist, file)),
  })),
);
// 배포 파일이 크기 예산을 넘으면 멈춘다(quality 111).
if (zip.length > packageBudgetBytes) {
  throw new Error(
    `배포 ZIP이 크기 예산(${String(packageBudgetBytes)}바이트)을 넘었다: ${String(zip.length)}바이트.`,
  );
}
const name = `browser-toolbox-${version}.zip`;
mkdirSync(outdir, { recursive: true });
writeFileSync(path.join(outdir, name), zip);
const digest = createHash('sha256').update(zip).digest('hex');
// sha256sum -c로 확인할 수 있는 형식이다.
writeFileSync(path.join(outdir, `${name}.sha256`), `${digest}  ${name}\n`);

console.log(
  `패키징했다: artifacts/${name} (${String(zip.length)}바이트, 예산 ${String(packageBudgetBytes)})`,
);
console.log(`SHA-256: ${digest}`);
