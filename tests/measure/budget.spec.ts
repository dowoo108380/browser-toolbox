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

// 설정을 JSON으로 쓴 UTF-8 바이트 수(결정 0011의 크기 단위).
function settingsSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

// 사이트 하나의 항목. 사이트 설정이 있는 기능(PAGE-2 사이트 규칙, PAGE-3 사이트 예외)이 아직 없어, 결정 0011이 추정한
// 모양(선택자 약 110자 규칙 3개, 사이트 예외 하위 항목 7개의 켬·끔)을 측정 전용 기능 id로 둔다. 이 판이 모르는 기능의
// 사이트 항목이라 손상이 아니고, 읽기 도우미는 사이트마다 객체인지와 사이트 설정이 있는 기능이 있는지만 본다(결정 0017).
// 그 기능을 만들면 실제 id와 스키마로 바꿔 다시 잰다.
const fullSite = (index: number) => ({
  'measure-site-rules': {
    rules: [1, 2, 3].map(
      (rule) =>
        `main > div.layout-${String(index)} section[data-region="right-rail"] > div:nth-child(${String(rule)}) .advertisement a[href*="promo"]`,
    ),
  },
  'measure-site-exceptions': {
    paste: true,
    copy: false,
    contextMenu: true,
    select: false,
    drag: true,
    keyboard: false,
    leave: true,
  },
});
// 사이트 예외 하나만 둔 작은 항목. 한도 안에 사이트가 가장 많이 들어가는 쪽이다.
const smallSite = () => ({ 'measure-site-exceptions': { paste: true } });

// 기능은 모두 끈 설정을 bytes 바이트로 맞춘다. 사이트 항목을 sites.count개 두고, 남는 크기는 모르는 기능의 항목
// (measure-filler. 손상이 아니라 그대로 남는다)으로 채운다. 사이트가 많은 줄에서는 이것이 다른 기능 설정 17개 몫이다.
function settingsOfSize(
  bytes: number,
  sites: { readonly count: number; readonly entry: (index: number) => object },
) {
  const value = {
    version: 1,
    revision: 1_800_000_000_000,
    features: { 'media-speed': { enabled: false }, 'measure-filler': { note: '' } },
    sites: Object.fromEntries(
      Array.from({ length: sites.count }, (_, index) => [
        `www.site-${String(index).padStart(4, '0')}.example.com`,
        sites.entry(index),
      ]),
    ),
  };
  const filler = bytes - settingsSize(value);
  if (filler < 0) {
    throw new Error(`사이트 ${String(sites.count)}곳은 ${String(bytes)}바이트를 넘는다.`);
  }
  return {
    ...value,
    features: { ...value.features, 'measure-filler': { note: 'x'.repeat(filler) } },
  };
}

