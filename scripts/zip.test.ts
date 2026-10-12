import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createZip } from './zip.ts';

const encoder = new TextEncoder();
const entries = [
  { name: 'manifest.json', data: encoder.encode('{"name":"시험"}\n') },
  { name: 'sub/한글 이름.txt', data: encoder.encode('가나다'.repeat(1000)) },
  { name: 'empty.txt', data: new Uint8Array() },
];

// Windows에 들어 있는 tar는 libarchive(bsdtar)라 ZIP을 푼다. Git의 GNU tar는 ZIP을 풀지 못한다.
const bsdtar =
  process.platform === 'win32'
    ? path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'bsdtar';

let directory: string | null = null;
afterEach(() => {
  if (directory !== null) rmSync(directory, { recursive: true, force: true });
  directory = null;
});

describe('배포 ZIP', () => {
  it('같은 입력이면 같은 바이트다(항목 순서와 상관없다)', () => {
    expect(createZip(entries)).toEqual(createZip([...entries].reverse()));
  });

  it('다른 프로그램(tar, libarchive)이 풀면 원본과 같다', () => {
    directory = mkdtempSync(path.join(tmpdir(), 'browser-toolbox-zip-'));
    const zipPath = path.join(directory, 'test.zip');
    writeFileSync(zipPath, createZip(entries));
    execFileSync(bsdtar, ['-xf', zipPath, '-C', directory]);
    for (const entry of entries) {
      expect(readFileSync(path.join(directory, ...entry.name.split('/')))).toEqual(
        Buffer.from(entry.data),
      );
    }
  });

  it('상대 경로가 아닌 이름은 받지 않는다', () => {
    expect(() => createZip([{ name: '/abs.txt', data: new Uint8Array() }])).toThrow();
    expect(() => createZip([{ name: 'a\\b.txt', data: new Uint8Array() }])).toThrow();
  });
});
