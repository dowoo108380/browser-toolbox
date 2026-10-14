import path from 'node:path';
import { build } from 'esbuild';
import { localStoreContract } from '../contract/local-store.ts';
import { expect, test } from './support/extension.ts';

// quality 047: 실제 chrome.storage.local을 감싼 chromeLocalStore가 계약 사례(tests/contract/local-store.ts)를
// 지키는지 확장의 서비스 워커 안에서 돌린다. 같은 사례를 가짜 저장소에는 단위 시험으로 돌린다.

const runner = path.resolve(import.meta.dirname, '..', 'contract', 'run-local-store.ts');

test('047 실제 저장소(chromeLocalStore)가 가짜 저장소와 같은 계약을 지킨다', async ({
  context,
}) => {
  const bundled = await build({
    entryPoints: [runner],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    logLevel: 'warning',
  });
  const code = bundled.outputFiles[0]?.text;
  if (code === undefined) throw new Error('계약 실행기를 묶지 못했다.');
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  // 타입 검사를 받은 실행기(run-local-store.ts)를 묶은 코드를 싣는다. 실행기는 실리면서 전역 localStoreContractRunner에
  // 자기 함수를 둔다. 부르는 쪽도 함수로 넘겨 그 이름과 모양을 타입 검사가 본다.
  await worker.evaluate(code);
  const results = await worker.evaluate(() => {
    if (localStoreContractRunner === undefined) throw new Error('계약 실행기가 실리지 않았다.');
    return localStoreContractRunner.run();
  });
  // 사례마다 이름과 오류(통과하면 null)를 비교한다. 틀린 사례는 오류 문구가 그대로 나온다.
  expect(results).toEqual(
    localStoreContract.map((contractCase) => ({ name: contractCase.name, error: null })),
  );
});
