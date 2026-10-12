import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { type BrowserContext, chromium, expect, test } from '@playwright/test';
import {
  packageBudgetBytes,
  pageScriptBudgetBytes,
  pageScriptTimeBudgetMs,
  pageTaskTimeBudgetMs,
  popupReadyBudgetMs,
} from '../../scripts/budgets.ts';

// 성능 예산(quality 079, N-10)을 잰다. 이 PC와 Playwright의 Chromium(headless) 기준이다.
// 예산은 scripts/budgets.ts에 있고, 넘으면 실패한다. 시각이 흔들리므로 pnpm verify에는 넣지 않는다(quality 110).

const root = path.resolve(import.meta.dirname, '..', '..');
const distPath = path.join(root, 'dist');
const pageUrl = 'http://127.0.0.1:4173/blank.html';
const samples = Number(process.env['MEASURE_SAMPLES'] ?? '15');

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

// 기능은 모두 끄고, 모르는 기능의 항목으로 크기를 맞춘 설정(그 항목은 손상이 아니라 그대로 남는다).
function settingsOfSize(bytes: number) {
  const base = {
    version: 1,
    revision: 1_800_000_000_000,
    features: { 'media-speed': { enabled: false }, 'measure-filler': { note: '' } },
    sites: {},
  };
  const filler = 'x'.repeat(Math.max(0, bytes - JSON.stringify(base).length));
  return { ...base, features: { ...base.features, 'measure-filler': { note: filler } } };
}

async function launch(directory: string, withExtension: boolean): Promise<BrowserContext> {
  return chromium.launchPersistentContext(directory, {
    channel: 'chromium',
    args: withExtension
      ? [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`]
      : [],
  });
}

// 새 탭에서 빈 페이지를 열고, 그 페이지가 쓴 주 스레드 시간(ms)을 잰다.
// 이동하면 값이 다시 세어지므로 측정을 먼저 켜고 이동한다.
async function pageCost(context: BrowserContext): Promise<{ script: number; task: number }> {
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  await session.send('Performance.enable');
  await page.goto(pageUrl);
  // 콘텐츠 스크립트가 설정을 읽고 끝낼 시간을 준다.
  await page.waitForTimeout(300);
  const { metrics } = await session.send('Performance.getMetrics');
  await page.close();
  const value = (name: string) => metrics.find((metric) => metric.name === name)?.value ?? 0;
  return { script: value('ScriptDuration') * 1000, task: value('TaskDuration') * 1000 };
}

async function costs(context: BrowserContext) {
  // 처음 한 번은 버린다(프로세스 시작 비용).
  await pageCost(context);
  const script: number[] = [];
  const task: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const cost = await pageCost(context);
    script.push(cost.script);
    task.push(cost.task);
  }
  return { script: median(script), task: median(task) };
}

test('N-10 기능이 모두 꺼진 페이지에서 확장이 더 쓰는 주 스레드 시간', async () => {
  const testInfo = test.info();
  const baselineContext = await launch(testInfo.outputPath('baseline'), false);
  const baseline = await costs(baselineContext);
  await baselineContext.close();

  for (const [label, bytes] of [
    ['기본 설정', 0],
    ['현실적 크기 27.7KB', 28_365],
    ['한도 근처 255KB', 261_000],
  ] as const) {
    const context = await launch(testInfo.outputPath(`extension-${String(bytes)}`), true);
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await expect
      .poll(() => worker.evaluate(() => chrome.storage.local.get('settings')))
      .toMatchObject({ settings: { version: 1 } });
    if (bytes > 0) {
      await worker.evaluate(async (value) => {
        await chrome.storage.local.set({ settings: value });
      }, settingsOfSize(bytes));
    }
    const measured = await costs(context);
    await context.close();
    const script = round(measured.script - baseline.script);
    const task = round(measured.task - baseline.task);
    console.log(`확장 있음(${label}): 스크립트 +${String(script)}ms, 작업 +${String(task)}ms`);
    expect.soft(script, `${label}의 스크립트 시간`).toBeLessThanOrEqual(pageScriptTimeBudgetMs);
    expect.soft(task, `${label}의 작업 시간`).toBeLessThanOrEqual(pageTaskTimeBudgetMs);
  }
});

test('002 팝업이 열려 조작할 수 있게 되기까지의 시간', async () => {
  const context = await launch(test.info().outputPath('popup'), true);
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  const times: number[] = [];
  for (let index = 0; index <= samples; index += 1) {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.getByRole('switch', { name: '미디어 배속' })).toBeEnabled();
    // 문서를 열기 시작한 때부터 스위치를 쓸 수 있게 된 때까지(ms). 처음 한 번은 버린다.
    const elapsed = await popup.evaluate(() => performance.now());
    if (index > 0) times.push(elapsed);
    await popup.close();
  }
  await context.close();
  const ready = round(median(times));
  console.log(`팝업이 조작 가능해지기까지: 중앙값 ${String(ready)}ms`);
  expect(ready).toBeLessThanOrEqual(popupReadyBudgetMs);
});

test('079 모든 페이지에 실리는 스크립트와 배포 파일의 크기', () => {
  const manifest: unknown = JSON.parse(readFileSync(path.join(distPath, 'manifest.json'), 'utf8'));
  const version: unknown =
    typeof manifest === 'object' && manifest !== null ? Reflect.get(manifest, 'version') : '';
  const contentScript = statSync(path.join(distPath, 'content-common.js')).size;
  const zip = statSync(path.join(root, 'artifacts', `browser-toolbox-${String(version)}.zip`)).size;
  console.log(
    `모든 페이지에 실리는 스크립트 ${String(contentScript)}바이트, 배포 ZIP ${String(zip)}바이트`,
  );
  expect(contentScript).toBeLessThanOrEqual(pageScriptBudgetBytes);
  expect(zip).toBeLessThanOrEqual(packageBudgetBytes);
});
