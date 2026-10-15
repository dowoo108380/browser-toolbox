import type { BrowserContext, Frame } from '@playwright/test';
import { problemReport } from '../../src/contracts/index.ts';
import { retireTimeoutMs } from '../../src/platform/index.ts';
import { connectBrowserCdp } from './support/browser-cdp.ts';
import {
  distPath,
  expect,
  fixtureOrigin,
  hostCount,
  indicatorTexts,
  insecureFixtureOrigin,
  openPopup,
  test,
} from './support/extension.ts';

// 확장을 다시 불러온 뒤 열린 탭의 옛 스크립트(결정 0008, N-13).
// 사용자가 "다시 로드"를 누르는 것과 같은 일을 CDP Extensions.loadUnpacked로 한다(R-04).
// 새 판이 프레임에 넣는 정리 함수는 그 페이지의 문맥에서 돈다. 일반 http 페이지는 보안 문맥이 아니라
// 보안 문맥에서만 있는 API가 없으므로, 루프백 출처(보안 문맥)와 일반 http 출처에서 같은 일을 확인한다.

test.use({ browserDebugging: true });

async function reloadExtension(profileDirectory: string, extensionId: string) {
  const cdp = await connectBrowserCdp(profileDirectory);
  try {
    expect(await cdp.send('Extensions.loadUnpacked', { path: distPath })).toEqual({
      id: extensionId,
    });
  } finally {
    cdp.close();
  }
}

// 지금 저장되어 있는 문제 기록(COM-5). 줄에 선 기록의 저장이 끝났는지는 보지 않으므로, 있을 기록을 기다릴 때만 쓴다.
async function readProblems(context: BrowserContext, extensionId: string): Promise<unknown> {
  const page = await openPopup(context, extensionId);
  try {
    return await page.evaluate(async (): Promise<unknown> => {
      const items: Record<string, unknown> = await chrome.storage.local.get('problems');
      return items['problems'] ?? [];
    });
  } finally {
    await page.close();
  }
}

// 문제 기록의 끝 표식. 시험만 쓰는 기능 id라 제품이 남기는 기록과 섞이지 않는다.
const endMarker = { featureId: 'e2e-end-marker', kind: 'cancelled' } as const;

const isEndMarker = (record: unknown) =>
  typeof record === 'object' &&
  record !== null &&
  'featureId' in record &&
  record.featureId === endMarker.featureId;

// 이미 줄에 선 문제 기록이 모두 저장된 뒤의 기록(표식은 뺀다). 서비스 워커는 문제 기록을 한 줄에서 들어온 차례대로
// 저장하고, problem.report에는 그 줄에서 저장을 마친 뒤 응답한다(결정 0006). 그래서 표식을 보내고 응답을 받은 뒤
// 읽으면 그 전에 줄에 선 기록은 저장이 얼마나 걸렸든 모두 들어 있다. 시험만을 위한 신호를 제품에 두지 않고 이 동작을 쓴다.
async function settledProblems(context: BrowserContext, extensionId: string): Promise<unknown[]> {
  const page = await openPopup(context, extensionId);
  try {
    const { response, problems } = await page.evaluate(
      async ({ type, payload }) => {
        const answer: unknown = await chrome.runtime.sendMessage({ type, payload });
        const items: Record<string, unknown> = await chrome.storage.local.get('problems');
        return { response: answer, problems: items['problems'] ?? [] };
      },
      { type: problemReport.type, payload: endMarker },
    );
    expect(response).toEqual({ ok: true, value: null });
    if (!Array.isArray(problems)) throw new Error('문제 기록이 배열이 아니다.');
    const records: unknown[] = problems;
    expect(records.filter(isEndMarker)).toHaveLength(1);
    return records.filter((record) => !isEndMarker(record));
  } finally {
    await page.close();
  }
}

// 서비스 워커의 타이머가 정한 때보다 늦게 도는 틈에 주는 여유(아래 problemsAfterRetire의 가정).
const timerSlackMs = 1000;

