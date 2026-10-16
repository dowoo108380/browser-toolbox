import {
  type KeyValueStore,
  chromeLocalStore,
  chromeSessionStore,
} from '../../src/platform/index.ts';
import { checkAreaIsolation, storeContract } from './store.ts';

// 확장의 서비스 워커 안에서 실제 chromeLocalStore와 chromeSessionStore로 계약 사례를 차례로 돌린다. 확장 전체 시험이
// 이 파일을 esbuild로 묶어 서비스 워커에서 실행한다(tests/e2e/storage-contract.spec.ts). 배포물에는 들어가지 않는다.

export interface ContractResult {
  readonly name: string;
  // 통과했으면 null.
  readonly error: string | null;
}

export type Area = 'local' | 'session';

const stores: Record<Area, () => KeyValueStore> = {
  local: chromeLocalStore,
  session: chromeSessionStore,
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function run(area: Area): Promise<ContractResult[]> {
  const results: ContractResult[] = [];
  for (const [index, contractCase] of storeContract.entries()) {
    try {
      await contractCase.run(stores[area](), (name) => `contract:${String(index)}:${name}`);
      results.push({ name: contractCase.name, error: null });
    } catch (error) {
      results.push({ name: contractCase.name, error: messageOf(error) });
    }
  }
  return results;
}

// 두 영역이 서로의 바뀜을 알리지 않는지 양쪽으로 본다. 통과하면 null, 아니면 오류 문구다.
export async function isolation(): Promise<string | null> {
  try {
    await checkAreaIsolation(chromeLocalStore(), chromeSessionStore(), (name) => `iso:a:${name}`);
    await checkAreaIsolation(chromeSessionStore(), chromeLocalStore(), (name) => `iso:b:${name}`);
    return null;
  } catch (error) {
    return messageOf(error);
  }
}

declare global {
  // 이 파일을 묶어 서비스 워커에서 실으면 이 전역에 실행기를 둔다. 시험이 이 타입대로 부르므로 함수의 이름과 모양을
  // 타입 검사가 본다(실행 코드를 문자열로 붙이지 않는다).
  var storeContractRunner:
    { readonly run: typeof run; readonly isolation: typeof isolation } | undefined;
}

globalThis.storeContractRunner = { run, isolation };
