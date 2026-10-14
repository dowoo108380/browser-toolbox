import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

// 확장 전체 테스트의 시험 페이지(tests/fixtures/)를 보내는 서버. 콘텐츠 스크립트는 http·https 페이지에만 실린다.
// 포트를 둘 열어 출처가 다른 iframe을 만든다.
// 주소가 /loading/으로 시작하면 그 뒤의 시험 페이지를 보내되 응답을 끝내지 않는다. 파서가 문서 끝을 받지 못해 문서가
// 로딩 중(readyState 'loading', DOMContentLoaded 없음)으로 남는다. 브라우저가 연결을 끊으면 끝난다.

export const fixturePorts = [4173, 4174] as const;

const loadingPrefix = '/loading/';

const root = path.resolve(import.meta.dirname, 'fixtures');
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

for (const port of fixturePorts) {
  createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://localhost:${String(port)}`);
    const loading = url.pathname.startsWith(loadingPrefix);
    const pathname = loading ? `/${url.pathname.slice(loadingPrefix.length)}` : url.pathname;
    const file = path.resolve(root, `.${decodeURIComponent(pathname)}`);
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'content-type': types[path.extname(file)] ?? 'application/octet-stream',
    });
    createReadStream(file).pipe(response, { end: !loading });
  }).listen(port, '127.0.0.1');
}

console.log(`시험 페이지 서버: ${fixturePorts.map(String).join(', ')}`);
