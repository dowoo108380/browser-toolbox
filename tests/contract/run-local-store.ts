import { chromeLocalStore } from '../../src/platform/index.ts';
import { localStoreContract } from './local-store.ts';

// 확장의 서비스 워커 안에서 실제 chromeLocalStore로 계약 사례를 차례로 돌린다. 확장 전체 시험이 이 파일을
// esbuild로 묶어 서비스 워커에서 실행한다(tests/e2e/storage-contract.spec.ts). 배포물에는 들어가지 않는다.

export interface ContractResult {
  readonly name: string;
  // 통과했으면 null.
  readonly error: string | null;
}

export async function run(): Promise<ContractResult[]> {
  const results: ContractResult[] = [];
  for (const [index, contractCase] of localStoreContract.entries()) {
    try {
      await contractCase.run(chromeLocalStore(), (name) => `contract:${String(index)}:${name}`);
      results.push({ name: contractCase.name, error: null });
    } catch (error) {
      results.push({
        name: contractCase.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
