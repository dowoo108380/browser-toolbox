import path from 'node:path';
import type { Worker } from '@playwright/test';
import { build } from 'esbuild';
import type { Area } from '../contract/run-store.ts';
import { storeContract } from '../contract/store.ts';
import { expect, test } from './support/extension.ts';

// quality 047: 실제 chrome.storage의 local과 session을 감싼 chromeLocalStore와 chromeSessionStore가 계약 사례
// (tests/contract/store.ts)를 지키는지 확장의 서비스 워커 안에서 돌린다. 같은 사례를 가짜 저장소에는 단위 시험으로 돌린다.

const runner = path.resolve(import.meta.dirname, '..', 'contract', 'run-store.ts');

// 타입 검사를 받은 실행기(run-store.ts)를 묶은 코드를 싣는다. 실행기는 실리면서 전역 storeContractRunner에
// 자기 함수를 둔다. 부르는 쪽도 함수로 넘겨 그 이름과 모양을 타입 검사가 본다.
async function loadRunner(worker: Worker): Promise<void> {
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
  await worker.evaluate(code);
}

for (const area of ['local', 'session'] satisfies Area[]) {
  test(`047 실제 저장소(chrome.storage.${area})가 가짜 저장소와 같은 계약을 지킨다`, async ({
    context,
  }) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await loadRunner(worker);
    const results = await worker.evaluate((name) => {
      if (storeContractRunner === undefined) throw new Error('계약 실행기가 실리지 않았다.');
      return storeContractRunner.run(name);
    }, area);
    // 사례마다 이름과 오류(통과하면 null)를 비교한다. 틀린 사례는 오류 문구가 그대로 나온다.
    expect(results).toEqual(
      storeContract.map((contractCase) => ({ name: contractCase.name, error: null })),
    );
  });
}

test('047 local과 session은 같은 키라도 서로의 바뀜을 알리지 않는다', async ({ context }) => {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  await loadRunner(worker);
  const error = await worker.evaluate(() => {
    if (storeContractRunner === undefined) throw new Error('계약 실행기가 실리지 않았다.');
    return storeContractRunner.isolation();
  });
  expect(error).toBeNull();
});
