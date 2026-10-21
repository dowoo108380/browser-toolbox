import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { featureCommand, storageEnsureReady, tabToggleSet, v } from '../../src/contracts/index.ts';
import { createScope } from '../../src/dom/index.ts';
import { tabKeepActive } from '../../src/features/tab-keep-active/feature.ts';
import { page } from '../../src/features/tab-keep-active/page.ts';
import { createFakeStore } from '../../src/platform/fake.ts';
import { appError, err, ok } from '../../src/shared/index.ts';
import { startTestBackgroundFrom } from '../support/background.ts';
import { type FakeBrowser, createFakeBrowser } from '../support/fake-browser.ts';

// 페이지 활성 상태 유지(TAB-2)의 페이지 쪽 일(features/tab-keep-active/page.ts)과 서비스 워커를 실제 모듈끼리 잇는다(quality
// 094): 페이지 쪽 일이 보낸 명령이 실제 서비스 워커(라우터, 탭마다 켜고 끄기의 공용 부분, 기능의 서비스 워커 쪽)에 닿는다. 가짜는
// Chrome 경계뿐이다: 저장소, 탭·창·디버거(tests/support/fake-browser.ts), 시계(가짜 타이머), 문서의 실제 보임(화면 없는
// Chromium의 문서는 늘 visible이라 시험이 정한다). 페이지 쪽 일은 실행 틀이 이 탭에서 켜졌다고 받은 때처럼 시작한다.

const closers: (() => void)[] = [];
let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  for (const close of closers.splice(0)) close();
  Reflect.deleteProperty(document, 'visibilityState');
  visibility = 'visible';
  vi.useRealTimers();
});

// 몇 번의 약속 차례와 0ms 타이머를 흘린다(서비스 워커의 일은 여러 await를 거친다).
async function settle() {
  for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(0);
}

async function startWorld(browser: FakeBrowser) {
  const from = startTestBackgroundFrom({
    store: createFakeStore(),
    session: createFakeStore(),
    features: [tabKeepActive],
    startTime: 1_790_000_000_000,
    browser,
  });
  const popup = from({ kind: 'extension' });
  await popup(storageEnsureReady, {});
  await settle();
  return { popup, from };
}

type World = Awaited<ReturnType<typeof startWorld>>;

// 그 탭의 최상위 프레임에서 페이지 쪽 일을 시작한다. 명령은 콘텐츠 스크립트가 보내는 길(feature.command)로 서비스 워커에
// 닿고, 답은 실행 틀처럼 명령의 스키마로 검증한다.
function startPage(world: World, tabId: number) {
  const content = world.from({ kind: 'content', tabId, frameId: 0 });
  const scope = createScope({ window, onError: () => undefined, isLive: () => true });
  closers.push(scope.close);
  page.start(
    { features: new Map(), sites: new Map() },
    {
      window,
      document,
      scope,
      topFrame: true,
      find: () => {
        throw new Error('외부 화면 요소를 찾지 않는다.');
      },
      verify: () => {
        throw new Error('외부 화면 요소를 확인하지 않는다.');
      },
      send: async (command, payload) => {
        const sent = await content(featureCommand, {
          featureId: command.featureId,
          name: command.name,
          payload,
        });
        if (!sent.ok) return sent;
        const value = v.safeParse(command.value, sent.value);
        return value.success ? ok(value.output) : err(appError('unexpected', '답의 형식'));
      },
      answer: () => undefined,
    },
  );
}

describe('TAB-2 페이지 쪽과 서비스 워커 쪽(결정 0041)', () => {
  it('TAB-2.18 켜는 순간 이미 가려진 창의 활성 탭: 숨은 채 시작한 페이지 쪽이 숨김을 알려 디버거가 붙는다', async () => {
    // 창 1의 활성 탭 1. 창은 최소화되지 않았고 초점이 없다(다른 창이 완전히 덮음).
    const browser = createFakeBrowser();
    browser.open({ id: 1, active: true });
    browser.focus(1, false);
    const world = await startWorld(browser);
    expect(
      await world.popup(tabToggleSet, { featureId: tabKeepActive.id, tabIds: [1], on: true }),
    ).toEqual(ok(null));
    await settle();
    // 서비스 워커만으로는 보는 탭이다(창이 가려졌는지 Chrome이 알려 주지 않는다).
    expect(browser.attached()).toEqual([]);
    visibility = 'hidden';
    startPage(world, 1);
    await settle();
    expect(browser.attached()).toEqual([1]);
  });
});
