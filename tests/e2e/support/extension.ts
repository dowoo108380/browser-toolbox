import path from 'node:path';
import {
  type BrowserContext,
  type Frame,
  type Page,
  test as base,
  chromium,
} from '@playwright/test';

// 빌드한 확장을 올린 Chromium(R-01). 테스트마다 새 프로필에서 시작한다(quality 104).

const distPath = path.resolve(import.meta.dirname, '..', '..', '..', 'dist');

export const fixtureOrigin = 'http://127.0.0.1:4173';

export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright는 첫 인자가 구조 분해 패턴이어야 의존하는 fixture를 안다.
  context: async ({}, use, testInfo) => {
    const context = await chromium.launchPersistentContext(testInfo.outputPath('profile'), {
      // 이 채널이어야 headless에서도 확장이 돈다(Playwright 문서).
      channel: 'chromium',
      args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(new URL(worker.url()).host);
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
// CDP로 shadow root와 같은 프로세스의 iframe까지 펼쳐 표시창의 글자를 모은다.
export async function indicatorTexts(page: Page): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
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
    visit(root, false);
    // 스타일 시트의 글자는 빼고, 프레임 순서와 상관없이 비교하도록 정렬한다.
    return texts.filter((text) => !text.includes('{')).sort();
  } finally {
    await cdp.detach();
  }
}

export function hostCount(frame: Frame | Page): Promise<number> {
  return frame.locator('browser-toolbox-ui').count();
}
