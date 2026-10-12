import { features } from '../src/features/list.ts';
import { syncGenerated } from './registry.ts';

// 등록 목록을 만든다. `--check`이면 만들지 않고, 저장소의 것이 기능 목록과 맞는지만 본다.

const check = process.argv.includes('--check');
const stale = await syncGenerated(features, process.cwd(), !check);

if (check && stale.length > 0) {
  console.error(`등록 목록이 기능 목록과 맞지 않는다: ${stale.join(', ')}`);
  console.error('`pnpm generate`를 실행한 뒤 다시 한다.');
  process.exitCode = 1;
} else {
  for (const file of stale) console.log(`만듦: ${file}`);
}
