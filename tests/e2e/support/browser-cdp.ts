import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// 브라우저 수준 CDP에 붙는다. Playwright의 지속 컨텍스트는 브라우저 객체를 주지 않으므로,
// Chromium이 프로필 폴더에 남기는 DevToolsActivePort 파일로 주소를 찾아 WebSocket으로 붙는다(R-04).
// Chromium을 --remote-debugging-port=0으로 띄워야 한다.

export interface BrowserCdp {
  readonly send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  readonly close: () => void;
}

export async function connectBrowserCdp(profileDirectory: string): Promise<BrowserCdp> {
  const file = path.join(profileDirectory, 'DevToolsActivePort');
  for (let waited = 0; !existsSync(file); waited += 50) {
    if (waited > 10_000) throw new Error('DevToolsActivePort 파일이 생기지 않았다.');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const [port, browserPath] = readFileSync(file, 'utf8').trim().split('\n');
  if (port === undefined || browserPath === undefined) {
    throw new Error('DevToolsActivePort 파일을 읽지 못했다.');
  }
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
