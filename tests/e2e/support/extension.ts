import path from 'node:path';
import {
  type BrowserContext,
  type Frame,
  type Page,
  type Worker,
  test as base,
  chromium,
} from '@playwright/test';

// 빌드한 확장을 올린 Chromium(R-01). 테스트마다 새 프로필에서 시작한다(quality 104).

export const fixtureOrigin = 'http://127.0.0.1:4173';

// 같은 시험 페이지 서버를 보안 문맥이 아닌 일반 http 출처로 연다. Chromium은 localhost와 루프백 주소를 보안 문맥으로
// 보므로(fixtureOrigin도 보안 문맥이다), 다른 이름을 루프백에 이어 붙인다(아래 --host-resolver-rules).
// 보안 문맥에서만 있는 API(예: crypto.randomUUID)는 이 출처의 페이지와 그 iframe에 없다.
export const insecureFixtureOrigin = 'http://insecure.test:4173';

export const distPath = path.resolve(import.meta.dirname, '..', '..', '..', 'dist');

// 빌드한 확장을 올린 Chromium을 그 프로필로 띄운다. 닫은 뒤 같은 프로필로 다시 띄우면 브라우저를 다시 시작한 것이다.
// browserDebugging이 참이면 브라우저 수준 CDP에 붙을 수 있게 띄운다(확장 다시 불러오기, R-04).
export function launchWithExtension(
  profileDirectory: string,
  browserDebugging = false,
): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profileDirectory, {
    // 이 채널이어야 headless에서도 확장이 돈다(Playwright 문서).
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${distPath}`,
      `--load-extension=${distPath}`,
      `--host-resolver-rules=MAP ${new URL(insecureFixtureOrigin).hostname} 127.0.0.1`,
      ...(browserDebugging
        ? ['--remote-debugging-port=0', '--enable-unsafe-extension-debugging']
        : []),
    ],
  });
}

// 확장의 서비스 워커. 아직 뜨지 않았으면 뜰 때까지 기다린다.
export async function serviceWorkerOf(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
}

export const test = base.extend<{
  // 참이면 브라우저 수준 CDP에 붙을 수 있게 띄운다(확장 다시 불러오기, R-04).
  browserDebugging: boolean;
  profileDirectory: string;
  context: BrowserContext;
  extensionId: string;
}>({
  browserDebugging: [false, { option: true }],
  // eslint-disable-next-line no-empty-pattern -- Playwright는 첫 인자가 구조 분해 패턴이어야 의존하는 fixture를 안다.
  profileDirectory: async ({}, use, testInfo) => {
    await use(testInfo.outputPath('profile'));
  },
  context: async ({ browserDebugging, profileDirectory }, use) => {
    const context = await launchWithExtension(profileDirectory, browserDebugging);
    await use(context);
    // 시험이 먼저 닫았어도 된다(다시 시작 시험). 닫힌 컨텍스트를 다시 닫으면 아무 일도 하지 않는다.
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    await use(new URL((await serviceWorkerOf(context)).url()).host);
  },
});

export const expect = test.expect;

export async function openPopup(context: BrowserContext, extensionId: string): Promise<Page> {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  return popup;
}

interface ShadowNode {
  readonly nodeName: string;
  readonly nodeValue?: string;
  readonly children?: readonly ShadowNode[];
  readonly shadowRoots?: readonly ShadowNode[];
  readonly contentDocument?: ShadowNode;
}

// 확장의 화면 요소는 닫힌 shadow root 안에 있어 페이지에서는 보이지 않는다.
// CDP로 shadow root와 iframe까지 펼쳐 표시창의 글자를 모은다. CDP 세션 하나는 같은 프로세스의 iframe까지만 펼친다.
// 사이트가 다른 iframe은 다른 프로세스에 뜨므로(예: insecure.test 페이지 안의 127.0.0.1 iframe) 그 프레임의 세션으로 따로 읽는다.
export async function indicatorTexts(page: Page): Promise<string[]> {
  const sessions = [await page.context().newCDPSession(page)];
  try {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        sessions.push(await page.context().newCDPSession(frame));
      } catch (error) {
        // 같은 프로세스의 iframe은 따로 세션이 없다. 부모 프레임의 세션이 이미 펼친다.
        if (!(error instanceof Error) || !error.message.includes('separate CDP session')) {
          throw error;
        }
      }
    }
    const texts: string[] = [];
    const visit = (node: ShadowNode, insideHost: boolean) => {
      const isHost = node.nodeName === 'BROWSER-TOOLBOX-UI';
      if (insideHost && node.nodeName === '#text' && node.nodeValue !== undefined) {
        texts.push(node.nodeValue);
      }
      for (const child of [
        ...(node.children ?? []),
        ...(node.shadowRoots ?? []),
        ...(node.contentDocument ? [node.contentDocument] : []),
      ]) {
        visit(child, insideHost || isHost);
      }
    };
    for (const session of sessions) {
      const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
      visit(root, false);
    }
    // 스타일 시트의 글자는 빼고, 프레임 순서와 상관없이 비교하도록 정렬한다.
    return texts.filter((text) => !text.includes('{')).sort();
  } finally {
    for (const session of sessions) await session.detach();
  }
}

export function hostCount(frame: Frame | Page): Promise<number> {
  return frame.locator('browser-toolbox-ui').count();
}
