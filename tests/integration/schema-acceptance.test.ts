import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type RequestDefinition,
  categories,
  featuresWithSettings,
  pageStatus,
  popupPort,
  problemReport,
  repairNoticeDismiss,
  requests,
  settingsUpdate,
  storageEnsureReady,
  tabStatus,
  taskNotice,
  taskSeen,
  taskStart,
} from '../../src/contracts/index.ts';
import { features } from '../../src/features/list.ts';
import { createFakeStore } from '../../src/platform/fake.ts';
import {
  chromeRequester,
  listenExtensionRequest,
  sendToTab,
  watchPopups,
} from '../../src/platform/index.ts';
import { appError, err } from '../../src/shared/index.ts';
import {
  type Snapshot,
  normalize,
  parseRepairNotice,
  parseTasks,
  popupStateKey,
  readRememberedCategory,
  settingsFormat,
  settingsKey,
  startSettingsReader,
} from '../../src/storage/index.ts';
import { startTestBackground } from '../support/background.ts';

// 저장되는 값과 메시지를 무엇으로 받아들이고 무엇으로 거절하는지 표로 고정한다. 저장된 값은 같은 형식 버전이면 판이 바뀌어도
// 같게 읽어야 한다(결정 0021). 그래서 런타임 검증 라이브러리를 바꿀 때(결정 0027의 3) 이 표가 그대로 통과해야 한다.
// 표는 검증 라이브러리를 부르지 않고, 제품이 값을 받는 경계 함수(설정 정리, 기록 읽기, 요청 받기, 응답 확인)로만 본다.
// 가장자리 값: 빠진 키, 모르는 키(빠지는지 남는지), 틀린 타입, 객체 자리의 배열, 기록(record) 자리의 배열, NaN·Infinity·-0,
// 안전한 정수의 끝(2^53 − 1과 2^53), 길이 한도(글자는 코드 포인트로 센다: 한글, BMP 밖 글자, 짝 없는 대리 문자), 고를 수 없는 값.

const big = 2 ** 53;
const maxSafe = big - 1;
const emoji = '😀';
const lone = '\uD800';
// 배열이지만 객체의 키를 모두 가진 값. 객체와 기록 자리에서 배열은 받지 않는다.
const arrayWith = (fields: Readonly<Record<string, unknown>>) => Object.assign([], fields);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// 표의 줄: [이름, 입력, 기대]. 실패하면 모든 줄의 결과를 함께 보인다.
type Row<T> = readonly [string, unknown, T];

function check<T>(rows: readonly Row<T>[], outcome: (input: unknown) => T): void {
  for (const [name, input, expected] of rows) expect.soft(outcome(input), name).toEqual(expected);
}

async function checkAsync<T>(
  rows: readonly Row<T>[],
  outcome: (input: unknown) => Promise<T>,
): Promise<void> {
  for (const [name, input, expected] of rows) {
    expect.soft(await outcome(input), name).toEqual(expected);
  }
}

