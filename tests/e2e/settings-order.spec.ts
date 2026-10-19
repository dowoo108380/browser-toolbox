import type { Page } from '@playwright/test';
import { settingsUpdate } from '../../src/contracts/index.ts';
import {
  expect,
  openPopup,
  serviceWorkerOf,
  test,
  watchServiceWorker,
} from './support/extension.ts';

// 결정 0036의 전제: 한 확장 화면이 응답을 기다리지 않고 잇달아 보낸 설정 바꾸기는 보낸 차례로 서비스 워커의 줄에 서서 그
// 차례로 저장된다. Chrome 문서에 없는 성질이라 실제 Chromium에서 지킨다. 팝업은 이것에 기대어, 저장했는지 알 수 없게 끝난
// 저장(응답이 없음)도 그 뒤에 보낸 같은 항목의 저장이 되면 그 전에 저장되었거나 끝내 저장되지 않는다고 본다. 서비스 워커가
// 멈춰 있어 첫 요청이 깨우는 동안 온 요청들도 본다(N-12).

const count = 30;

// 확장 화면에서 GPT-2의 너비를 widths 차례로 바꾸는 요청을 한꺼번에 보내고, 보낸 차례대로 응답을 돌려준다.
function sendWidths(page: Page, widths: readonly number[]): Promise<unknown[]> {
  return page.evaluate(
    ({ type, widths: list }) =>
      Promise.all(
        list.map((width): Promise<unknown> =>
          chrome.runtime.sendMessage({
            type,
            payload: { featureId: 'chatgpt-width', patch: { width } },
          }),
        ),
      ),
    { type: settingsUpdate.type, widths },
  );
}

// 응답마다 저장한 값의 세대 번호. 성공이 아니면 시험이 실패한다.
function revisionsOf(responses: readonly unknown[]): number[] {
  return responses.map((response) => {
    expect(response).toMatchObject({ ok: true, value: { revision: expect.any(Number) } });
    const revision: unknown = Reflect.get(
      Object(Reflect.get(Object(response), 'value')),
      'revision',
    );
    if (typeof revision !== 'number') throw new Error('세대 번호가 없다.');
    return revision;
  });
}

test('결정 0036 한 확장 화면이 잇달아 보낸 설정 바꾸기는 서비스 워커가 깨어 있든 멈춰 있든 보낸 차례로 저장된다', async ({
  context,
  extensionId,
}) => {
  const worker = await serviceWorkerOf(context);
  await expect
    .poll(() => worker.evaluate(() => chrome.storage.local.get('settings')))
    .toMatchObject({ settings: { version: 1 } });
  const page = await openPopup(context, extensionId);
  const status = await watchServiceWorker(await context.newPage());

  for (const [round, stopFirst] of [false, true].entries()) {
    if (stopFirst) await status.stop();
    const widths = Array.from({ length: count }, (_, index) => 700 + round * 1000 + index * 10);
    const revisions = revisionsOf(await sendWidths(page, widths));
    // 서비스 워커는 줄의 차례로 쓰고 쓸 때마다 앞 값보다 큰 세대 번호를 정한다(결정 0011). 그래서 세대 번호가 보낸 차례로
    // 커지면 보낸 차례로 저장된 것이다.
    for (let index = 1; index < revisions.length; index += 1) {
      expect(revisions[index]).toBeGreaterThan(revisions[index - 1] ?? Infinity);
    }
    await expect
      .poll(() => page.evaluate(() => chrome.storage.local.get('settings')))
      .toMatchObject({ settings: { features: { 'chatgpt-width': { width: widths.at(-1) } } } });
  }
});