// bytes 바이트 안에, 다른 기능 설정 몫(4.5KB, 결정 0011의 추정)을 남기고 들어가는 사이트 수.
function sitesThatFit(bytes: number, entry: (index: number) => object): number {
  const one = settingsSize({ 'www.site-0000.example.com': entry(9999) });
  return Math.floor((bytes - 4_500) / one);
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

interface Measured {
  readonly label: string;
  readonly script: number;
  readonly task: number;
}

// 설정마다, 기능이 모두 꺼진 페이지(프레임 하나)에서 확장이 더 쓰는 주 스레드 시간(ms, 확장이 없을 때와의 차이)을 잰다.
// settings가 null이면 서비스 워커가 처음 쓴 기본 설정 그대로 잰다.
async function measureExtraCost(
  cases: readonly { readonly label: string; readonly settings: object | null }[],
): Promise<Measured[]> {
  const testInfo = test.info();
  const baselineContext = await launch(testInfo.outputPath('baseline'), false);
  const baseline = await costs(baselineContext);
  await baselineContext.close();

  const results: Measured[] = [];
  for (const [index, { label, settings }] of cases.entries()) {
    const context = await launch(testInfo.outputPath(`extension-${String(index)}`), true);
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await expect
      .poll(() => worker.evaluate(() => chrome.storage.local.get('settings')))
      .toMatchObject({ settings: { version: 1 } });
    if (settings !== null) {
      await worker.evaluate(async (value) => {
        await chrome.storage.local.set({ settings: value });
      }, settings);
    }
    const measured = await costs(context);
    // 잰 페이지들이 손상으로 보아 서비스 워커가 고쳐 쓰지 않았는지(잰 설정이 그대로인지) 본다.
    if (settings !== null) {
      expect(await worker.evaluate(() => chrome.storage.local.get('settings'))).toEqual({
        settings,
      });
    }
    await context.close();
    const script = round(measured.script - baseline.script);
    const task = round(measured.task - baseline.task);
    console.log(`확장 있음(${label}): 스크립트 +${String(script)}ms, 작업 +${String(task)}ms`);
    results.push({ label, script, task });
  }
  return results;
}

const realisticBytes = 28_365;
const nearLimitBytes = 261_000;

test('N-10 기능이 모두 꺼진 페이지에서 확장이 더 쓰는 주 스레드 시간', async () => {
  // 사이트 항목이 없는 한도 근처 설정은 크기만의 비용이다. 아래 알려진 초과 시험의 같은 크기 줄과 견주면 사이트 항목의
  // 비용이 보인다.
  const results = await measureExtraCost([
    { label: '기본 설정', settings: null },
    {
      label: '현실적 크기 27.7KB(사이트 50곳, 규칙 3개·예외 7개씩)',
      settings: settingsOfSize(realisticBytes, { count: 50, entry: fullSite }),
    },
    {
      label: '한도 근처 255KB(사이트 항목 없음)',
      settings: settingsOfSize(nearLimitBytes, { count: 0, entry: fullSite }),
    },
  ]);
  for (const { label, script, task } of results) {
    expect.soft(script, `${label}의 스크립트 시간`).toBeLessThanOrEqual(pageScriptTimeBudgetMs);
    expect.soft(task, `${label}의 작업 시간`).toBeLessThanOrEqual(pageTaskTimeBudgetMs);
  }
});

// 알려진 초과(이슈 #4). 한도 크기를 사이트 항목으로 채우면 작업 시간이 예산에 닿거나 넘는다. 비용은 바이트 수보다 설정 안의
// 객체 수를 따르고, 대부분은 확장 코드가 아니라 Chrome이 저장 값을 페이지의 객체로 만드는 데 든다(결정 0017 고친 기록).
// 지금은 사이트 항목을 쓰는 기능이 없어 이 상태에 이를 수 없다. 지금 상태를 고정하는 시험이다: 사이트 설정이 있는
// 기능(PAGE-2·3)을 만들며 고치면 마지막 확인이 실패하므로, 이 설정들을 위 예산 시험으로 옮기고 이슈 #4를 닫는다.
test('N-10 알려진 초과(이슈 #4): 한도 크기를 사이트 항목으로 채운 설정에서는 작업 시간이 예산을 넘는다', async () => {
  const full = sitesThatFit(nearLimitBytes, fullSite);
  const small = sitesThatFit(nearLimitBytes, smallSite);
  const results = await measureExtraCost([
    {
      label: `한도 근처 255KB(사이트 ${String(full)}곳, 규칙 3개·예외 7개씩)`,
      settings: settingsOfSize(nearLimitBytes, { count: full, entry: fullSite }),
    },
    {
      label: `한도 근처 255KB(사이트 ${String(small)}곳, 예외 1개씩)`,
      settings: settingsOfSize(nearLimitBytes, { count: small, entry: smallSite }),
    },
  ]);
  for (const { label, script } of results) {
    expect.soft(script, `${label}의 스크립트 시간`).toBeLessThanOrEqual(pageScriptTimeBudgetMs);
  }
  expect(
    Math.max(...results.map(({ task }) => task)),
    '사이트 항목이 많은 한도 크기 설정이 예산 안에 들었다. 이 설정들을 예산 시험으로 옮기고 이슈 #4를 닫는다.',
  ).toBeGreaterThan(pageTaskTimeBudgetMs);
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
