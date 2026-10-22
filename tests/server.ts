import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

// 확장 전체 테스트의 시험 페이지(tests/fixtures/)를 보내는 서버. 콘텐츠 스크립트는 http·https 페이지에만 실린다.
// 포트를 둘 열어 출처가 다른 iframe을 만든다.
// 주소가 /loading/으로 시작하면 그 뒤의 시험 페이지를 보내되 응답을 끝내지 않는다. 파서가 문서 끝을 받지 못해 문서가
// 로딩 중(readyState 'loading', DOMContentLoaded 없음)으로 남는다. 브라우저가 연결을 끊으면 끝난다.
// 캡처(PAGE-1)의 늦게 불러오는 이미지는 서버가 만든다: /image/<RRGGBB>.png?w=&h=&delay=는 그 색의 PNG를 delay(ms) 뒤에 보내고,
// /stall/로 시작하는 주소는 답하지 않는다(불러오기가 끝나지 않는 이미지).

export const fixturePorts = [4173, 4174] as const;

const loadingPrefix = '/loading/';
const imagePattern = /^\/image\/([0-9a-f]{6})\.png$/;
const stallPrefix = '/stall/';

const root = path.resolve(import.meta.dirname, 'fixtures');
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// 한 색으로 채운 width×height의 PNG(RGB 8비트).
function solidPng(width: number, height: number, hex: string): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const pixel = Buffer.from(hex, 'hex');
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) pixel.copy(row, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const sizeParameter = (url: URL, name: string) =>
  Math.min(2000, Math.max(1, Number(url.searchParams.get(name) ?? '100')));

for (const port of fixturePorts) {
  createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://localhost:${String(port)}`);
    if (url.pathname.startsWith(stallPrefix)) return;
    const image = imagePattern.exec(url.pathname);
    if (image !== null) {
      const body = solidPng(sizeParameter(url, 'w'), sizeParameter(url, 'h'), image[1] ?? '000000');
      const delay = Math.min(10_000, Number(url.searchParams.get('delay') ?? '0'));
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
        response.end(body);
      }, delay);
      return;
    }
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
