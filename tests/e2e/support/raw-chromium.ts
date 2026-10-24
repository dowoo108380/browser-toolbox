import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { readDevToolsActivePort } from './browser-cdp.ts';
import { distPath, insecureFixtureOrigin } from './extension.ts';

// 보임과 초점을 보는 확장 전체 시험(TAB-2)의 Chromium. Playwright는 조종하는 페이지마다 초점을 흉내 내므로(R-02) 탭을 떠나도
// 페이지가 "보임, 초점 있음"으로 나온다. 그래서 Playwright가 받은 Chromium을 직접 띄우고 브라우저 수준 CDP에만 붙는다. 페이지에는
// 함수 계산과 마우스 움직임만 보내고, 초점이나 보임을 흉내 내지 않는다. 계산할 때만 잠깐 붙었다가 뗀다. 확장의 디버거와는 함께
// 붙는다(Chrome의 다중 연결). 탭과 창은 확장의 서비스 워커에서 chrome.* API로 다룬다(사용자가 하는 것과 같은 길).
// 화면 없는 새 headless로 띄운다. 이 모드에서도 탭을 바꾸거나 창을 최소화하면 페이지가 숨김이 되고, 초점 흉내를 켠 탭의 전체
// 화면은 탭 안에서만 된다. 창끼리 초점을 옮기는 것과 다른 창에 가려지는 것은 없다(2026-10-21 실험, 결정 0041). 시험에서만 쓴다.

// 페이지나 서비스 워커에서 돌 함수. 바깥의 이름을 쓰지 않고, 인자와 값은 JSON으로 오간다(Playwright의 evaluate와 같다).
type Remote<A, R> = (arg: A) => R;

export interface RawTab {
  readonly tabId: number;
  readonly windowId: number;
  // 그 탭의 최상위 프레임의 CDP 대상.
  readonly targetId: string;
}

export interface RawChromiumOptions {
  // Chromium에 더 줄 인자.
  readonly args?: readonly string[];
}

export interface Popup {
  // 팝업 문서에서 함수를 계산한다.
  readonly evaluate: <A, R>(fn: Remote<A, R>, arg: A) => Promise<Awaited<R>>;
  readonly tab: RawTab;
}

