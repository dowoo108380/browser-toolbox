import {
  type Recorded,
  attached,
  blankUrl,
  coveredUrl,
  expect,
  expectActiveLike,
  pageUrl,
  popupStates,
  recorder,
  stateText,
  test,
  turn,
  waitAttached,
} from './support/keep-active.ts';
import type { RawChromium } from './support/raw-chromium.ts';

// 페이지 활성 상태 유지(TAB-2)에서 몇 분을 기다려야 보이는 것: 숨긴 탭의 타이머(TAB-2.3)와 가짜 입력(TAB-2.10–2.15).
// 둘은 서로 다른 브라우저에서 함께 돈다. 보는 방법은 keep-active.spec.ts와 같다(support/raw-chromium.ts).

test.describe.configure({ mode: 'parallel' });

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

// 그 시각 뒤에 돈 타이머의 간격들(ms).
function intervalsAfter(record: Recorded, since: number): number[] {
  const ticks = record.ticks.filter((tick) => tick >= since);
  return ticks.slice(1).map((tick, index) => tick - (ticks[index] ?? tick));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

test.describe('타이머', () => {
  // Chrome이 숨긴 탭의 타이머를 크게 늦추기 시작하는 때(기본 5분)를 10초로 줄인다(2026-10-21 실험: 켜지 않은 숨긴 탭의 1초
  // 타이머가 약 1분 뒤 30·60초 간격이 되었다, 결정 0041).
  test.use({
    chromiumArgs: ['--enable-features=IntensiveWakeUpThrottling:grace_period_seconds/10'],
  });

  test('TAB-2.3 COM-7.5 켠 탭은 숨긴 탭의 타이머를 크게 늦추는 때가 지나도 1초 타이머의 간격 중앙값이 1.1초 이하이고 TAB-2.1이 성립한다. 같은 브라우저의 켜지 않은 숨긴 탭은 크게 늦춰진다', async ({
    raw,
  }) => {
    test.setTimeout(240_000);
    const on = await raw.open(pageUrl);
    const off = await raw.open(pageUrl);
    await raw.activate(on);
    await turn(raw, [on], true);
    const onPage = recorder(raw, on);
    await onPage.waitShield(true);
    await onPage.install();
    await recorder(raw, off).install();
    await raw.activate(await raw.open(blankUrl));
    await waitAttached(raw, on, true);
    // 늦추기가 자리 잡은 뒤의 구간만 본다.
    const start = Date.now();
    await sleep(150_000);
    const since = start + 60_000;
    const onRecord = await onPage.read();
    expect(median(intervalsAfter(onRecord, since))).toBeLessThanOrEqual(1100);
    expectActiveLike(onRecord);
    expect(Math.max(...intervalsAfter(await recorder(raw, off).read(), start))).toBeGreaterThan(
      20_000,
    );
    expect(await attached(raw, on)).toBe(true);
  });
});

// 페이지에서 돈다. 그 점들 가운데 안전하지 않은 곳(조작 요소나 손 모양 커서의 위, 영상·iframe 영역)을 준다(TAB-2 기대 동작 7).
function unsafePoints(points: readonly { readonly x: number; readonly y: number }[]): string[] {
  const controls =
    'a, button, input, select, textarea, video, audio, iframe, [role], [contenteditable], [aria-haspopup], [aria-expanded]';
  return points
    .filter(({ x, y }) => {
      const element = document.elementFromPoint(x, y);
      if (element === null) return true;
      return element.closest(controls) !== null || getComputedStyle(element).cursor === 'pointer';
    })
    .map(({ x, y }) => `${String(x)},${String(y)}`);
}

// 페이지에서 돈다. 화면에 그린 것을 영상으로 재생한다(시험 페이지의 영상에는 원본이 없다). 재생 중이면 참을 준다.
async function playVideo(): Promise<boolean> {
  const video = document.querySelector('video');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (video === null || context === null) return false;
  setInterval(() => {
    context.fillStyle = `hsl(${String(Date.now() % 360)} 50% 50%)`;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }, 100);
  video.srcObject = canvas.captureStream();
  await video.play();
  return !video.paused;
}

// 받은 마우스 움직임(위치).
const moves = (record: Recorded) =>
  record.inputs.filter((input) => input.type === 'mousemove').map(({ x, y }) => ({ x, y }));

// 사용자가 쓰는 보는 탭에 보낼 마우스 위치(시험 페이지의 빈 곳). 디버거가 붙은 동안 Chrome이 모든 창에 안내 막대를 띄워
// 페이지의 높이가 줄어드므로(R-09) 줄어든 화면 안에 둔다.
const userPoint = { x: 700, y: 300 };

test('TAB-2.10 TAB-2.11 TAB-2.12 TAB-2.13 TAB-2.14 TAB-2.15 보지 않는 켜진 탭은 3분 동안 안전한 곳의 마우스 움직임만 받아 자리 비움이 되지 않고, 안전한 곳이 없는 탭과 보는 탭에는 가짜 입력이 가지 않는다', async ({
  raw,
}) => {
  test.setTimeout(300_000);
  // 처음 창: 뒤에 둘 탭 둘(behind: 마지막 마우스가 단추 위, covered: 화면 전체가 단추)과 사용자가 쓰는 보는 탭(used).
  const behind = await raw.open(pageUrl);
  const covered = await raw.open(coveredUrl);
  const used = await raw.open(pageUrl);
  // 다른 창: 영상을 재생하고 입력이 없는 보는 탭(watching).
  const watching = await raw.open(pageUrl, await newWindow(raw));
  await raw.activate(behind);
  await turn(raw, [behind, covered, used, watching], true);
  const pages = {
    behind: recorder(raw, behind),
    covered: recorder(raw, covered),
    used: recorder(raw, used),
    watching: recorder(raw, watching),
  };
  for (const page of Object.values(pages)) await page.waitShield(true);
  // 2분 동안 입력이 없으면 자리 비움으로 판단한다(TAB-2.10).
  await pages.behind.install({ hiddenMs: 5000, idleMs: 120_000 });
  await pages.behind.installInFrame();
  for (const page of [pages.covered, pages.used, pages.watching]) await page.install();
  // 사용자가 behind의 단추 위에 마우스를 두고 다른 탭으로 간다(TAB-2.14).
  await raw.moveMouse(behind, 120, 40);
  expect((await pages.behind.read()).hovered).toContain('button');
  await pages.behind.clear();
  await raw.activate(watching);
  expect(await raw.evaluate(watching, playVideo, null)).toBe(true);
  // 사용자는 처음 창에서 쓴다. 그 창을 마지막에 앞으로 가져온다(초점이 없는 창에는 마우스가 가지 않는다). 다른 창의
  // watching도 그 창의 활성 탭이라 보는 탭이다.
  await raw.activate(used);
  await waitAttached(raw, behind, true);
  await waitAttached(raw, covered, true);
  // 3분 동안 사용자는 used에서 30초마다 마우스를 쓴다(TAB-2.12).
  let userMoves = 0;
  for (const deadline = Date.now() + 185_000; Date.now() < deadline;) {
    await raw.moveMouse(used, userPoint.x, userPoint.y);
    userMoves += 1;
    await sleep(Math.min(30_000, Math.max(0, deadline - Date.now())));
  }

  const behindRecord = await pages.behind.read();
  expect(behindRecord.away).toEqual([]);
  expect(behindRecord.inputs.every((input) => input.type === 'mousemove')).toBe(true);
  const fake = moves(behindRecord);
  expect(fake.length).toBeGreaterThanOrEqual(3);
  // 1픽셀씩 번갈아 쓰는 두 점이고, 모두 안전한 곳이다(단추 위가 아니다).
  const distinct = [...new Set(fake.map(({ x, y }) => `${String(x)},${String(y)}`))];
  expect(distinct.length).toBeLessThanOrEqual(2);
  expect(await raw.evaluate(behind, unsafePoints, fake)).toEqual([]);
  expect(
    behindRecord.hovered.filter((id) => ['button', 'link', 'video', 'frame'].includes(id)),
  ).toEqual([]);
  const frameRecord = await pages.behind.readFrame();
  expect([frameRecord.inputs, frameRecord.hovered]).toEqual([[], []]);
  expectActiveLike(behindRecord);

  // 안전한 곳이 없는 탭에는 보내지 않고 이유를 보인다(TAB-2.15).
  expect((await pages.covered.read()).inputs).toEqual([]);
  await popupStates(raw, (states) => {
    expect(states[String(covered.tabId)]).toBe(stateText.notice('no-safe-point', true));
  });

  // 보는 탭에는 디버거도 가짜 입력도 없다(TAB-2.12, TAB-2.13).
  expect(moves(await pages.used.read())).toEqual(
    Array.from({ length: userMoves }, () => userPoint),
  );
  expect(moves(await pages.watching.read())).toEqual([]);
  expect(await raw.evaluate(watching, () => !document.querySelector('video')?.paused, null)).toBe(
    true,
  );
  for (const tab of [used, watching]) expect(await attached(raw, tab)).toBe(false);
});

// 새 창을 열고 그 id를 준다(그 창의 첫 탭은 빈 탭이다).
async function newWindow(raw: RawChromium): Promise<number> {
  return raw.sw(async () => {
    const window = await chrome.windows.create({});
    if (window?.id === undefined) throw new Error('창 id가 없다.');
    return window.id;
  }, null);
}
