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

// 다른 구현으로 풀어 본다: .NET의 ZipFile(Windows PowerShell). 이름을 유니코드로 다뤄 시스템 코드 페이지와 상관없이 한글
// 이름을 푼다. Windows의 tar(libarchive)는 이름을 시스템의 ANSI 코드 페이지로 바꿔 다루므로, 그 코드 페이지가 한글을 나타내지
// 못하면(영어 Windows의 1252) 그 항목을 건너뛴다(이슈 #8, libarchive의 tar/util.c edit_pathname).
// UTF-8 표시(일반 목적 비트 11)가 없는 항목의 이름은 Latin-1로 읽게 한다. 그래서 createZip이 표시를 빠뜨리면 한글 이름이
// 깨져 어느 컴퓨터에서든 이 시험이 실패한다(.NET은 표시가 있는 항목만 UTF-8로 읽는다).
const powershell =
  process.platform === 'win32'
    ? path.join(
        process.env['SystemRoot'] ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      )
    : 'pwsh';

// PowerShell의 작은따옴표 문자열. 안의 작은따옴표는 두 번 쓴다.
const quoted = (text: string) => `'${text.replaceAll("'", "''")}'`;

const extractScript = (zipPath: string, out: string) =>
  [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `[System.IO.Compression.ZipFile]::ExtractToDirectory(${quoted(zipPath)}, ${quoted(out)}, [System.Text.Encoding]::GetEncoding(28591))`,
  ].join('; ');

let directory: string | null = null;
afterEach(() => {
  if (directory !== null) rmSync(directory, { recursive: true, force: true });
  directory = null;
});

describe('배포 ZIP', () => {
  it('같은 입력이면 같은 바이트다(항목 순서와 상관없다)', () => {
    expect(createZip(entries)).toEqual(createZip([...entries].reverse()));
  });

  // PowerShell을 띄우는 데 이 컴퓨터에서 1초쯤 걸린다(2026-10-21). CI의 처음 실행은 더 걸릴 수 있어 넉넉히 둔다.
  it(
    '다른 구현(.NET)이 풀면 한글 이름까지 원본과 같다(시스템 코드 페이지와 상관없다)',
    { timeout: 60_000 },
    () => {
      directory = mkdtempSync(path.join(tmpdir(), 'browser-toolbox-zip-'));
      const zipPath = path.join(directory, 'test.zip');
      const out = path.join(directory, 'out');
      writeFileSync(zipPath, createZip(entries));
      execFileSync(powershell, [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        extractScript(zipPath, out),
      ]);
      for (const entry of entries) {
        expect(readFileSync(path.join(out, ...entry.name.split('/')))).toEqual(
          Buffer.from(entry.data),
        );
      }
    },
  );

  it('상대 경로가 아닌 이름은 받지 않는다', () => {
    expect(() => createZip([{ name: '/abs.txt', data: new Uint8Array() }])).toThrow();
    expect(() => createZip([{ name: 'a\\b.txt', data: new Uint8Array() }])).toThrow();
  });
});
