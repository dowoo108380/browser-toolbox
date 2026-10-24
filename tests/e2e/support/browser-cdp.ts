import { readFileSync } from 'node:fs';
import path from 'node:path';

// 브라우저 수준 CDP에 붙는다. Playwright의 지속 컨텍스트는 브라우저 객체를 주지 않으므로,
// Chromium이 프로필 폴더에 남기는 DevToolsActivePort 파일로 주소를 찾아 WebSocket으로 붙는다(R-04).
// Chromium을 --remote-debugging-port=0으로 띄워야 한다.

export interface BrowserCdp {
  readonly send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  readonly close: () => void;
}

export interface DevToolsAddress {
  readonly port: string;
  readonly browserPath: string;
}

// 파일의 줄. 아직 없거나(ENOENT) 막 생겨 Windows가 잠근 순간이면(EBUSY, 이슈 #22) 아직 없는 것으로 본다. 그 밖의 오류는 던진다.
function readLines(file: string): string[] | undefined {
  try {
    return readFileSync(file, 'utf8').trim().split('\n');
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      ['ENOENT', 'EBUSY'].includes(String(error.code))
    ) {
      return undefined;
    }
    throw error;
  }
}

// Chromium이 DevToolsActivePort(포트와 브라우저의 경로 두 줄)를 다 쓸 때까지 기다려 읽는다(시간 한도).
export async function readDevToolsActivePort(
  profileDirectory: string,
  ms: number,
): Promise<DevToolsAddress> {
  const file = path.join(profileDirectory, 'DevToolsActivePort');
  const deadline = Date.now() + ms;
  for (;;) {
    const [port, browserPath, ...rest] = readLines(file) ?? [];
    if (port !== undefined && browserPath !== undefined && rest.length === 0) {
      return { port, browserPath };
    }
    if (Date.now() > deadline) {
      throw new Error(`DevToolsActivePort를 ${String(ms)}ms 안에 읽지 못했다.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function connectBrowserCdp(profileDirectory: string): Promise<BrowserCdp> {
  const { port, browserPath } = await readDevToolsActivePort(profileDirectory, 10_000);
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
  const pending = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();
  socket.addEventListener('message', (event) => {
    const message: unknown = JSON.parse(String(event.data));
    if (typeof message !== 'object' || message === null || !('id' in message)) return;
    const resolve = pending.get(Number(message.id));
    pending.delete(Number(message.id));
    resolve?.({
      result: 'result' in message ? message.result : undefined,
      error: 'error' in message ? message.error : undefined,
    });
  });
  return {
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId;
        nextId += 1;
        pending.set(id, (message) => {
          if (message.error !== undefined) reject(new Error(JSON.stringify(message.error)));
          else resolve(message.result);
        });
        socket.send(JSON.stringify({ id, method, params }));
      }),
    close: () => {
      socket.close();
    },
  };
}