// 다시 불러온 판의 정리가 남긴 문제 기록. 정리가 페이지에 닿은 것을 본 뒤 바로 부른다. 보는 범위와 가정:
// - 정리는 모든 탭의 기다림을 탭 목록을 얻은 직후 함께 시작하고(정리가 페이지에 닿은 것은 그 뒤), 탭마다
//   retireTimeoutMs 안에 끝나거나 timeout으로 알리며 그 뒤의 결과는 버린다(결정 0008). 서비스 워커는 알린 문제를 그
//   자리에서 문제 기록의 줄에 세운다. 그래서 retireTimeoutMs가 지나면 정리가 시킨 기록은 모두 줄에 서 있다. 다만
//   서비스 워커의 타이머가 timerSlackMs보다 늦게 돌지 않는다고 본다(타이머가 도는 때에는 계약이 없다).
// - 줄에 선 기록이 저장되는 때에도 계약이 없으므로 시간으로 기다리지 않고 settledProblems로 확인한다.
// - 옛 콘텐츠 스크립트가 보내는 문제 알림(이슈 2의 시험)은 다시 불러온 뒤 disconnectSettleMs(0.5초)가 지나 보내므로
//   이때까지 줄에 선다고 본다(그 메시지가 수 초씩 늦지 않는다고 본다).
async function problemsAfterRetire(context: BrowserContext, extensionId: string) {
  await new Promise((resolve) => setTimeout(resolve, retireTimeoutMs + timerSlackMs));
  return settledProblems(context, extensionId);
}

// 문서에 물러남 이벤트가 닿은 횟수를 페이지 쪽에서 센다(결정 0008의 주된 방법).
async function countRetireEvents(frame: Frame) {
  await frame.evaluate(() => {
    document.documentElement.dataset['retireEvents'] = '0';
    document.addEventListener('browser-toolbox:retire', () => {
      const count = Number(document.documentElement.dataset['retireEvents']);
      document.documentElement.dataset['retireEvents'] = String(count + 1);
    });
  });
}

const retireEvents = (frame: Frame) =>
  frame.evaluate(() => document.documentElement.dataset['retireEvents']);

// 다시 로드 뒤 코드가 더 돌지 않는 옛 세계가 남긴 요소를 흉내 낸다(결정 0008 고친 기록, 드러난 것 1).
// 그런 세계는 iframe에서 자주 생기지만 늘 생기지는 않는다. 이 요소는 새 판의 정리 함수만 지울 수 있다.
async function addStaleElement(frame: Frame) {
  await frame.evaluate(() => {
    const stale = document.createElement('browser-toolbox-ui');
    stale.setAttribute('data-browser-toolbox', 'stale');
    document.documentElement.append(stale);
  });
}

const origins = [
  { label: '루프백 출처(보안 문맥)', origin: fixtureOrigin, secure: true },
  { label: '일반 http 출처(보안 문맥 아님)', origin: insecureFixtureOrigin, secure: false },
];

for (const { label, origin, secure } of origins) {
  test(`COM-7.1 COM-7.2 ${label}: 확장을 다시 불러오면 영상은 2배 그대로이고, 옛 스크립트가 더한 표시창이 남지 않는다`, async ({
    context,
    extensionId,
    profileDirectory,
  }) => {
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text());
    });
    await page.goto(`${origin}/video.html`);
    const childFrame = page.frames().find((frame) => frame.url().includes('video-only'));
    if (childFrame === undefined) throw new Error('iframe을 찾지 못했다.');
    const frames: readonly Frame[] = [page.mainFrame(), childFrame];
    // 이 시험이 보려는 문맥인지 먼저 확인한다. iframe은 조상이 보안 문맥이 아니면 보안 문맥이 아니다.
    for (const frame of frames) {
      expect(await frame.evaluate(() => isSecureContext)).toBe(secure);
    }
    for (const frame of frames) await countRetireEvents(frame);

    const popup = await openPopup(context, extensionId);
    await popup.getByRole('switch', { name: '미디어 배속' }).check();
    await expect.poll(() => indicatorTexts(page)).toEqual(['1×', '1×']);
    await page.evaluate(() => {
      const video = document.querySelector('video');
      if (video) video.playbackRate = 2;
    });
    await expect.poll(() => indicatorTexts(page)).toEqual(['1×', '2×']);
    for (const frame of frames) {
      await addStaleElement(frame);
      expect(await hostCount(frame)).toBe(2);
    }

    await reloadExtension(profileDirectory, extensionId);

    for (const frame of frames) {
      await expect.poll(() => retireEvents(frame)).not.toBe('0');
      await expect.poll(() => hostCount(frame)).toBe(0);
    }
    expect(await page.evaluate(() => document.querySelector('video')?.playbackRate)).toBe(2);
    expect(pageErrors).toEqual([]);
    // 정리 함수가 모든 프레임에서 끝까지 돌았으면 새 판은 문제를 기록하지 않는다. 함수가 페이지에서 예외를 내면
    // 여기에 unexpected가 남는다(quality 067, 2026-10-14 전에는 흔적 없이 지나갔다).
    expect(await problemsAfterRetire(context, extensionId)).toEqual([]);
  });
}

