import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { type BrowserContext, chromium } from '@playwright/test';
import { connectBrowserCdp } from './support/browser-cdp.ts';
import { distPath, expect, test, watchServiceWorker } from './support/extension.ts';

// N-15: 설정 전체가 키 하나라(결정 0011) 그 키를 쓰는 도중 브라우저가 죽어도 값은 쓰기 전이나 뒤 하나여야 한다.
// 한도 크기의 두 값을 번갈아 쓰는 도중 브라우저 프로세스를 강제로 끝내고, 다시 띄워 저장된 값을 본다.
// 되풀이 횟수는 N15_ITERATIONS로 늘린다(05단계 확인은 30번). pnpm verify에서는 2번 돈다.

const iterations = Number(process.env['N15_ITERATIONS'] ?? '2');

// 큰 설정. ASCII 값은 250,124바이트로 크기 한도(262,144바이트)에 가깝고, 한글 값은 250,125글자(750,125바이트)로
// 한도를 넘는다. 쓰기 도우미를 거치지 않고 저장소에 직접 쓰므로 한도에 막히지 않는다. 큰 값을 쓰는 도중에
// 끊겨도 값이 온전한지만 본다. 모르는 기능의 항목은 손상이 아니므로 그대로 남는다(결정 0011).
function settingsOfSize(revision: number, enabled: boolean, fill: string) {
  return {
    version: 1,
    revision,
    features: {
      'media-speed': { enabled },
      'atomicity-filler': { note: fill.repeat(Math.floor(250_000 / fill.length)) },
    },
    sites: {},
  };
}

const valueA = settingsOfSize(1_800_000_000_001, true, 'a');
const valueB = settingsOfSize(1_800_000_000_002, false, '가');

