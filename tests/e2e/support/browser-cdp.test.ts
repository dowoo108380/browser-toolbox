import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readDevToolsActivePort } from './browser-cdp.ts';

// 파일 읽기는 실제 함수를 부르는 스파이다. 한 번만 Windows의 오류처럼 던지게 바꿀 수 있다.
vi.mock(import('node:fs'), { spy: true });

// Node가 Windows의 공유 위반(막 생긴 파일을 다른 프로세스가 잡은 순간)을 알리는 오류와 같은 모양.
const failure = (code: string) => Object.assign(new Error(`${code}: 흉내 낸 오류`), { code });

const address = '9222\n/devtools/browser/abc\n';
let profile = '';
let file = '';

beforeEach(() => {
  profile = mkdtempSync(path.join(tmpdir(), 'devtools-port-'));
  file = path.join(profile, 'DevToolsActivePort');
});

afterEach(() => {
  vi.mocked(readFileSync).mockReset();
  rmSync(profile, { recursive: true, force: true });
});

describe('DevToolsActivePort 읽기(확장 전체 시험의 도우미)', () => {
  it('이슈 #22 막 생긴 파일을 읽다 EBUSY가 나면 아직 없는 것으로 보고 다시 읽어 주소를 얻는다', async () => {
    writeFileSync(file, address);
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw failure('EBUSY');
    });
    await expect(readDevToolsActivePort(profile, 1_000)).resolves.toEqual({
      port: '9222',
      browserPath: '/devtools/browser/abc',
    });
    expect(readFileSync).toHaveBeenCalledTimes(2);
  });

  it('그 밖의 읽기 오류는 기다리지 않고 그대로 던진다', async () => {
    writeFileSync(file, address);
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw failure('EPERM');
    });
    await expect(readDevToolsActivePort(profile, 1_000)).rejects.toMatchObject({ code: 'EPERM' });
    expect(readFileSync).toHaveBeenCalledTimes(1);
  });

  it('파일이 생기기 전과 두 줄을 다 쓰기 전에는 기다린다', async () => {
    const reading = readDevToolsActivePort(profile, 5_000);
    await vi.waitFor(() => {
      expect(readFileSync).toHaveBeenCalled();
    });
    writeFileSync(file, '9222\n');
    await vi.waitFor(() => {
      expect(vi.mocked(readFileSync).mock.results).toContainEqual({
        type: 'return',
        value: '9222\n',
      });
    });
    writeFileSync(file, address);
    await expect(reading).resolves.toEqual({ port: '9222', browserPath: '/devtools/browser/abc' });
  });

  it('한도 안에 두 줄을 다 읽지 못하면 실패한다', async () => {
    writeFileSync(file, '9222\n');
    await expect(readDevToolsActivePort(profile, 100)).rejects.toThrow(
      'DevToolsActivePort를 100ms 안에 읽지 못했다.',
    );
  });
});
