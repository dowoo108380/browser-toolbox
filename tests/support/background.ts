import { startBackground } from '../../src/background/index.ts';
import { type FeatureDefinition, responseSchema } from '../../src/contracts/index.ts';
import type { LocalStore, Requester, Sender } from '../../src/platform/index.ts';
import { appError, err } from '../../src/shared/index.ts';
import { settingsFormat } from '../../src/storage/index.ts';

// 실제 모듈끼리 연결한 시험(tests/integration)이 실제 서비스 워커(startBackground)를 시작한다. 가짜는 Chrome 경계뿐이다:
// 저장소(받은 것), 메시지 통로(돌려주는 요청 함수), 시계(startTime에서 시작해 기다린 만큼만 간다). 설치 이벤트와 옛 스크립트
// 정리는 하지 않는다. 테스트에서만 가져온다.

export interface TestBackgroundOptions {
  readonly store: LocalStore;
  readonly features: readonly FeatureDefinition[];
  readonly startTime: number;
  // 요청이 서비스 워커에 닿는 때를 시험이 정한다(응답 순서를 바꾸는 시험). 없으면 바로 닿는다.
  readonly deliver?: (type: string, send: () => Promise<unknown>) => Promise<unknown>;
}

// 확장 화면과 콘텐츠 스크립트가 쓰는 요청 함수를 돌려준다. chromeRequester처럼 메시지를 구조화 복제로 건네고,
// 응답을 그 요청의 정의로 검증한다.
export function startTestBackground(options: TestBackgroundOptions): Requester {
  let handle: ((message: unknown, sender: Sender) => Promise<unknown>) | undefined;
  const clock = { time: options.startTime };
  startBackground({
    features: options.features,
    format: settingsFormat,
    store: options.store,
    now: () => clock.time,
    sleep: (ms) => {
      clock.time += ms;
      return Promise.resolve();
    },
    listenRequests: (listener) => {
      handle = listener;
    },
    onInstalled: () => undefined,
    retireOldScripts: () => Promise.resolve(),
  });
  const deliver = options.deliver ?? ((_type, send) => send());
  return async (definition, payload) => {
    const send = async (): Promise<unknown> => {
      if (handle === undefined) throw new Error('서비스 워커가 요청을 듣지 않는다.');
      const message = structuredClone({ type: definition.type, payload });
      return structuredClone(await handle(message, { kind: 'extension' }));
    };
    const response = await deliver(definition.type, send);
    const parsed = responseSchema(definition.value).safeParse(response);
    return parsed.success
      ? parsed.data
      : err(appError('unexpected', '확장의 응답 형식이 맞지 않는다.'));
  };
}