test('COM-7.2 결정 0008 로딩이 끝나지 않은 문서도 끝나기를 기다리지 않고 정리하며 문제로 기록하지 않는다', async ({
  context,
  extensionId,
  profileDirectory,
}) => {
  // 응답이 끝나지 않는 최상위 문서와, 그 안의 응답이 끝나지 않는 iframe(tests/server.ts의 /loading/).
  const page = await context.newPage();
  await page.goto(`${fixtureOrigin}/loading/blank.html`, { waitUntil: 'commit' });
  await expect(page.locator('p')).toHaveCount(1);
  await page.evaluate((src) => {
    const frame = document.createElement('iframe');
    frame.src = src;
    document.body.append(frame);
  }, `${fixtureOrigin}/loading/blank.html`);
  await expect(page.frameLocator('iframe').locator('p')).toHaveCount(1);
  const childFrame = page.frames().find((frame) => frame !== page.mainFrame());
  if (childFrame === undefined) throw new Error('iframe을 찾지 못했다.');
  const frames: readonly Frame[] = [page.mainFrame(), childFrame];
  for (const frame of frames) {
    expect(await frame.evaluate(() => document.readyState)).toBe('loading');
    await countRetireEvents(frame);
    await addStaleElement(frame);
  }

  await reloadExtension(profileDirectory, extensionId);

  for (const frame of frames) {
    await expect.poll(() => retireEvents(frame)).not.toBe('0');
    await expect.poll(() => hostCount(frame)).toBe(0);
    // 정리하는 동안 두 문서 모두 로딩 중이었다.
    expect(await frame.evaluate(() => document.readyState)).toBe('loading');
  }
  expect(await problemsAfterRetire(context, extensionId)).toEqual([]);
});

// 페이지의 스크립트로 돌면 문서에 표식을 남긴다. 직렬화해 넣으므로 바깥의 이름을 쓰지 않는다.
function markPageScriptRan(): void {
  document.documentElement.dataset['pageScriptRan'] = 'yes';
}

// 그 문서에서 페이지의 스크립트가 도는지. frame.evaluate는 sandbox의 스크립트 막기를 받지 않으므로(2026-10-14 실험)
// 타입 검사를 받는 함수(markPageScriptRan)를 직렬화해 스크립트 요소로 넣어 본다. 스크립트 요소는 그 문서의 규칙을 따른다.
async function runsPageScripts(frame: Frame): Promise<boolean> {
  return frame.evaluate((source) => {
    // eslint-disable-next-line no-restricted-syntax -- 페이지의 스크립트로 돌려야 한다. 넣는 코드는 위의 함수를 직렬화한 것이다.
    const script = document.createElement('script');
    script.textContent = source;
    document.documentElement.append(script);
    script.remove();
    return document.documentElement.dataset['pageScriptRan'] === 'yes';
  }, `(${markPageScriptRan.toString()})();`);
}

