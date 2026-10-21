import { describe, expect, it } from 'vitest';
import {
  type OffscreenRequest,
  clipboardSettleMs,
  offscreenCopyImage,
  offscreenRevoke,
  offscreenSettle,
  offscreenUrl,
} from '../contracts/index.ts';
import type { OffscreenRequester, SavedFile } from '../platform/index.ts';
import { type AppError, type Result, appError, err, ok } from '../shared/index.ts';
import { createFileService } from './files.ts';
import type { Problem } from './problems.ts';

// 서비스 워커의 저장·클립보드 서비스(결정 0047). 오프스크린 문서와 다운로드는 가짜이고, 문서가 열린 동안의 일과 닫기 전에
// 클립보드 쓰기를 기다리는 것(offscreenSettle)을 시험이 붙잡는다.

const blob = new Blob(['png'], { type: 'image/png' });

function setup(
  options: {
    readonly copied?: boolean;
    readonly download?: Result<SavedFile, AppError>;
    // 참이면 문서가 settle에 곧 답하지 않고 시험이 답하게 한다(answerSettle).
    readonly holdSettle?: boolean;
    readonly settle?: Result<null, AppError>;
    // 그 종류의 요청에 문서가 이 실패로 답한다.
    readonly fail?: Readonly<Partial<Record<string, AppError>>>;
    // 참이면 문서 닫기가 던진다(일어나면 안 되는 일).
    readonly closeThrows?: boolean;
  } = {},
) {
  const log: string[] = [];
  // 문서에 보낸 요청(종류, 내용, 제한 시간).
  const requests: { kind: string; payload: unknown; timeoutMs: number }[] = [];
  let open = false;
  const problems: Problem[] = [];
  // 다운로드를 시험이 끝낼 때까지 붙잡는다.
  const downloads: ((result: Result<SavedFile, AppError>) => void)[] = [];
  const settles: (() => void)[] = [];
  const request: OffscreenRequester = async <Kind extends string, Payload, Value>(
    definition: OffscreenRequest<Kind, Payload, Value>,
    payload: Payload,
    timeoutMs: number,
  ): Promise<Result<Value, AppError>> => {
    log.push(`request:${definition.kind}`);
    requests.push({ kind: definition.kind, payload, timeoutMs });
    if (!open) return err(appError('timeout', '문서가 없다.'));
    const failed = options.fail?.[definition.kind];
    if (failed !== undefined) return err(failed);
    if (definition.kind === offscreenSettle.kind) {
      if (options.holdSettle === true) {
        await new Promise<void>((resolve) => {
          settles.push(resolve);
        });
      }
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- settle의 답은 null이다.
      if (options.settle !== undefined) return options.settle as Result<Value, AppError>;
    }
    const answers: Record<string, unknown> = {
      [offscreenUrl.kind]: { url: 'blob:x' },
      [offscreenRevoke.kind]: null,
      [offscreenCopyImage.kind]: { copied: options.copied ?? true },
      [offscreenSettle.kind]: null,
    };
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- 요청마다 정한 답이다.
    return ok(answers[definition.kind] as Value);
  };
  const files = createFileService({
    openDocument: () => {
      log.push('open');
      open = true;
      return Promise.resolve(ok(null));
    },
    closeDocument: () => {
      log.push('close');
      if (options.closeThrows === true) return Promise.reject(new Error('닫다 던졌다.'));
      open = false;
      return Promise.resolve(ok(null));
    },
    request,
    download: (url, path) => {
      log.push(`download:${url}:${path}`);
      if (options.download !== undefined) return Promise.resolve(options.download);
      return new Promise((resolve) => {
        downloads.push(resolve);
      });
    },
    record: (problem) => problems.push(problem),
  });
  const finishDownload = (index: number, result: Result<SavedFile, AppError>) => {
    const resolve = downloads[index];
    if (resolve === undefined) throw new Error('다운로드가 없다.');
    resolve(result);
  };
  const answerSettle = () => {
    for (const resolve of settles.splice(0)) resolve();
  };
  return {
    files,
    log,
    requests,
    problems,
    isOpen: () => open,
    finishDownload,
    downloads,
    settles,
    answerSettle,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('결정 0047 저장', () => {
  it('문서를 열어 Blob 주소를 만들고, 그 주소를 그 경로로 저장한 뒤 주소를 거두고, 쓰는 일이 없으면 문서의 클립보드 쓰기를 기다려 닫는다', async () => {
    const { files, log, requests, isOpen, finishDownload } = setup();
    const saving = files.save(blob, 'full_page_screenshots/a.png');
    await settle();
    expect(isOpen()).toBe(true);
    finishDownload(0, ok({ name: 'a (1).png', inFolder: true }));
    expect(await saving).toEqual(ok({ name: 'a (1).png', inFolder: true }));
    await vitestWait(() => !isOpen());
    expect(log).toEqual([
      'open',
      'request:url',
      'download:blob:x:full_page_screenshots/a.png',
      'request:revoke',
      'request:settle',
      'close',
    ]);
    expect(requests).toEqual([
      { kind: offscreenUrl.kind, payload: { blob }, timeoutMs: 5000 },
      { kind: offscreenRevoke.kind, payload: { url: 'blob:x' }, timeoutMs: 5000 },
      { kind: offscreenSettle.kind, payload: null, timeoutMs: clipboardSettleMs + 5000 },
    ]);
  });

  it('주소를 만들지 못하면 그 까닭을 주고 저장하지 않는다', async () => {
    const failed = appError('timeout', '답하지 않는다.');
    const { files, log } = setup({ fail: { [offscreenUrl.kind]: failed } });
    expect(await files.save(blob, 'x.png')).toEqual(err(failed));
    expect(log.some((entry) => entry.startsWith('download:'))).toBe(false);
  });

  it('주소를 거두지 못해도 저장한 결과는 그대로이고 기록한다', async () => {
    const saved = ok({ name: 'x.png', inFolder: true });
    const { files, problems } = setup({
      download: saved,
      fail: { [offscreenRevoke.kind]: appError('timeout', '답하지 않는다.') },
    });
    expect(await files.save(blob, 'x.png')).toEqual(saved);
    expect(problems).toEqual([{ featureId: null, kind: 'timeout' }]);
  });

  it('저장하지 못하면 그 까닭을 주고 문서는 닫는다', async () => {
    const failed = err(appError('platform', '파일을 저장하지 못했다.'));
    const { files, isOpen } = setup({ download: failed });
    expect(await files.save(blob, 'x.png')).toEqual(failed);
    await vitestWait(() => !isOpen());
  });

  it('두 일이 겹치면 앞 일이 끝나도 뒤 일이 문서를 쓰는 동안 닫지 않는다', async () => {
    const { files, log, isOpen, finishDownload, downloads } = setup();
    const first = files.save(blob, 'a.png');
    const second = files.save(blob, 'b.png');
    await vitestWait(() => downloads.length === 2);
    finishDownload(0, ok({ name: 'a.png', inFolder: true }));
    await first;
    await settle();
    expect(isOpen()).toBe(true);
    finishDownload(1, ok({ name: 'b.png', inFolder: true }));
    await second;
    await vitestWait(() => !isOpen());
    expect(log.filter((entry) => entry === 'close')).toEqual(['close']);
    // 앞 일이 끝났을 때는 뒤 일이 쓰는 중이라 닫을지 묻지도 않는다.
    expect(log.filter((entry) => entry === 'request:settle')).toEqual(['request:settle']);
  });

  it('문서를 열지 못하면 그 까닭을 주고, 기다릴 문서가 없으니 문서에 묻지 않는다', async () => {
    const log: string[] = [];
    const files = createFileService({
      openDocument: () => Promise.resolve(err(appError('platform', '열지 못했다.'))),
      closeDocument: () => {
        log.push('close');
        return Promise.resolve(ok(null));
      },
      request: (definition) => {
        log.push(`request:${definition.kind}`);
        return Promise.resolve(err(appError('timeout', '쓰지 않는다.')));
      },
      download: () => Promise.resolve(ok({ name: 'x', inFolder: true })),
      record: () => undefined,
    });
    expect(await files.save(blob, 'x.png')).toEqual(err(appError('platform', '열지 못했다.')));
    await vitestWait(() => log.length > 0);
    expect(log).toEqual(['close']);
  });

  it('닫은 뒤에 다시 열지 못하면 이미 닫은 문서에 묻지 않는다', async () => {
    const log: string[] = [];
    let opens = 0;
    const files = createFileService({
      openDocument: () => {
        opens += 1;
        log.push('open');
        return Promise.resolve(opens === 1 ? ok(null) : err(appError('platform', '열지 못했다.')));
      },
      closeDocument: () => {
        log.push('close');
        return Promise.resolve(ok(null));
      },
      // 문서는 답하지 않는다(저장은 실패하고, 닫기 전에 묻는 것은 기록하고 넘어간다).
      request: (definition) => {
        log.push(`request:${definition.kind}`);
        return Promise.resolve(err(appError('timeout', '답하지 않는다.')));
      },
      download: () => Promise.resolve(ok({ name: 'x', inFolder: true })),
      record: () => undefined,
    });
    await files.save(blob, 'a.png');
    await vitestWait(() => log.includes('close'));
    await files.save(blob, 'b.png');
    await vitestWait(() => log.filter((entry) => entry === 'close').length === 2);
    expect(log).toEqual(['open', 'request:url', 'request:settle', 'close', 'open', 'close']);
  });
});

describe('결정 0047 클립보드', () => {
  it('문서에 그림 복사를 맡기고, 문서가 클립보드 쓰기를 끝내기를 기다리지 않고 답한 뒤 끝나면 닫는다', async () => {
    const { files, log, requests, isOpen, settles, answerSettle } = setup({ holdSettle: true });
    expect(await files.copyImage(blob, 'a.png')).toEqual(ok(null));
    expect(requests[0]).toEqual({
      kind: offscreenCopyImage.kind,
      payload: { blob, title: 'a.png' },
      timeoutMs: 30_000,
    });
    await vitestWait(() => settles.length === 1);
    expect(isOpen()).toBe(true);
    answerSettle();
    await vitestWait(() => !isOpen());
    expect(log).toEqual(['open', 'request:copyImage', 'request:settle', 'close']);
  });

  it('클립보드 쓰기를 기다리는 동안 새 일이 오면 닫지 않고 그 일이 문서를 쓴다', async () => {
    const { files, log, isOpen, settles, answerSettle } = setup({ holdSettle: true });
    await files.copyImage(blob, 'a.png');
    await vitestWait(() => settles.length === 1);
    const second = files.copyImage(blob, 'b.png');
    answerSettle();
    expect(await second).toEqual(ok(null));
    await vitestWait(() => settles.length === 1);
    expect(isOpen()).toBe(true);
    expect(log.filter((entry) => entry === 'close')).toEqual([]);
    answerSettle();
    await vitestWait(() => !isOpen());
    expect(log).toEqual([
      'open',
      'request:copyImage',
      'request:settle',
      'open',
      'request:copyImage',
      'request:settle',
      'close',
    ]);
  });

  it('문서가 클립보드 쓰기의 끝을 답하지 않으면 기록하고 닫는다', async () => {
    const { files, isOpen, problems } = setup({
      settle: err(appError('timeout', '답하지 않는다.')),
    });
    await files.copyImage(blob, 'a.png');
    await vitestWait(() => !isOpen());
    expect(problems).toEqual([{ featureId: null, kind: 'timeout' }]);
  });

  it('문서가 복사에 답하지 않으면 그 까닭이다', async () => {
    const failed = appError('timeout', '답하지 않는다.');
    const { files } = setup({ fail: { [offscreenCopyImage.kind]: failed } });
    expect(await files.copyImage(blob, 'a.png')).toEqual(err(failed));
  });

  it('닫기가 던지면(일어나면 안 됨) 기록한다', async () => {
    const { files, problems } = setup({ closeThrows: true });
    await files.copyImage(blob, 'a.png');
    await vitestWait(() => problems.length > 0);
    expect(problems).toEqual([{ featureId: null, kind: 'unexpected' }]);
  });

  it('Chrome이 허락하지 않으면 permission이다', async () => {
    const { files } = setup({ copied: false });
    const copied = await files.copyImage(blob, 'a.png');
    expect(copied.ok ? null : copied.error.kind).toBe('permission');
  });
});

describe('결정 0038 0047 서비스 워커가 시작할 때', () => {
  it('앞 서비스 워커가 연 채 남긴 문서를 기다리지 않고 닫는다', async () => {
    const { files, log } = setup();
    await files.recover();
    expect(log).toEqual(['close']);
  });

  it('그 사이에 이 서비스 워커의 일이 문서를 쓰고 있으면 닫지 않는다', async () => {
    const { files, log, isOpen, downloads, finishDownload } = setup();
    const saving = files.save(blob, 'a.png');
    await vitestWait(() => downloads.length === 1);
    await files.recover();
    expect(isOpen()).toBe(true);
    expect(log.filter((entry) => entry === 'close')).toEqual([]);
    finishDownload(0, ok({ name: 'a.png', inFolder: true }));
    await saving;
    await vitestWait(() => !isOpen());
  });

  it('닫지 못하면 기록한다', async () => {
    const problems: Problem[] = [];
    const files = createFileService({
      openDocument: () => Promise.resolve(ok(null)),
      closeDocument: () => Promise.resolve(err(appError('platform', '닫지 못했다.'))),
      request: () => Promise.resolve(err(appError('timeout', '쓰지 않는다.'))),
      download: () => Promise.resolve(ok({ name: 'x', inFolder: true })),
      record: (problem) => problems.push(problem),
    });
    await files.recover();
    expect(problems).toEqual([{ featureId: null, kind: 'platform' }]);
  });
});

async function vitestWait(condition: () => boolean) {
  for (let tries = 0; tries < 100 && !condition(); tries += 1) await settle();
  expect(condition()).toBe(true);
}