export interface RawChromium {
  readonly extensionId: string;
  // 다운로드가 저장되는 폴더(프로필 안). 사용자의 다운로드 폴더를 쓰지 않는다.
  readonly downloads: string;
  // 처음 열린 창.
  readonly windowId: number;
  // 확장의 서비스 워커에서 함수를 계산한다.
  readonly sw: <A, R>(fn: Remote<A, R>, arg: A) => Promise<Awaited<R>>;
  // 그 창(없으면 처음 창)에 뒤쪽 탭을 열고 문서를 다 실을 때까지 기다린다.
  readonly open: (url: string, windowId?: number) => Promise<RawTab>;
  // 그 탭을 그 창의 활성 탭으로 하고 창을 앞으로 가져온다(사용자가 탭을 누른 것과 같다). 서비스 워커를 거치지 않는다.
  readonly activate: (tab: RawTab) => Promise<void>;
  // 그 탭의 최상위 문서에서 함수를 계산한다. userGesture면 사용자가 누른 것으로 친다(전체 화면 요청 등).
  readonly evaluate: <A, R>(
    tab: RawTab,
    fn: Remote<A, R>,
    arg: A,
    options?: { readonly userGesture?: boolean },
  ) => Promise<Awaited<R>>;
  // 그 탭의 최상위 문서 바로 안에 있는, 다른 사이트의 iframe(주소에 urlPart가 든 것)에서 함수를 계산한다. 같은 사이트의
  // iframe은 최상위와 같은 프로세스라 따로 대상이 없다.
  readonly evaluateInFrame: <A, R>(
    tab: RawTab,
    urlPart: string,
    fn: Remote<A, R>,
    arg: A,
  ) => Promise<Awaited<R>>;
  // 그 탭에 진짜 마우스 움직임을 보낸다(사용자가 마우스를 그곳에 둔 것).
  readonly moveMouse: (tab: RawTab, x: number, y: number) => Promise<void>;
  // 그 출처(예: https://chatgpt.com)의 모든 요청에 그 HTML로 답한다(Playwright의 route와 같다). 브라우저 수준 CDP의 Fetch로
  // 가로채므로 페이지에 붙지 않는다.
  readonly serve: (origin: string, html: string) => Promise<void>;
  // 팝업 문서를 그 창(없으면 처음 창)의 뒤쪽 탭으로 연다. 실제 팝업처럼 그 창의 탭 목록을 보인다.
  readonly popup: (windowId?: number) => Promise<Popup>;
  // 확장을 다시 불러온다(사용자가 "다시 로드"를 누른 것과 같다, R-04). 새 서비스 워커에 붙는다.
  readonly reloadExtension: () => Promise<void>;
  // 다른 확장을 그 폴더에서 올리고 그 id를 준다.
  readonly loadOtherExtension: (folder: string) => Promise<string>;
  // 그 출처의 페이지가 클립보드를 읽게 한다(캡처의 복사를 보는 시험). 읽는 페이지는 초점이 있어야 한다(activate).
  readonly grantClipboard: (origin: string) => Promise<void>;
  // 서비스 워커를 강제로 멈춘다(Chrome이 쉬는 서비스 워커를 멈춘 것과 같다). 다음 사건이 다시 깨운다.
  readonly stopServiceWorkers: () => Promise<void>;
  // 브라우저를 닫는다. 이미 닫았으면 할 일이 없다.
  readonly close: () => Promise<void>;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

// 값이 나올 때까지 기다린다(시간 한도).
async function until<T>(read: () => Promise<T | undefined>, ms: number, what: string): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${what}을(를) ${String(ms)}ms 안에 보지 못했다.`);
    await sleep(50);
  }
}

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;

// 함수와 인자를 계산할 식으로 만든다.
const expressionOf = <A, R>(fn: Remote<A, R>, arg: A): string =>
  `(${fn.toString()})(${arg === undefined ? 'undefined' : JSON.stringify(arg)})`;

// JSON으로 돌아온 값. 함수가 낸 값의 형을 믿는다(Playwright의 evaluate와 같다).
function returned<R>(value: unknown): Awaited<R> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- 형 검사를 받은 그 함수가 낸 값이다.
  return value as Awaited<R>;
}

interface TargetInfo {
  readonly targetId: string;
  readonly type: string;
  readonly url: string;
  readonly parentFrameId: unknown;
}

export async function launchRawChromium(
  profileDirectory: string,
  { args = [] }: RawChromiumOptions = {},
): Promise<RawChromium> {
  // 같은 프로필로 다시 띄우면(브라우저 다시 시작) 앞 실행이 남긴 주소를 읽지 않게 먼저 지운다.
  const portFile = path.join(profileDirectory, 'DevToolsActivePort');
  rmSync(portFile, { force: true });
  // 다운로드(캡처, PAGE-1)는 프로필 안의 폴더에 묻지 않고 저장한다. 처음 띄울 때만 적는다(다시 띄우면 Chrome이 쓴 설정을 둔다).
  // CDP로 다운로드를 맡기면 Chrome이 확장이 준 파일 이름과 하위 폴더를 쓰지 않으므로(2026-10-21 실험) 프로필의 설정으로 한다.
  const downloads = path.join(profileDirectory, 'downloads');
  const preferences = path.join(profileDirectory, 'Default', 'Preferences');
  if (!existsSync(preferences)) {
    mkdirSync(path.dirname(preferences), { recursive: true });
    writeFileSync(
      preferences,
      // eslint-disable-next-line @typescript-eslint/naming-convention -- Chrome 설정 파일의 이름이다.
      JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }),
    );
  }
  const child: ChildProcess = spawn(
    chromium.executablePath(),
    [
      `--user-data-dir=${profileDirectory}`,
      '--remote-debugging-port=0',
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--headless=new',
      '--window-size=1000,700',
      `--disable-extensions-except=${distPath}`,
      `--load-extension=${distPath}`,
      `--host-resolver-rules=MAP ${new URL(insecureFixtureOrigin).hostname} 127.0.0.1`,
      ...args,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve();
    });
  });
  const { port, browserPath } = await readDevToolsActivePort(profileDirectory, 15_000);
  const socket = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => {
      resolve();
    });
    socket.addEventListener('error', () => {
      reject(new Error('브라우저 CDP에 붙지 못했다.'));
    });
  });
  let nextId = 1;
  const pending = new Map<
    number,
    { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
  >();
  // serve가 답할 출처와 그 HTML.
  const served = new Map<string, string>();
  socket.addEventListener('message', (event) => {
    const message: unknown = JSON.parse(String(event.data));
    if (field(message, 'method') === 'Fetch.requestPaused') {
      answerPaused(field(message, 'params'));
      return;
    }
    const id = field(message, 'id');
    if (typeof id !== 'number') return;
    const waiter = pending.get(id);
    pending.delete(id);
    const error = field(message, 'error');
    if (error !== undefined) waiter?.reject(new Error(JSON.stringify(error)));
    else waiter?.resolve(field(message, 'result'));
  });
  // CDP 요청 하나. 답이 없으면 그 요청의 이름으로 실패한다(시험 전체의 한도에 걸리기 전에 어디서 멈췄는지 보이게).
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method}의 답이 20초 동안 없다.`));
      }, 20_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(
        JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }),
      );
    });

  // 가로챈 요청에 그 출처의 HTML로 답한다. 가로채는 것은 serve한 출처뿐이다. 답하지 못하면(탭이 그 사이 닫힘) 할 일이 없다.
  function answerPaused(params: unknown) {
    const requestId = field(params, 'requestId');
    const html = served.get(new URL(String(field(field(params, 'request'), 'url'))).origin);
    const answer =
      html === undefined
        ? send('Fetch.continueRequest', { requestId })
        : send('Fetch.fulfillRequest', {
            requestId,
            responseCode: 200,
            responseHeaders: [{ name: 'content-type', value: 'text/html; charset=utf-8' }],
            body: Buffer.from(html, 'utf8').toString('base64'),
          });
    answer.catch(() => undefined);
  }

  const targets = async (): Promise<TargetInfo[]> => {
    const infos = field(await send('Target.getTargets'), 'targetInfos');
    if (!Array.isArray(infos)) return [];
    return infos.map((info: unknown) => ({
      targetId: String(field(info, 'targetId')),
      type: String(field(info, 'type')),
      url: String(field(info, 'url')),
      parentFrameId: field(info, 'parentFrameId'),
    }));
  };

  // 대상에 붙어 일을 하고 뗀다.
  const withSession = async <T>(targetId: string, work: (sessionId: string) => Promise<T>) => {
    const attached = await send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = String(field(attached, 'sessionId'));
    try {
      return await work(sessionId);
    } finally {
      await send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
    }
  };

  const thrownPrefix = '함수가 던졌다';
  const evaluateOn = async <A, R>(
    targetId: string,
    fn: Remote<A, R>,
    arg: A,
    userGesture = false,
  ): Promise<Awaited<R>> => {
    const result = await withSession(targetId, (sessionId) =>
      send(
        'Runtime.evaluate',
        { expression: expressionOf(fn, arg), awaitPromise: true, returnByValue: true, userGesture },
        sessionId,
      ),
    );
    const exception = field(result, 'exceptionDetails');
    if (exception !== undefined) throw new Error(`${thrownPrefix}: ${JSON.stringify(exception)}`);
    return returned<R>(field(field(result, 'result'), 'value'));
  };

  // 이 확장의 서비스 워커(다른 확장이나 Chrome 내장 확장의 것과 섞여 있다). 막 뜬 서비스 워커는 확장 API가 아직 없을 수 있어
  // 생길 때까지 기다린다.
  const findWorker = () =>
    until(
      async () => {
        const found = (await targets()).find(
          (target) => target.type === 'service_worker' && target.url.endsWith('/sw.js'),
        );
        if (found === undefined) return undefined;
        const ready = await evaluateOn(found.targetId, () => typeof chrome, null).catch(
          () => undefined,
        );
        return ready === 'object' ? found : undefined;
      },
      15_000,
      '확장의 서비스 워커',
    );
  let worker = await findWorker();
  const extensionId = new URL(worker.url).host;
  const sw = async <A, R>(fn: Remote<A, R>, arg: A): Promise<Awaited<R>> => {
    try {
      return await evaluateOn(worker.targetId, fn, arg);
    } catch (error) {
      // 함수가 던진 것은 그대로 던진다. 붙지 못했으면 서비스 워커가 멈췄다가 다시 떴을 수 있어 새 대상에 다시 한 번 붙는다.
      if (error instanceof Error && error.message.startsWith(thrownPrefix)) throw error;
      worker = await findWorker();
      return evaluateOn(worker.targetId, fn, arg);
    }
  };

  // 탭 id로 그 탭의 대상을 찾고, 문서를 다 실을 때까지 기다린다. 서비스 워커에서 묻는다(Chrome 내부 화면에도 된다).
  const tabOf = async (tabId: number, windowId: number): Promise<RawTab> => {
    const targetId = await until(
      async () =>
        (await sw(async (id) => {
          const tab = await chrome.tabs.get(id);
          const target = (await chrome.debugger.getTargets()).find((t) => t.tabId === id);
          return tab.status === 'complete' && target !== undefined ? target.id : null;
        }, tabId)) ?? undefined,
      15_000,
      `탭 ${String(tabId)}의 대상과 문서 싣기`,
    );
    return { tabId, windowId, targetId };
  };

  const windowId = await sw(async () => {
    const [first] = await chrome.windows.getAll();
    if (first?.id === undefined) throw new Error('창이 없다.');
    return first.id;
  }, null);

  const open = async (url: string, inWindow = windowId) => {
    const tabId = await sw(
      async (properties) => {
        const tab = await chrome.tabs.create(properties);
        if (tab.id === undefined) throw new Error('탭 id가 없다.');
        return tab.id;
      },
      { url, active: false, windowId: inWindow },
    );
    return tabOf(tabId, inWindow);
  };

  return {
    extensionId,
    downloads,
    windowId,
    sw,
    open,
    activate: async (tab) => {
      await send('Target.activateTarget', { targetId: tab.targetId });
    },
    evaluate: (tab, fn, arg, options = {}) =>
      evaluateOn(tab.targetId, fn, arg, options.userGesture === true),
    evaluateInFrame: async <A, R>(
      tab: RawTab,
      urlPart: string,
      fn: Remote<A, R>,
      arg: A,
    ): Promise<Awaited<R>> => {
      // 다른 사이트의 iframe은 다른 프로세스에 떠 대상이 따로 있다. 부모 프레임의 id는 최상위 프레임의 대상 id와 같다.
      const frame = (await targets()).find(
        (target) =>
          target.type === 'iframe' &&
          target.parentFrameId === tab.targetId &&
          target.url.includes(urlPart),
      );
      if (frame === undefined) throw new Error(`${urlPart} iframe의 대상이 없다.`);
      return evaluateOn(frame.targetId, fn, arg);
    },
    moveMouse: (tab, x, y) =>
      withSession(tab.targetId, async (sessionId) => {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
      }),
    serve: async (origin, html) => {
      served.set(origin, html);
      await send('Fetch.enable', {
        patterns: [...served.keys()].map((key) => ({ urlPattern: `${key}/*` })),
      });
    },
    popup: async (inWindow = windowId) => {
      const tab = await open(`chrome-extension://${extensionId}/popup.html`, inWindow);
      return { tab, evaluate: (fn, arg) => evaluateOn(tab.targetId, fn, arg) };
    },
    reloadExtension: async () => {
      const reloaded = await send('Extensions.loadUnpacked', { path: distPath });
      if (field(reloaded, 'id') !== extensionId) throw new Error('다른 id로 다시 올라왔다.');
      // 앞 서비스 워커의 대상이 사라질 때까지 기다린 뒤 새 대상을 찾는다.
      const old = worker.targetId;
      await until(
        async () =>
          (await targets()).some((target) => target.targetId === old) ? undefined : true,
        10_000,
        '앞 서비스 워커가 사라짐',
      );
      worker = await findWorker();
    },
    loadOtherExtension: async (folder) => {
      const loaded = field(await send('Extensions.loadUnpacked', { path: folder }), 'id');
      if (typeof loaded !== 'string') throw new Error('다른 확장을 올리지 못했다.');
      return loaded;
    },
    grantClipboard: async (origin) => {
      await send('Browser.grantPermissions', {
        permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
        origin,
      });
    },
    stopServiceWorkers: async () => {
      // ServiceWorker 도메인은 페이지의 세션에서 쓴다(Playwright로 하는 시험과 같은 길, support/extension.ts).
      const page = (await targets()).find((target) => target.type === 'page');
      if (page === undefined) throw new Error('붙을 페이지가 없다.');
      await withSession(page.targetId, async (sessionId) => {
        await send('ServiceWorker.enable', {}, sessionId);
        await send('ServiceWorker.stopAllWorkers', {}, sessionId);
      });
      const old = worker.targetId;
      await until(
        async () =>
          (await targets()).some((target) => target.targetId === old) ? undefined : true,
        10_000,
        '서비스 워커가 멈춤',
      );
    },
    // 저장소의 쓰기를 마치고 끝나게 CDP로 닫고(사용자가 창을 모두 닫은 것과 같다), 끝나지 않으면 죽인다.
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      send('Browser.close').catch(() => undefined);
      const closed = await Promise.race([exited.then(() => true), sleep(10_000).then(() => false)]);
      socket.close();
      if (!closed) {
        child.kill();
        await exited;
      }
    },
  };
}
