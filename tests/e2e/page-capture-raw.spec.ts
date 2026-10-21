import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { capturePath } from '../../src/features/page-capture/core/filename.ts';
import {
  attached,
  blankUrl,
  closeTab,
  expect,
  expectActiveLike,
  pageUrl,
  recorder,
  test,
  turn,
  waitAttached,
} from './support/keep-active.ts';
import { fixtureOrigin } from './support/extension.ts';
import type { RawChromium, RawTab } from './support/raw-chromium.ts';

// 캡처(PAGE-1)를 Playwright 없이 직접 띄운 Chromium(support/raw-chromium.ts)으로 본다. Playwright는 다운로드를 맡아 Chrome이
// 정한 이름과 폴더를 볼 수 없고(R-11), 초점을 흉내 내 활성 상태 유지(TAB-2)를 볼 수 없다. 다운로드는 프로필 안의 폴더에
// 저장된다(사용자의 다운로드 폴더를 쓰지 않는다).

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

// 시험 페이지를 열어 그 창의 활성 탭으로 둔다.
async function openViewed(raw: RawChromium, url = pageUrl): Promise<RawTab> {
  const tab = await raw.open(url);
  await raw.activate(tab);
  return tab;
}

// 팝업에서 돈다. "페이지" 범주를 고르고 그 단추가 풀렸으면 누르고 참을 준다.
function pressCapture(label: string): boolean {
  const category = [...document.querySelectorAll<HTMLElement>('[role=tab]')].find(
    (tab) => tab.textContent === '페이지',
  );
  if (category?.getAttribute('aria-selected') !== 'true') category?.click();
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent === label,
  );
  if (button?.getAttribute('aria-disabled') !== null) return false;
  button.click();
  return true;
}

// 그 창의 지금 탭에서 팝업을 열어 전체 캡처를 시작하고 팝업을 닫은 뒤 끝난 작업의 기록을 준다. 팝업이 끝난 결과를 보이면 그
// 기록을 확인한 것으로 지우므로(COM-10) 팝업은 곧 닫는다.
async function fullCapture(raw: RawChromium, tab: RawTab): Promise<unknown> {
  const popup = await raw.popup(tab.windowId);
  try {
    await expect
      .poll(() => popup.evaluate(pressCapture, '전체 캡처'), { timeout: 10_000 })
      .toBe(true);
  } finally {
    await closeTab(raw, popup.tab);
  }
  const record = () =>
    raw.sw(async (id) => {
      const { tasks }: Record<string, unknown> = await chrome.storage.session.get('tasks');
      const found: unknown =
        typeof tasks === 'object' && tasks !== null ? Reflect.get(tasks, String(id)) : null;
      return found ?? null;
    }, tab.tabId);
  await expect
    .poll(async (): Promise<unknown> => Reflect.get(Object(await record()), 'status'), {
      timeout: 30_000,
    })
    .toMatch(/^(succeeded|failed)$/);
  return record();
}

const folderOf = (raw: RawChromium) => path.join(raw.downloads, 'full_page_screenshots');

// 페이지에서 돈다. 클립보드의 그림과 그 PNG(base64)를 풀어 크기와 모든 점이 같은지 준다.
async function sameAsClipboard(base64: string) {
  const items = await navigator.clipboard.read();
  const item = items.find((candidate) => candidate.types.includes('image/png'));
  if (item === undefined) return { copied: false, same: false };
  const pixels = async (blob: Blob) => {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('캔버스가 없다.');
    context.drawImage(bitmap, 0, 0);
    return {
      width: bitmap.width,
      data: context.getImageData(0, 0, bitmap.width, bitmap.height).data,
    };
  };
  const copied = await pixels(await item.getType('image/png'));
  const saved = await pixels(await (await fetch(`data:image/png;base64,${base64}`)).blob());
  const same =
    copied.width === saved.width &&
    copied.data.length === saved.data.length &&
    copied.data.every((value, index) => value === saved.data[index]);
  return { copied: true, same };
}
const listed = (raw: RawChromium) =>
  existsSync(folderOf(raw)) ? readdirSync(folderOf(raw)).sort() : [];

test('TAB-2.6 PAGE-1.23 활성 상태 유지가 켜진 탭에서 전체 캡처를 한 뒤에도, 그 탭을 떠나면 페이지가 계속 보이고 초점이 있으며 이벤트가 없다', async ({
  raw,
}) => {
  const tab = await openViewed(raw);
  await turn(raw, [tab], true);
  const page = recorder(raw, tab);
  await page.waitShield(true, { frame: true });
  expect(await fullCapture(raw, tab)).toMatchObject({ status: 'succeeded' });
  // 보는 탭이라 활성 상태 유지는 붙이지 않았고, 캡처가 붙인 연결은 끝나면 떨어진다.
  expect(await attached(raw, tab)).toBe(false);
  expect(listed(raw)).toHaveLength(1);
  // 캡처가 화면 높이를 바꿔 생긴 일은 빼고, 지금부터 기록한다.
  await page.install({ hiddenMs: 5000, idleMs: 600_000 });
  await page.clear();
  await openViewed(raw, blankUrl);
  await waitAttached(raw, tab, true);
  await sleep(8000);
  const record = await page.read();
  expectActiveLike(record);
  expect(record.away).toEqual([]);
  await raw.activate(tab);
  await waitAttached(raw, tab, false);
});

