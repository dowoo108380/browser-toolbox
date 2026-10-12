import { crc32, deflateRawSync } from 'node:zlib';

// 배포 ZIP을 만든다(quality 117). 의존성을 더하지 않으려고 PKWARE APPNOTE의 필요한 부분만 쓴다.
// 같은 입력이면 같은 바이트가 나오게 항목을 이름순으로 두고 시각을 고정한다(08단계 재현 가능 빌드의 바탕).

export interface ZipEntry {
  // '/'로 나눈 상대 경로.
  readonly name: string;
  readonly data: Uint8Array;
}

// 1980-01-01 00:00(DOS 날짜·시각이 나타낼 수 있는 가장 이른 때).
const dosTime = 0;
const dosDate = (1 << 5) | 1;
// 일반 목적 비트 11: 이름이 UTF-8이다.
const utf8Flag = 0x0800;
const deflate = 8;
const versionNeeded = 20;

export function createZip(entries: readonly ZipEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of sorted) {
    if (entry.name.includes('\\') || entry.name.startsWith('/')) {
      throw new Error(`ZIP 항목 이름이 상대 경로가 아니다: ${entry.name}`);
    }
    const name = encoder.encode(entry.name);
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(versionNeeded, 4);
    local.writeUInt16LE(utf8Flag, 6);
    local.writeUInt16LE(deflate, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    local.set(name, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(versionNeeded, 4);
    central.writeUInt16LE(versionNeeded, 6);
    central.writeUInt16LE(utf8Flag, 8);
    central.writeUInt16LE(deflate, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // 30: 추가 필드 길이, 32: 설명 길이, 34: 디스크 번호, 36: 내부 속성, 38: 외부 속성은 모두 0이다.
    central.writeUInt32LE(offset, 42);
    central.set(name, 46);

    locals.push(local, compressed);
    centrals.push(central);
    offset += local.length + compressed.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  if (sorted.length >= 0xffff || offset + centralSize >= 0xffffffff) {
    throw new Error('ZIP32 한도를 넘는다.');
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}