async function launch(profileDirectory: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profileDirectory, {
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${distPath}`,
      `--load-extension=${distPath}`,
      '--remote-debugging-port=0',
    ],
  });
}

// CDP SystemInfo.getProcessInfo의 결과에서 브라우저 프로세스의 id를 찾는다.
function browserProcessId(info: unknown): number {
  const list: unknown =
    typeof info === 'object' && info !== null ? Reflect.get(info, 'processInfo') : null;
  if (Array.isArray(list)) {
    for (const item of list) {
      if (typeof item !== 'object' || item === null) continue;
      const id: unknown = Reflect.get(item, 'id');
      if (Reflect.get(item, 'type') === 'browser' && typeof id === 'number') return id;
    }
  }
  throw new Error('브라우저 프로세스를 찾지 못했다.');
}

async function serviceWorker(context: BrowserContext) {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
}

test.setTimeout(60_000 + iterations * 15_000);

test('N-15 설정을 쓰는 도중 브라우저가 강제로 끝나도 저장된 값은 쓰기 전이나 뒤 하나다', async ({
  profileDirectory,
}) => {
  const results: string[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const iterationProfile = `${profileDirectory}-${String(iteration)}`;
    let context = await launch(iterationProfile);
    const worker = await serviceWorker(context);
    // 서비스 워커가 시작할 때의 준비(기본 설정 쓰기)가 끝난 뒤 시작한다.
    await expect
      .poll(() => worker.evaluate(() => chrome.storage.local.get('settings')))
      .toMatchObject({ settings: { version: 1 } });
    await worker.evaluate(async (value) => {
      await chrome.storage.local.set({ settings: value });
    }, valueA);
    // 끝없이 번갈아 쓴다. 브라우저가 끝날 때까지 돈다.
    await worker.evaluate(
      ({ a, b }) => {
        void (async () => {
          for (let index = 0; ; index += 1) {
            Reflect.set(globalThis, 'atomicityWrites', index);
            await chrome.storage.local.set({ settings: index % 2 === 0 ? b : a });
          }
        })();
      },
      { a: valueA, b: valueB },
    );

    const cdp = await connectBrowserCdp(iterationProfile);
    const browserPid = browserProcessId(await cdp.send('SystemInfo.getProcessInfo'));
    cdp.close();
    await new Promise((resolve) => setTimeout(resolve, 20 + Math.floor(Math.random() * 300)));
    // 끝내기 직전까지 시작한 쓰기 수. 쓰기가 실제로 진행 중일 때 끝내는지 보려고 남긴다.
    const writes: unknown = await worker.evaluate((): unknown =>
      Reflect.get(globalThis, 'atomicityWrites'),
    );
    execFileSync('taskkill', ['/F', '/T', '/PID', String(browserPid)], { stdio: 'ignore' });
    await context.close().catch(() => undefined);

    context = await launch(iterationProfile);
    const restarted = await serviceWorker(context);
    const stored: unknown = await restarted.evaluate(() => chrome.storage.local.get('settings'));
    await context.close();
    const settings =
      typeof stored === 'object' && stored !== null && 'settings' in stored
        ? stored.settings
        : undefined;
    // Chrome은 저장할 때 객체 키를 정렬하므로 키 순서와 상관없이 비교한다.
    const outcome = isDeepStrictEqual(settings, valueA)
      ? 'A'
      : isDeepStrictEqual(settings, valueB)
        ? 'B'
        : `다름: ${JSON.stringify(settings ?? null).slice(0, 120)}`;
    results.push(`${outcome}(쓰기 ${String(writes)}번)`);
  }
  console.log(`N-15 결과: ${results.join(', ')}`);
  expect(results.every((outcome) => outcome.startsWith('A(') || outcome.startsWith('B('))).toBe(
    true,
  );
});

test('N-15 설정을 쓰는 도중 서비스 워커가 강제로 멈춰도 저장된 값은 쓰기 전이나 뒤 하나다', async ({
  profileDirectory,
}) => {
  const results: string[] = [];
  const context = await launch(profileDirectory);
  try {
    const page = await context.newPage();
    const workerStatus = await watchServiceWorker(page);
    let extensionId = new URL((await serviceWorker(context)).url()).host;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      if (workerStatus.last() !== 'running') {
        // 멈춘 서비스 워커를 확장 화면으로 다시 깨운다(팝업은 열릴 때 서비스 워커를 깨운다).
        const waker = await context.newPage();
        await waker.goto(`chrome-extension://${extensionId}/popup.html`);
        await workerStatus.reach('running');
        await waker.close();
      }
      const worker = context.serviceWorkers().at(-1);
      if (worker === undefined) throw new Error('서비스 워커가 없다.');
      extensionId = new URL(worker.url()).host;
      await worker.evaluate(async (value) => {
        await chrome.storage.local.set({ settings: value });
      }, valueA);
      await worker.evaluate(
        ({ a, b }) => {
          void (async () => {
            for (let index = 0; ; index += 1) {
              await chrome.storage.local.set({ settings: index % 2 === 0 ? b : a });
            }
          })();
        },
        { a: valueA, b: valueB },
      );
      await new Promise((resolve) => setTimeout(resolve, 20 + Math.floor(Math.random() * 300)));
      // 멈춘 것만 본다. 오가던 쓰기가 곧 다시 깨워도 새 서비스 워커는 쓰기를 이어 하지 않는다(이슈 #5).
      await workerStatus.interrupt();
      // 서비스 워커가 아닌 곳(확장 화면)에서 읽는다.
      const reader = await context.newPage();
      await reader.goto(`chrome-extension://${extensionId}/popup.html`);
      const stored: unknown = await reader.evaluate(() => chrome.storage.local.get('settings'));
      await reader.close();
      const settings =
        typeof stored === 'object' && stored !== null && 'settings' in stored
          ? stored.settings
          : undefined;
      results.push(
        isDeepStrictEqual(settings, valueA)
          ? 'A'
          : isDeepStrictEqual(settings, valueB)
            ? 'B'
            : '다름',
      );
    }
  } finally {
    await context.close();
  }
  console.log(`N-15 서비스 워커 멈춤 결과: ${results.join(', ')}`);
  expect(results.every((outcome) => outcome === 'A' || outcome === 'B')).toBe(true);
});