test('PAGE-1.19 전체 캡처는 다운로드 폴더의 full_page_screenshots에 날짜_시각_사이트.png로 묻지 않고 저장하고, 같은 이름이 있으면 번호를 붙인 새 파일로 저장하며 앞의 파일은 그대로다', async ({
  raw,
}) => {
  const tab = await openViewed(raw, blankUrl);
  const first = await fullCapture(raw, tab);
  expect(first).toMatchObject({ status: 'succeeded' });
  const [name] = listed(raw);
  expect(name).toMatch(/^\d{8}_\d{6}_127_0_0_1\.png$/);
  expect(Reflect.get(Object(first), 'summary')).toBe(
    `다운로드 폴더의 full_page_screenshots에 ${String(name)}로 저장했다. 클립보드에도 복사했다.`,
  );
  const png = readFileSync(path.join(folderOf(raw), String(name)));
  expect([...png.subarray(1, 4)].map((byte) => String.fromCharCode(byte)).join('')).toBe('PNG');

  // 다음 캡처가 고를 이름(지금부터 30초 동안의 시각)을 모두 미리 만들어 둔다.
  mkdirSync(folderOf(raw), { recursive: true });
  const now = Date.now();
  const taken = Array.from({ length: 30 }, (_unused, second) =>
    path.basename(capturePath('full', now + second * 1000, '127.0.0.1')),
  );
  for (const file of taken) writeFileSync(path.join(folderOf(raw), file), 'old');
  expect(await fullCapture(raw, tab)).toMatchObject({ status: 'succeeded' });
  const added = listed(raw).filter((file) => file !== name && !taken.includes(file));
  expect(added).toHaveLength(1);
  const [numbered] = added;
  expect(taken.map((file) => file.replace(/\.png$/, ' (1).png'))).toContain(numbered);
  for (const file of taken)
    expect(readFileSync(path.join(folderOf(raw), file), 'utf8')).toBe('old');
});

test.describe('Chrome의 "낯선 사이트에서 JavaScript 최적화 끄기"가 켜짐', () => {
  // 고급 세이프 브라우징과 Chrome의 실험이 켜는 설정이다. blob: 주소의 iframe을 다른 프로세스에 띄운다(결정 0047).
  test.use({ chromiumArgs: ['--enable-features=MigrateToBlockV8OptimizerOnUnfamiliarSites'] });

  test('PAGE-1.20 전체 캡처의 클립보드에 저장한 파일과 같은 그림이 복사된다', async ({ raw }) => {
    const tab = await openViewed(raw, blankUrl);
    expect(await fullCapture(raw, tab)).toMatchObject({
      status: 'succeeded',
      summary: expect.stringMatching(/클립보드에도 복사했다\.$/),
    });
    const [name] = listed(raw);
    const saved = readFileSync(path.join(folderOf(raw), String(name))).toString('base64');
    await raw.grantClipboard(fixtureOrigin);
    await raw.activate(tab);
    expect(await raw.evaluate(tab, sameAsClipboard, saved)).toEqual({ copied: true, same: true });
  });
});

test('PAGE-1.7 페이지 안에 다른 확장이 넣은 화면이 있는 탭에서 전체 캡처를 하면 그 까닭으로 실패하고 파일이 생기지 않는다', async ({
  raw,
}) => {
  const otherId = await raw.loadOtherExtension(
    path.resolve(import.meta.dirname, '..', 'fixtures', 'other-extension'),
  );
  const tab = await openViewed(raw, blankUrl);
  // 비밀번호 관리자 같은 다른 확장이 페이지에 화면을 넣은 것과 같다.
  await raw.evaluate(
    tab,
    (src) =>
      new Promise<null>((resolve) => {
        const frame = document.createElement('iframe');
        frame.src = src;
        frame.addEventListener('load', () => {
          resolve(null);
        });
        document.body.append(frame);
      }),
    `chrome-extension://${otherId}/frame.html`,
  );
  expect(await fullCapture(raw, tab)).toMatchObject({
    status: 'failed',
    error: {
      kind: 'permission',
      message:
        '이 탭에 디버거를 붙이지 못했다. 페이지 안에 다른 확장이 넣은 화면이 있거나 보안 경고 화면이면 Chrome이 막는다.',
    },
  });
  expect(listed(raw)).toEqual([]);
  expect(await attached(raw, tab)).toBe(false);
});