test('COM-7.1 COM-7.2 결정 0008 스크립트 실행이 막힌 sandbox iframe(allow-scripts 없음)에서도 정리 함수가 끝까지 돌아 옛 요소를 지우고 문제로 기록하지 않는다', async ({
  context,
  extensionId,
  profileDirectory,
}) => {
  const page = await context.newPage();
  await page.goto(`${fixtureOrigin}/sandbox-frames.html`);
  const sandboxed = page.frames().filter((frame) => frame !== page.mainFrame());
  expect(sandboxed).toHaveLength(3);
  // 이 시험이 보려는 문서인지 먼저 확인한다. 최상위에서는 페이지의 스크립트가 돌고, 세 iframe에서는 돌지 않는다.
  expect(await runsPageScripts(page.mainFrame())).toBe(true);
  for (const frame of sandboxed) expect(await runsPageScripts(frame)).toBe(false);
  // 그래도 콘텐츠 스크립트는 세 iframe에서 돈다(2026-10-14 실험, Chromium 156). 그래서 정리할 옛 스크립트가 있다.
  const popup = await openPopup(context, extensionId);
  await popup.getByRole('switch', { name: '미디어 배속' }).check();
  await expect.poll(() => indicatorTexts(page)).toEqual(['1×', '1×', '1×']);
  const frames: readonly Frame[] = [page.mainFrame(), ...sandboxed];
  for (const frame of frames) await addStaleElement(frame);

  await reloadExtension(profileDirectory, extensionId);

  // 흉내 낸 요소는 새 판의 정리 함수만 지운다. 네 문서 모두에서 지워졌으면 함수가 그 문서에서 돌았다.
  for (const frame of frames) await expect.poll(() => hostCount(frame)).toBe(0);
  // 함수가 끝까지 돌았다는 값을 돌려줬다. 결과가 null이었으면 다시 넣어도 null이라 unexpected가 남는다.
  expect(await problemsAfterRetire(context, extensionId)).toEqual([]);
});

test('COM-7 결정 0008 다시 불러올 때 스크립트를 넣을 수 없는 탭(오류 페이지, 버려진 탭)은 문제로 기록하지 않는다', async ({
  context,
  extensionId,
  profileDirectory,
}) => {
  const page = await context.newPage();
  await page.goto(`${fixtureOrigin}/blank.html`);
  await countRetireEvents(page.mainFrame());
  // 연결이 거부되는 주소. Chrome이 오류 페이지를 보이고 주소는 http 그대로라 정리할 탭 목록에 든다.
  const errorPage = await context.newPage();
  await errorPage.goto('http://127.0.0.1:9/').catch(() => undefined);
  // 버려진(discarded) 탭. 보고 있는 탭은 버릴 수 없어 다른 탭을 앞에 둔다.
  const discardUrl = `${fixtureOrigin}/video-only.html`;
  const toDiscard = await context.newPage();
  await toDiscard.goto(discardUrl);
  await page.bringToFront();
  const worker = context.serviceWorkers()[0];
  if (worker === undefined) throw new Error('서비스 워커가 없다.');
  expect(
    await worker.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === url);
      if (tab?.id === undefined) return false;
      return (await chrome.tabs.discard(tab.id))?.discarded ?? false;
    }, discardUrl),
  ).toBe(true);

  await reloadExtension(profileDirectory, extensionId);

  // 넣을 수 있는 탭에는 정리가 닿았고, 넣을 수 없는 두 탭의 거절은 문제 기록에 남지 않는다.
  await expect.poll(() => retireEvents(page.mainFrame())).not.toBe('0');
  expect(await problemsAfterRetire(context, extensionId)).toEqual([]);
});

