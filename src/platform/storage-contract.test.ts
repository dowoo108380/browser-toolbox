import { describe, it } from 'vitest';
import { localStoreContract } from '../../tests/contract/local-store.ts';
import { createFakeLocalStore } from './fake.ts';

// quality 047: 가짜 저장소가 실제 chrome.storage.local과 같은 계약을 지키는지 본다. 같은 사례를 실제 저장소에는
// 확장 안에서 돌린다(tests/e2e/storage-contract.spec.ts). 사례마다 새 가짜에서 시작한다.

describe('가짜 저장소의 계약(quality 047)', () => {
  for (const contractCase of localStoreContract) {
    it(contractCase.name, () => contractCase.run(createFakeLocalStore(), (name) => name));
  }
});