describe('저장된 값의 받아들임과 거절', () => {
  const specs = featuresWithSettings(features);
  const valid = { version: 1, revision: 1, features: {}, sites: {} };

  // 서비스 워커가 읽은 설정을 나누는 결과(결정 0011). current: 지금 형식 그대로, corrupt: 설정 전체의 손상, newer: 더 새
  // 형식, missing: 없음, 그 밖: 손상 항목.
  function settingsOutcome(raw: unknown): unknown {
    const normalized = normalize(raw, settingsFormat, specs);
    if (!normalized.ok) return normalized.error.kind === 'unavailable' ? 'newer' : normalized.error;
    const [repair, ...rest] = normalized.value.repairs;
    if (repair === undefined) return 'current';
    if (rest.length > 0) return normalized.value.repairs;
    if (repair.kind === 'corruptItems') return { features: repair.features, sites: repair.sites };
    return repair.kind;
  }

  it('결정 0011 설정 전체: 버전과 지금 형식의 구조', () => {
    check<unknown>(
      [
        ['없음', undefined, 'missing'],
        ['null', null, 'corrupt'],
        ['빈 배열', [], 'corrupt'],
        ['문자열', 'settings', 'corrupt'],
        ['수', 1, 'corrupt'],
        ['참', true, 'corrupt'],
        ['빈 객체', {}, 'corrupt'],
        ['키를 모두 가진 배열', arrayWith(valid), 'corrupt'],
        ['지금 형식', valid, 'current'],
        ['모르는 최상위 키', { ...valid, extra: 1 }, 'current'],
        ['version 0', { ...valid, version: 0 }, 'corrupt'],
        ['version -1', { ...valid, version: -1 }, 'corrupt'],
        ['version 1.5', { ...valid, version: 1.5 }, 'corrupt'],
        ['version "1"', { ...valid, version: '1' }, 'corrupt'],
        ['version null', { ...valid, version: null }, 'corrupt'],
        ['version NaN', { ...valid, version: Number.NaN }, 'corrupt'],
        ['version Infinity', { ...valid, version: Number.POSITIVE_INFINITY }, 'corrupt'],
        ['version 2', { ...valid, version: 2 }, 'newer'],
        ['version 2^53 − 1', { ...valid, version: maxSafe }, 'newer'],
        ['version 2^53', { ...valid, version: big }, 'corrupt'],
        ['version만', { version: 1 }, 'corrupt'],
        ['더 새 형식은 구조를 보지 않음', { version: 2, features: [] }, 'newer'],
        ['revision 없음', { version: 1, features: {}, sites: {} }, 'corrupt'],
        ['revision 0', { ...valid, revision: 0 }, 'corrupt'],
        ['revision -0', { ...valid, revision: -0 }, 'corrupt'],
        ['revision 1.5', { ...valid, revision: 1.5 }, 'corrupt'],
        ['revision "1"', { ...valid, revision: '1' }, 'corrupt'],
        ['revision 2^53 − 1', { ...valid, revision: maxSafe }, 'current'],
        ['revision 2^53', { ...valid, revision: big }, 'corrupt'],
        ['revision Infinity', { ...valid, revision: Number.POSITIVE_INFINITY }, 'corrupt'],
        ['features 없음', { version: 1, revision: 1, sites: {} }, 'corrupt'],
        ['features 배열', { ...valid, features: [] }, 'corrupt'],
        ['features 원소 있는 배열', { ...valid, features: [{ enabled: true }] }, 'corrupt'],
        ['features null', { ...valid, features: null }, 'corrupt'],
        ['features 문자열', { ...valid, features: 'media-speed' }, 'corrupt'],
        ['sites 없음', { version: 1, revision: 1, features: {} }, 'corrupt'],
        ['sites 배열', { ...valid, sites: [] }, 'corrupt'],
        ['sites null', { ...valid, sites: null }, 'corrupt'],
      ],
      settingsOutcome,
    );
  });

  it('결정 0011 0017 기능 항목과 사이트 항목', () => {
    const withFeature = (item: unknown) => ({ ...valid, features: { 'media-speed': item } });
    const corruptFeature = { features: ['media-speed'], sites: [] };
    check<unknown>(
      [
        ['켬', withFeature({ enabled: true }), 'current'],
        ['끔', withFeature({ enabled: false }), 'current'],
        ['모르는 필드', withFeature({ enabled: true, later: 2.5 }), 'current'],
        ['빈 객체', withFeature({}), corruptFeature],
        ['enabled 문자열', withFeature({ enabled: 'yes' }), corruptFeature],
        ['enabled 수', withFeature({ enabled: 1 }), corruptFeature],
        ['enabled null', withFeature({ enabled: null }), corruptFeature],
        ['배열', withFeature([]), corruptFeature],
        ['키를 가진 배열', withFeature(arrayWith({ enabled: true })), corruptFeature],
        ['null', withFeature(null), corruptFeature],
        ['수', withFeature(1), corruptFeature],
        ['모르는 기능의 아무 값', { ...valid, features: { nope: [1, 2] } }, 'current'],
        ['사이트 값이 객체', { ...valid, sites: { 'a.example.com': {} } }, 'current'],
        [
          '사이트 설정이 없는 기능의 사이트 항목',
          { ...valid, sites: { 'a.example.com': { 'media-speed': 1 } } },
          'current',
        ],
        [
          '사이트 값이 수',
          { ...valid, sites: { 'a.example.com': 1 } },
          { features: [], sites: [{ host: 'a.example.com', featureId: null }] },
        ],
        [
          '사이트 값이 배열',
          { ...valid, sites: { 'a.example.com': [] } },
          { features: [], sites: [{ host: 'a.example.com', featureId: null }] },
        ],
      ],
      settingsOutcome,
    );
  });

  // GPT-2의 너비는 px 정수 640–3840이다(사용자, 2026-10-18). 받는 범위를 넓히면 형식 버전을 올려야 하므로(아키텍처 6장) 그
  // 끝을 표로 고정한다.
  it('GPT-2 결정 0031 대화 열·작성란 너비의 항목', () => {
    const withWidth = (item: unknown) => ({ ...valid, features: { 'chatgpt-width': item } });
    const corrupt = { features: ['chatgpt-width'], sites: [] };
    check<unknown>(
      [
        ['기본값', withWidth({ enabled: false, width: 1200 }), 'current'],
        ['가장 좁게', withWidth({ enabled: true, width: 640 }), 'current'],
        ['가장 넓게', withWidth({ enabled: true, width: 3840 }), 'current'],
        ['모르는 필드', withWidth({ enabled: true, width: 1200, later: 1 }), 'current'],
        ['너비 없음', withWidth({ enabled: true }), corrupt],
        ['범위보다 좁음', withWidth({ enabled: true, width: 639 }), corrupt],
        ['범위보다 넓음', withWidth({ enabled: true, width: 3841 }), corrupt],
        ['정수 아님', withWidth({ enabled: true, width: 1200.5 }), corrupt],
        ['문자열', withWidth({ enabled: true, width: '1200' }), corrupt],
        ['NaN', withWidth({ enabled: true, width: Number.NaN }), corrupt],
        ['Infinity', withWidth({ enabled: true, width: Number.POSITIVE_INFINITY }), corrupt],
        ['null', withWidth({ enabled: true, width: null }), corrupt],
      ],
      settingsOutcome,
    );
  });

  // CLD-1의 너비도 px 정수 640–3840이다(사용자, 2026-10-20. GPT-2와 따로 정한 같은 값, 결정 0039). 끝을 표로 고정하는 까닭은
  // GPT-2와 같다.
  it('CLD-1 결정 0040 claude.ai 대화 열·작성란 너비의 항목', () => {
    const withWidth = (item: unknown) => ({ ...valid, features: { 'claude-width': item } });
    const corrupt = { features: ['claude-width'], sites: [] };
    check<unknown>(
      [
        ['기본값', withWidth({ enabled: false, width: 1200 }), 'current'],
        ['가장 좁게', withWidth({ enabled: true, width: 640 }), 'current'],
        ['가장 넓게', withWidth({ enabled: true, width: 3840 }), 'current'],
        ['모르는 필드', withWidth({ enabled: true, width: 1200, later: 1 }), 'current'],
        ['너비 없음', withWidth({ enabled: true }), corrupt],
        ['범위보다 좁음', withWidth({ enabled: true, width: 639 }), corrupt],
        ['범위보다 넓음', withWidth({ enabled: true, width: 3841 }), corrupt],
        ['정수 아님', withWidth({ enabled: true, width: 1200.5 }), corrupt],
        ['문자열', withWidth({ enabled: true, width: '1200' }), corrupt],
        ['null', withWidth({ enabled: true, width: null }), corrupt],
      ],
      settingsOutcome,
    );
  });

  it('결정 0011 읽는 쪽이 받는 기능 설정은 스키마를 거친 값이다(모르는 필드는 빠진다)', async () => {
    const store = createFakeStore({
      [settingsKey]: {
        ...valid,
        features: { 'media-speed': { enabled: true, later: 2.5 } },
      },
    });
    const request = startTestBackground({ store, features, startTime: 1_800_000_000_000 });
    const snapshot = await new Promise<Snapshot>((resolve, reject) => {
      startSettingsReader(
        { store, request, format: settingsFormat, specs },
        { apply: resolve, corrupt: reject, newer: reject, problem: reject },
      );
    });
    expect(snapshot.features.get('media-speed')).toEqual({ enabled: true });
  });

  // 기록(record)의 키는 사이트 호스트와 기능 id다. 객체의 원형과 같은 이름이어도(한 단어 호스트 'prototype' 등) 남아야 하고,
  // 서비스 워커가 다른 설정을 바꾸며 다시 쓸 때 그 항목을 잃지 않아야 한다(결정 0022). 객체 키로 둘 수 없는 '__proto__'는
  // 빠진다(0017은 site.update에서 그런 호스트를 거절하기로 했다). JSON에서 읽은 값처럼 키를 제 속성으로 만든다.
  const namedKeys = ['prototype', 'constructor', 'hasOwnProperty', 'toString', '__proto__'];
  const withKey = (key: string): unknown =>
    JSON.parse(
      JSON.stringify({ version: 1, revision: 1, features: {}, sites: {} })
        .replace('"features":{}', `"features":{${JSON.stringify(key)}:{"later":1}}`)
        .replace('"sites":{}', `"sites":{${JSON.stringify(key)}:{"later":1}}`),
    );
  const keptKeys = (key: string) =>
    key === '__proto__' ? { features: [], sites: [] } : { features: [key], sites: [key] };

  it('결정 0011 0022 기록의 키: 원형의 이름과 같은 키도 읽은 값에 남는다', () => {
    check<unknown>(
      namedKeys.map((key): Row<unknown> => [key, withKey(key), keptKeys(key)]),
      (raw) => {
        const normalized = normalize(raw, settingsFormat, specs);
        if (!normalized.ok) return normalized.error;
        const { features: read, sites } = normalized.value.value;
        return { features: Object.keys(read), sites: Object.keys(sites) };
      },
    );
  });

  it('결정 0022 기록의 키: 다른 기능을 바꾸며 다시 써도 원형의 이름과 같은 키의 항목을 잃지 않는다', async () => {
    await checkAsync<unknown>(
      namedKeys.map((key): Row<unknown> => {
        const kept = keptKeys(key);
        return [
          key,
          withKey(key),
          { features: [...kept.features, 'media-speed'].sort(), sites: kept.sites },
        ];
      }),
      async (raw) => {
        const store = createFakeStore({ [settingsKey]: raw });
        const request = startTestBackground({ store, features, startTime: 1_800_000_000_000 });
        const result = await request(settingsUpdate, {
          featureId: 'media-speed',
          patch: { enabled: true },
        });
        if (!result.ok) return result.error;
        const written = store.peek(settingsKey);
        if (typeof written !== 'object' || written === null) return written;
        const read = (name: string): unknown => Reflect.get(written, name);
        const keysOf = (value: unknown) =>
          typeof value === 'object' && value !== null ? Object.keys(value).sort() : value;
        return { features: keysOf(read('features')), sites: keysOf(read('sites')) };
      },
    );
  });

  it('결정 0016 복구 알림', () => {
    const notice = { stamp: 1, whole: false, features: ['media-speed'], sites: [] };
    check<unknown>(
      [
        ['맞는 기록', notice, notice],
        [
          '사이트 항목이 있음',
          { ...notice, sites: [{ host: 'a', featureId: null }] },
          { ...notice, sites: [{ host: 'a', featureId: null }] },
        ],
        [
          '사이트 항목의 기능 id',
          { ...notice, sites: [{ host: 'a', featureId: 'f' }] },
          { ...notice, sites: [{ host: 'a', featureId: 'f' }] },
        ],
        [
          'sites 없음(0017 전의 기록)',
          { stamp: 1, whole: true, features: [] },
          { stamp: 1, whole: true, features: [], sites: [] },
        ],
        ['sites undefined', { ...notice, sites: undefined }, notice],
        ['모르는 키', { ...notice, extra: 1 }, notice],
        [
          '사이트 항목의 모르는 키',
          { ...notice, sites: [{ host: 'a', featureId: null, x: 1 }] },
          { ...notice, sites: [{ host: 'a', featureId: null }] },
        ],
        ['stamp 0', { ...notice, stamp: 0 }, null],
        ['stamp 1.5', { ...notice, stamp: 1.5 }, null],
        ['stamp "1"', { ...notice, stamp: '1' }, null],
        ['stamp 2^53', { ...notice, stamp: big }, null],
        ['stamp 2^53 − 1', { ...notice, stamp: maxSafe }, { ...notice, stamp: maxSafe }],
        ['whole 문자열', { ...notice, whole: 'true' }, null],
        ['features에 수', { ...notice, features: ['a', 1] }, null],
        ['features 객체', { ...notice, features: {} }, null],
        ['사이트 항목의 기능 id 없음', { ...notice, sites: [{ host: 'a' }] }, null],
        ['사이트 항목의 host 수', { ...notice, sites: [{ host: 1, featureId: null }] }, null],
        ['사이트 항목이 배열', { ...notice, sites: [[]] }, null],
        ['sites null', { ...notice, sites: null }, null],
        ['키를 가진 배열', arrayWith(notice), null],
        ['빈 배열', [], null],
        ['null', null, null],
        ['없음', undefined, null],
      ],
      parseRepairNotice,
    );
  });

  it('결정 0023 팝업이 남긴 범주', async () => {
    await checkAsync<unknown>(
      [
        ...categories.map((category): Row<unknown> => [category, { category }, category]),
        ['모르는 키', { category: 'media', extra: 1 }, 'media'],
        ['고를 수 없는 범주', { category: 'settings' }, null],
        ['범주 없음', {}, null],
        ['범주 null', { category: null }, null],
        ['키를 가진 배열', arrayWith({ category: 'media' }), null],
        ['문자열', 'media', null],
        ['없음', undefined, null],
      ],
      (value) =>
        readRememberedCategory(
          createFakeStore(value === undefined ? {} : { [popupStateKey]: value }),
        ),
    );
  });

  it('결정 0024 작업 기록', () => {
    const running = { id: 't', featureId: 'f', status: 'running' };
    const succeeded = { id: 't', featureId: 'f', status: 'succeeded', summary: null };
    const failed = {
      id: 't',
      featureId: 'f',
      status: 'failed',
      error: { kind: 'timeout', message: '시간이 넘었다.' },
    };
    check<unknown>(
      [
        ['없음', undefined, {}],
        ['빈 기록', {}, {}],
        ['진행 중', { 1: running }, { 1: running }],
        ['성공(요약 없음)', { 1: succeeded }, { 1: succeeded }],
        [
          '성공(요약)',
          { 1: { ...succeeded, summary: 'a.srt' } },
          { 1: { ...succeeded, summary: 'a.srt' } },
        ],
        ['실패', { 1: failed }, { 1: failed }],
        ['탭 키가 수가 아닌 글자', { tab: running }, { tab: running }],
        ['모르는 키', { 1: { ...running, extra: 1 } }, { 1: running }],
        [
          '오류의 모르는 키',
          { 1: { ...failed, error: { ...failed.error, at: 1 } } },
          { 1: failed },
        ],
        ['성공에 요약 없음', { 1: { id: 't', featureId: 'f', status: 'succeeded' } }, null],
        ['모르는 단계', { 1: { ...running, status: 'done' } }, null],
        ['모르는 오류 종류', { 1: { ...failed, error: { kind: 'nope', message: 'm' } } }, null],
        ['오류 설명 없음', { 1: { ...failed, error: { kind: 'timeout' } } }, null],
        ['id 수', { 1: { ...running, id: 1 } }, null],
        ['기록이 배열', { 1: [] }, null],
        ['기록이 키를 가진 배열', { 1: arrayWith(running) }, null],
        ['전체가 배열', [running], null],
        ['전체가 null', null, null],
      ],
      parseTasks,
    );
  });

  it('COM-5 결정 0026 문제 기록: 앞의 기록을 읽을 수 있으면 잇고, 없으면 새로 시작한다', async () => {
    const at = 1_800_000_000_000;
    const record = { at: 1, featureId: null, kind: 'timeout' };
    const element = { id: 'chatgpt.thread', name: '대화 열' };
    const added = { at, featureId: null, kind: 'unexpected' };
    await checkAsync<unknown>(
      [
        ['빈 기록', [], [added]],
        ['맞는 기록', [record], [record, added]],
        [
          '요소가 있는 기록',
          [{ ...record, featureId: 'f', kind: 'not-found', element }],
          [{ ...record, featureId: 'f', kind: 'not-found', element }, added],
        ],
        [
          '결정 0034 적용되지 않음의 기록',
          [{ ...record, featureId: 'f', kind: 'not-applied', element }],
          [{ ...record, featureId: 'f', kind: 'not-applied', element }, added],
        ],
        ['모르는 키', [{ ...record, extra: 1 }], [record, added]],
        [
          '요소의 모르는 키',
          [{ ...record, element: { ...element, x: 1 } }],
          [{ ...record, element }, added],
        ],
        [
          '요소 이름 64자',
          [{ ...record, element: { ...element, name: '가'.repeat(64) } }],
          [{ ...record, element: { ...element, name: '가'.repeat(64) } }, added],
        ],
        [
          '요소 이름 65자',
          [{ ...record, element: { ...element, name: '가'.repeat(65) } }],
          [added],
        ],
        [
          '요소 이름 BMP 밖 64자(UTF-16 128)',
          [{ ...record, element: { ...element, name: emoji.repeat(64) } }],
          [{ ...record, element: { ...element, name: emoji.repeat(64) } }, added],
        ],
        [
          '요소 이름 BMP 밖 65자',
          [{ ...record, element: { ...element, name: emoji.repeat(65) } }],
          [added],
        ],
        [
          '요소 이름 짝 없는 대리 문자 64개',
          [{ ...record, element: { ...element, name: lone.repeat(64) } }],
          [{ ...record, element: { ...element, name: lone.repeat(64) } }, added],
        ],
        [
          '요소 이름 짝 없는 대리 문자 65개',
          [{ ...record, element: { ...element, name: lone.repeat(65) } }],
          [added],
        ],
        ['요소 null', [{ ...record, element: null }], [added]],
        ['at 1.5', [{ ...record, at: 1.5 }], [added]],
        ['at 2^53', [{ ...record, at: big }], [added]],
        ['모르는 종류', [{ ...record, kind: 'nope' }], [added]],
        ['기능 id 없음', [{ at: 1, kind: 'timeout' }], [added]],
        ['기록 하나가 배열', [arrayWith(record)], [added]],
        ['전체가 객체', { 0: record }, [added]],
        ['전체가 null', null, [added]],
      ],
      async (previous) => {
        const store = createFakeStore({ problems: previous });
        const request = startTestBackground({ store, features, startTime: at });
        const result = await request(problemReport, { featureId: null, kind: 'unexpected' });
        if (!result.ok) throw new Error(result.error.message);
        return store.peek('problems');
      },
    );
  });
});