test('COM-7 결정 0008 quality 068 주 스레드가 붙잡힌 탭은 다른 탭의 정리를 붙잡지 않고, 5초가 지나면 timeout으로 기록한다', async ({
  context,
  extensionId,
  profileDirectory,
}) => {
  // 붙잡을 탭은 일반 http 출처로 연다. 정리할 탭과 사이트가 달라 다른 프로세스에 뜬다(같은 프로세스면 함께 붙잡힌다).
  const busyPage = await context.newPage();
  await busyPage.goto(`${insecureFixtureOrigin}/blank.html`);
  const page = await context.newPage();
  await page.goto(`${fixtureOrigin}/blank.html`);
  await countRetireEvents(page.mainFrame());
  await addStaleElement(page.mainFrame());
  // 주 스레드를 12초 붙잡는다. 그동안 Chrome은 그 탭에 정리 함수를 돌리지 못한다(2026-10-14 실험).
  const busy = busyPage.evaluate((ms) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      // 붙잡는다.
    }
    return Date.now();
  }, 12_000);
  // 붙잡혔는지 확인한다. 페이지의 실행은 차례로 하므로 붙잡혀 있으면 다음 실행이 0.5초 안에 돌아오지 않는다.
  expect(
    await Promise.race([
      busyPage.evaluate(() => 'free'),
      new Promise((resolve) => setTimeout(resolve, 500, 'busy')),
    ]),
  ).toBe('busy');

  await reloadExtension(profileDirectory, extensionId);

  // 다른 탭은 붙잡힌 탭을 기다리지 않고 정리한다.
  await expect.poll(() => retireEvents(page.mainFrame())).not.toBe('0');
  await expect.poll(() => hostCount(page)).toBe(0);
  // 붙잡힌 탭은 제한 시간이 지나면 timeout으로 기록한다. 그 탭이 풀리기를 기다리지 않는다.
  await expect
    .poll(() => readProblems(context, extensionId), { timeout: 10_000 })
    .toEqual([expect.objectContaining({ featureId: null, kind: 'timeout' })]);
  const seenAt = Date.now();
  expect(seenAt).toBeLessThan(await busy);
  // 그 탭이 풀린 때(12초)는 정리가 기록을 시킬 수 있는 때(다시 불러온 뒤 retireTimeoutMs와 여유)가 지난 뒤다.
  // 줄에 선 기록이 모두 저장된 뒤에도 기록은 timeout 하나뿐이다.
  expect(await settledProblems(context, extensionId)).toEqual([
    expect.objectContaining({ featureId: null, kind: 'timeout' }),
  ]);
});

test('COM-5 COM-7 결정 0008 다시 불러오는 순간 오가던 옛 콘텐츠 스크립트의 요청이 끊겨도 문제로 기록하지 않는다', async ({
  context,
  extensionId,
  profileDirectory,
}) => {
  const page = await context.newPage();
  await page.goto(`${fixtureOrigin}/blank.html`);
  await countRetireEvents(page.mainFrame());
  const popup = await openPopup(context, extensionId);
  const worker = context.serviceWorkers()[0];
  if (worker === undefined) throw new Error('서비스 워커가 없다.');
  // 옛 서비스 워커의 주 스레드를 붙잡아, 그동안 보낸 요청이 응답을 받지 못하고 오가는 중이게 한다.
  // 다시 불러오면 Chrome이 이 서비스 워커를 끝내므로 이 평가는 거절된다.
  const busy = worker
    .evaluate(() => {
      const start = Date.now();
      while (Date.now() - start < 10_000) {
        // 붙잡는다.
      }
    })
    .catch(() => undefined);
  expect(
    await Promise.race([
      worker.evaluate(() => 'free'),
      new Promise((resolve) => setTimeout(resolve, 500, 'busy')),
    ]),
  ).toBe('busy');
  // 설정을 지우면 페이지의 콘텐츠 스크립트가 서비스 워커에 설정 준비(storage.ensureReady)를 부탁한다.
  // 저장소는 서비스 워커를 거치지 않으므로 붙잡힌 동안에도 지울 수 있다.
  await popup.evaluate(() => chrome.storage.local.remove('settings'));
  await popup.close();
  await new Promise((resolve) => setTimeout(resolve, 300));

  await reloadExtension(profileDirectory, extensionId);

  // 고치기 전에는 끊긴 요청이 platform으로 가려져, 그 문제 알림이 같은 id의 새 서비스 워커에 닿아 기록됐다(이슈 2).
  await expect.poll(() => retireEvents(page.mainFrame())).not.toBe('0');
  expect(await problemsAfterRetire(context, extensionId)).toEqual([]);
  await busy;
});