describe('메시지의 받아들임과 거절', () => {
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';

  type AnyRequest = RequestDefinition<string, unknown, unknown>;

  // 요청을 받는 쪽의 검증(결정 0006). 콘텐츠 스크립트의 받기(listenExtensionRequest)로 정의마다의 요청 스키마를 본다. 받아들이면
  // 처리기가 받은 값(스키마를 거친 값)을, 거절하면 'rejected'(invalid-input)를, 봉투가 틀려 듣지 않으면 'ignored'를 낸다.
  // 서비스 워커의 라우터도 같은 정의의 스키마로 검증한다(`src/background/router.test.ts`).
  function payloadOutcome(definition: AnyRequest): (message: unknown) => unknown {
    let listener: ((...args: unknown[]) => boolean) | undefined;
    vi.stubGlobal('chrome', {
      runtime: {
        id: extensionId,
        onMessage: {
          addListener: (handler: (...args: unknown[]) => boolean) => {
            listener = handler;
          },
          removeListener: () => undefined,
        },
      },
    });
    const received: unknown[] = [];
    listenExtensionRequest(definition, (payload) => {
      received.push(payload);
      return err(appError('cancelled', '시험은 받은 값만 본다.'));
    });
    return (message) => {
      received.length = 0;
      let answered: unknown;
      listener?.(message, { id: extensionId }, (response: unknown) => {
        answered = response;
      });
      if (received.length > 0) return { accepted: received[0] };
      return answered === undefined ? 'ignored' : 'rejected';
    };
  }

  const payloads = (definition: AnyRequest, rows: readonly Row<unknown>[]) => {
    const outcome = payloadOutcome(definition);
    check(
      rows.map(([name, payload, expected]): Row<unknown> => [
        `${definition.type}: ${name}`,
        { type: definition.type, payload },
        expected,
      ]),
      outcome,
    );
  };
  const accepted = (value: unknown) => ({ accepted: value });
  // JSON에서 읽은 값처럼 원형과 같은 이름의 키를 제 속성으로 가진 객체.
  const prototypeNames: unknown = JSON.parse('{"constructor":1,"prototype":2}');

  it('결정 0006 봉투: type은 글자, payload 키가 있어야 한다', () => {
    const outcome = payloadOutcome(storageEnsureReady);
    check<unknown>(
      [
        ['맞는 봉투', { type: 'storage.ensureReady', payload: {} }, accepted({})],
        ['payload 없음', { type: 'storage.ensureReady' }, 'ignored'],
        ['다른 요청', { type: 'task.notice', payload: {} }, 'ignored'],
        ['type 수', { type: 1, payload: {} }, 'ignored'],
        ['배열', ['storage.ensureReady', {}], 'ignored'],
        ['키를 가진 배열', arrayWith({ type: 'storage.ensureReady', payload: {} }), 'ignored'],
        ['문자열', 'storage.ensureReady', 'ignored'],
        ['null', null, 'ignored'],
      ],
      outcome,
    );
  });

  it('결정 0006 요청 정의마다의 요청 내용', () => {
    expect(requests.map(({ type }) => type)).toEqual([
      'settings.update',
      'storage.ensureReady',
      'repairNotice.dismiss',
      'problem.report',
      'popup.remember',
      'tab.status',
      'task.start',
      'task.seen',
    ]);
    payloads(settingsUpdate, [
      [
        '맞는 값',
        { featureId: 'media-speed', patch: { enabled: true } },
        accepted({ featureId: 'media-speed', patch: { enabled: true } }),
      ],
      ['빈 patch', { featureId: 'f', patch: {} }, accepted({ featureId: 'f', patch: {} })],
      ['모르는 키', { featureId: 'f', patch: {}, x: 1 }, accepted({ featureId: 'f', patch: {} })],
      [
        'patch의 원형 이름 키',
        { featureId: 'f', patch: prototypeNames },
        accepted({ featureId: 'f', patch: prototypeNames }),
      ],
      ['patch 배열', { featureId: 'f', patch: [] }, 'rejected'],
      ['patch 키를 가진 배열', { featureId: 'f', patch: arrayWith({ enabled: true }) }, 'rejected'],
      ['patch null', { featureId: 'f', patch: null }, 'rejected'],
      ['patch 없음', { featureId: 'f' }, 'rejected'],
      ['featureId 수', { featureId: 1, patch: {} }, 'rejected'],
    ]);
    payloads(storageEnsureReady, [
      ['빈 객체', {}, accepted({})],
      ['모르는 키', { x: 1 }, accepted({})],
      ['배열', [], 'rejected'],
      ['null', null, 'rejected'],
      ['문자열', '', 'rejected'],
    ]);
    payloads(repairNoticeDismiss, [
      ['stamp 1', { stamp: 1 }, accepted({ stamp: 1 })],
      ['stamp 0', { stamp: 0 }, accepted({ stamp: 0 })],
      ['stamp -1', { stamp: -1 }, accepted({ stamp: -1 })],
      ['stamp 2^53 − 1', { stamp: maxSafe }, accepted({ stamp: maxSafe })],
      ['stamp 2^53', { stamp: big }, 'rejected'],
      ['stamp 1.5', { stamp: 1.5 }, 'rejected'],
      ['stamp NaN', { stamp: Number.NaN }, 'rejected'],
      ['stamp "1"', { stamp: '1' }, 'rejected'],
      ['키를 가진 배열', arrayWith({ stamp: 1 }), 'rejected'],
    ]);
    const element = { id: 'chatgpt.thread', name: '대화 열' };
    payloads(problemReport, [
      [
        '기능 없음',
        { featureId: null, kind: 'unexpected' },
        accepted({ featureId: null, kind: 'unexpected' }),
      ],
      [
        '요소',
        { featureId: 'f', kind: 'not-found', element },
        accepted({ featureId: 'f', kind: 'not-found', element }),
      ],
      [
        '결정 0034 적용되지 않은 요소',
        { featureId: 'f', kind: 'not-applied', element },
        accepted({ featureId: 'f', kind: 'not-applied', element }),
      ],
      [
        '요소 undefined',
        { featureId: 'f', kind: 'timeout', element: undefined },
        accepted({ featureId: 'f', kind: 'timeout' }),
      ],
      [
        '요소의 모르는 키',
        { featureId: 'f', kind: 'not-found', element: { ...element, x: 1 } },
        accepted({ featureId: 'f', kind: 'not-found', element }),
      ],
      [
        '요소 id 64자',
        { featureId: 'f', kind: 'not-found', element: { ...element, id: 'a'.repeat(64) } },
        accepted({
          featureId: 'f',
          kind: 'not-found',
          element: { ...element, id: 'a'.repeat(64) },
        }),
      ],
      [
        '요소 id 65자',
        { featureId: 'f', kind: 'not-found', element: { ...element, id: 'a'.repeat(65) } },
        'rejected',
      ],
      [
        '요소 이름 BMP 밖 64자',
        { featureId: 'f', kind: 'not-found', element: { ...element, name: emoji.repeat(64) } },
        accepted({
          featureId: 'f',
          kind: 'not-found',
          element: { ...element, name: emoji.repeat(64) },
        }),
      ],
      [
        '요소 이름 BMP 밖 65자',
        { featureId: 'f', kind: 'not-found', element: { ...element, name: emoji.repeat(65) } },
        'rejected',
      ],
      ['요소 null', { featureId: 'f', kind: 'not-found', element: null }, 'rejected'],
      ['요소 이름 없음', { featureId: 'f', kind: 'not-found', element: { id: 'a' } }, 'rejected'],
      ['모르는 종류', { featureId: null, kind: 'nope' }, 'rejected'],
      ['featureId 없음', { kind: 'unexpected' }, 'rejected'],
      ['featureId undefined', { featureId: undefined, kind: 'unexpected' }, 'rejected'],
    ]);
    payloads(tabStatus, [
      ['탭 1', { tabId: 1 }, accepted({ tabId: 1 })],
      ['탭 -1', { tabId: -1 }, accepted({ tabId: -1 })],
      ['탭 1.5', { tabId: 1.5 }, 'rejected'],
      ['탭 Infinity', { tabId: Number.POSITIVE_INFINITY }, 'rejected'],
      ['탭 "1"', { tabId: '1' }, 'rejected'],
      ['탭 없음', {}, 'rejected'],
    ]);
    payloads(taskStart, [
      ['맞는 값', { featureId: 'f', tabId: 2 }, accepted({ featureId: 'f', tabId: 2 })],
      ['탭 1.5', { featureId: 'f', tabId: 1.5 }, 'rejected'],
      ['기능 없음', { tabId: 2 }, 'rejected'],
    ]);
    payloads(taskSeen, [
      ['맞는 값', { tabId: 2, taskId: 't' }, accepted({ tabId: 2, taskId: 't' })],
      ['빈 작업 id', { tabId: 2, taskId: '' }, accepted({ tabId: 2, taskId: '' })],
      ['작업 id 없음', { tabId: 2 }, 'rejected'],
      ['작업 id 수', { tabId: 2, taskId: 1 }, 'rejected'],
    ]);
    payloads(taskNotice, [
      ['빈 글', { text: '' }, accepted({ text: '' })],
      ['500자', { text: '가'.repeat(500) }, accepted({ text: '가'.repeat(500) })],
      ['501자', { text: '가'.repeat(501) }, 'rejected'],
      [
        'BMP 밖 500자(UTF-16 1000)',
        { text: emoji.repeat(500) },
        accepted({ text: emoji.repeat(500) }),
      ],
      ['BMP 밖 501자', { text: emoji.repeat(501) }, 'rejected'],
      ['짝 없는 대리 문자 500개', { text: lone.repeat(500) }, accepted({ text: lone.repeat(500) })],
      ['짝 없는 대리 문자 501개', { text: lone.repeat(501) }, 'rejected'],
      ['글 수', { text: 1 }, 'rejected'],
    ]);
    payloads(pageStatus, [
      ['빈 객체', {}, accepted({})],
      ['배열', [], 'rejected'],
    ]);
  });

  // 응답의 검증(결정 0006). 탭에 보내기(sendToTab)로 정의마다의 응답 값 스키마를 본다. 형식에 맞는 성공 답이면 그 값이다.
  async function valueOutcome(definition: AnyRequest, value: unknown): Promise<unknown> {
    vi.stubGlobal('chrome', {
      tabs: { sendMessage: () => Promise.resolve({ ok: true, value }) },
    });
    const response = await sendToTab(definition, 1, null);
    return response.delivery === 'delivered' ? { accepted: response.value } : response.delivery;
  }

  const values = async (definition: AnyRequest, rows: readonly Row<unknown>[]) => {
    await checkAsync(
      rows.map(([name, value, expected]): Row<unknown> => [
        `${definition.type}: ${name}`,
        value,
        expected,
      ]),
      (value) => valueOutcome(definition, value),
    );
  };

  it('결정 0006 요청 정의마다의 응답 값', async () => {
    const element = { id: 'chatgpt.thread', name: '대화 열' };
    const unmet = [
      { featureId: 'f', reason: 'not-found', element },
      { featureId: 'g', reason: 'not-applied', element },
    ];
    await values(settingsUpdate, [
      ['revision', { revision: 5 }, accepted({ revision: 5 })],
      ['revision 1.5', { revision: 1.5 }, 'failed'],
      ['모르는 키', { revision: 5, x: 1 }, accepted({ revision: 5 })],
    ]);
    for (const definition of [
      storageEnsureReady,
      repairNoticeDismiss,
      problemReport,
      taskSeen,
      taskNotice,
    ]) {
      await values(definition, [
        ['null', null, accepted(null)],
        ['없음', undefined, 'failed'],
        ['빈 객체', {}, 'failed'],
      ]);
    }
    const ready = { page: 'ready', bundle: 'common' };
    await values(tabStatus, [
      ['쓸 수 있음', { ...ready, unmet: [] }, accepted({ ...ready, unmet: [] })],
      ['어긋남(찾지 못함, 적용되지 않음)', { ...ready, unmet }, accepted({ ...ready, unmet })],
      [
        'ChatGPT 묶음',
        { page: 'ready', bundle: 'chatgpt', unmet: [] },
        accepted({ page: 'ready', bundle: 'chatgpt', unmet: [] }),
      ],
      ['새로 고쳐야 함', { page: 'reload' }, accepted({ page: 'reload' })],
      ['접근할 수 없음', { page: 'denied' }, accepted({ page: 'denied' })],
      [
        '새로 고쳐야 함의 어긋남은 빠짐',
        { page: 'reload', unmet: [] },
        accepted({ page: 'reload' }),
      ],
      ['쓸 수 있음에 어긋남 없음', ready, 'failed'],
      ['결정 0034 앞 판의 답(notFound)', { ...ready, notFound: [] }, 'failed'],
      ['쓸 수 있음에 묶음 없음', { page: 'ready', unmet: [] }, 'failed'],
      ['모르는 묶음', { page: 'ready', bundle: 'youtube', unmet: [] }, 'failed'],
      ['모르는 단계', { page: 'nope' }, 'failed'],
      ['어긋남이 객체', { ...ready, unmet: {} }, 'failed'],
      [
        '어긋남의 요소 이름 65자',
        {
          ...ready,
          unmet: [
            { featureId: 'f', reason: 'not-found', element: { ...element, name: '가'.repeat(65) } },
          ],
        },
        'failed',
      ],
      ['어긋남의 원소가 배열', { ...ready, unmet: [[]] }, 'failed'],
      ['어긋남의 까닭 없음', { ...ready, unmet: [{ featureId: 'f', element }] }, 'failed'],
      [
        '모르는 까닭',
        { ...ready, unmet: [{ featureId: 'f', reason: 'timeout', element }] },
        'failed',
      ],
    ]);
    await values(taskStart, [
      ['작업 id', { taskId: 'task-1' }, accepted({ taskId: 'task-1' })],
      ['작업 id 없음', {}, 'failed'],
    ]);
    await values(pageStatus, [
      ['어긋남 없음', { unmet: [] }, accepted({ unmet: [] })],
      ['어긋남', { unmet }, accepted({ unmet })],
      ['어긋남이 객체', { unmet: {} }, 'failed'],
      ['결정 0034 앞 판의 답(notFound)', { notFound: [] }, 'failed'],
      ['키를 가진 배열', arrayWith({ unmet: [] }), 'failed'],
    ]);
  });

  it('결정 0006 응답 봉투: 성공 값이나 오류 종류와 설명', async () => {
    vi.useFakeTimers();
    let response: unknown;
    vi.stubGlobal('chrome', {
      runtime: { id: extensionId, sendMessage: () => Promise.resolve(response) },
    });
    const request = chromeRequester();
    await checkAsync<unknown>(
      [
        ['성공', { ok: true, value: null }, { ok: true, value: null }],
        ['성공의 모르는 키', { ok: true, value: null, x: 1 }, { ok: true, value: null }],
        // 서비스 워커가 실패로 답했다(결정 0036).
        [
          '실패',
          { ok: false, error: { kind: 'timeout', message: '넘었다.' } },
          { ok: false, error: { kind: 'timeout', message: '넘었다.', answered: true } },
        ],
        [
          '실패의 모르는 키',
          { ok: false, error: { kind: 'limit', message: 'm', x: 1 } },
          { ok: false, error: { kind: 'limit', message: 'm', answered: true } },
        ],
        // 받는 쪽은 답했는지를 정하지 못한다. 요청 도우미가 정한다.
        [
          '실패에 답하지 않았다고 적음',
          { ok: false, error: { kind: 'limit', message: 'm', answered: false } },
          { ok: false, error: { kind: 'limit', message: 'm', answered: true } },
        ],
        ['성공에 값 없음', { ok: true }, 'unexpected'],
        ['성공 표시가 글자', { ok: 'true', value: null }, 'unexpected'],
        ['모르는 오류 종류', { ok: false, error: { kind: 'nope', message: 'm' } }, 'unexpected'],
        ['오류 설명 없음', { ok: false, error: { kind: 'timeout' } }, 'unexpected'],
        ['키를 가진 배열', arrayWith({ ok: true, value: null }), 'unexpected'],
        ['없음', undefined, 'unexpected'],
      ],
      async (value) => {
        response = value;
        const pending = request(storageEnsureReady, {});
        // 형식이 틀린 응답은 연결이 끊긴 것인지 보려고 잠시 기다린다(결정 0008).
        await vi.advanceTimersByTimeAsync(1000);
        const result = await pending;
        return result.ok || result.error.kind !== 'unexpected' ? result : 'unexpected';
      },
    );
  });

  it('결정 0024 팝업 연결의 첫 메시지(탭 id)', () => {
    const listeners: ((port: unknown) => void)[] = [];
    const base = `chrome-extension://${extensionId}/`;
    vi.stubGlobal('chrome', {
      runtime: {
        id: extensionId,
        getURL: (path: string) => `${base}${path}`,
        onConnect: { addListener: (listener: (port: unknown) => void) => listeners.push(listener) },
      },
    });
    const watch = watchPopups();
    check<boolean>(
      [
        ['탭 3', { tabId: 3 }, true],
        ['모르는 키', { tabId: 3, x: 1 }, true],
        ['탭 3.5', { tabId: 3.5 }, false],
        ['탭 "3"', { tabId: '3' }, false],
        ['탭 없음', {}, false],
        ['키를 가진 배열', arrayWith({ tabId: 3 }), false],
        ['수', 3, false],
      ],
      (hello) => {
        let send: ((message: unknown) => void) | undefined;
        let disconnect: (() => void) | undefined;
        const port = {
          name: popupPort.name,
          sender: { id: extensionId, origin: new URL(base).origin },
          disconnect: () => undefined,
          onMessage: { addListener: (listener: (message: unknown) => void) => (send = listener) },
          onDisconnect: { addListener: (listener: () => void) => (disconnect = listener) },
        };
        for (const listener of listeners) listener(port);
        send?.(hello);
        const viewing = watch.viewing(3);
        disconnect?.();
        return viewing;
      },
    );
  });
});
