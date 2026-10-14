import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { retireEventName } from '../../contracts/index.ts';
import { createScope, hostTagName } from '../../dom/index.ts';
import { type PagePart, startPageRuntime } from '../../page/index.ts';
import { type ErrorKind, ok } from '../../shared/index.ts';
import type { SettingsReaderHandlers, Snapshot } from '../../storage/index.ts';
import { page } from './page.ts';

// 표시창은 닫힌 shadow root 안에 있다. 테스트는 attachShadow가 돌려준 root를 잡아서 안을 본다.
let roots: ShadowRoot[] = [];
const added: Element[] = [];
// eslint-disable-next-line @typescript-eslint/unbound-method -- 아래에서 call로 this를 주어 부른다.
const originalAttachShadow = Element.prototype.attachShadow;

beforeEach(() => {
  roots = [];
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (
    this: Element,
    init: ShadowRootInit,
  ) {
    const root = originalAttachShadow.call(this, init);
    roots.push(root);
    return root;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const element of added.splice(0)) element.remove();
});

const enabled: Snapshot = {
  features: new Map([['media-speed', { enabled: true }]]),
  sites: new Map(),
};
const disabled: Snapshot = { features: new Map(), sites: new Map() };

function addVideo(width: number, height: number): HTMLVideoElement {
  const video = document.createElement('video');
  video.style.width = `${String(width)}px`;
  video.style.height = `${String(height)}px`;
  video.style.display = 'block';
  document.body.append(video);
  added.push(video);
  return video;
}

function labels(): string[] {
  return roots.map((root) => root.querySelector('.indicator')?.textContent ?? '');
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

// 실행 틀 없이 기능만 시작한다. 돌려준 close가 실행 틀이 기능을 끌 때 하는 일이다.
function start(snapshot: Snapshot) {
  const errors: unknown[] = [];
  const scope = createScope(window, {
    onError: (error) => errors.push(error),
    isLive: () => true,
  });
  page.start(snapshot, { window, document, scope });
  return { close: scope.close, errors };
}

describe('배속 표시창(05단계 뼈대)', () => {
  it('꺼져 있으면 시작하지 않는다', () => {
    addVideo(320, 180);
    start(disabled);
    expect(document.querySelectorAll(hostTagName)).toHaveLength(0);
  });

  it('영상마다 지금 배속을 보이고, 배속이 바뀌면 바로 바꾼다(MED-3.1)', async () => {
    const video = addVideo(320, 180);
    const { close } = start(enabled);
    expect(labels()).toEqual(['1×']);
    video.playbackRate = 1.5;
    await vi.waitFor(() => {
      expect(labels()).toEqual(['1.5×']);
    });
    close();
  });

  it('나중에 생긴 영상에도 띄우고, 사라진 영상의 표시창은 지운다', async () => {
    const { close } = start(enabled);
    const video = addVideo(320, 180);
    await vi.waitFor(() => {
      expect(document.querySelectorAll(hostTagName)).toHaveLength(1);
    });
    video.remove();
    await vi.waitFor(() => {
      expect(document.querySelectorAll(hostTagName)).toHaveLength(0);
    });
    close();
  });

  it('작은 영상(100px 미만)에는 보이지 않는다(MED-3 기대 동작 5)', async () => {
    addVideo(80, 60);
    const { close } = start(enabled);
    await nextFrame();
    const label = roots[0]?.querySelector<HTMLElement>('.indicator');
    expect(label?.hidden).toBe(true);
    close();
  });

  it('COM-1.3 끄면 더한 요소가 남지 않는다', () => {
    addVideo(320, 180);
    const before = document.documentElement.outerHTML;
    const { close } = start(enabled);
    expect(document.querySelectorAll(hostTagName)).toHaveLength(1);
    close();
    expect(document.documentElement.outerHTML).toBe(before);
  });
});

describe('quality 010 배속 표시창의 콜백이 실패할 때(결정 0014)', () => {
  // 실행 틀에 배속 표시창과 다른 기능 하나를 올린다. 다른 기능은 문서의 ping 이벤트를 센다.
  const connected = { value: true };
  let pings = 0;
  const other: PagePart = {
    featureId: 'other',
    start: (_snapshot, { scope }) => {
      scope.listen(document, 'test-ping', () => {
        pings += 1;
      });
    },
  };

  function startRuntime() {
    const reports: { featureId: string | null; kind: ErrorKind }[] = [];
    let handlers: SettingsReaderHandlers | undefined;
    startPageRuntime({
      parts: [page, other],
      context: { window, document },
      subscribe: (next) => {
        handlers = next;
        return () => undefined;
      },
      report: (featureId, kind) => {
        reports.push({ featureId, kind });
        return Promise.resolve(ok(null));
      },
      isConnected: () => connected.value,
    });
    handlers?.apply(enabled);
    return reports;
  }

  afterEach(() => {
    // 실행 틀을 물러나게 해 다음 테스트에 남기지 않는다.
    connected.value = false;
    document.dispatchEvent(new Event(retireEventName));
    connected.value = true;
    pings = 0;
  });

  // 표시창이 모두 사라지고 배속 표시창만 기록되며, 다른 기능은 계속 이벤트를 받는다.
  function expectOnlyIndicatorStopped(reports: readonly unknown[], before: string) {
    expect(document.querySelectorAll(hostTagName)).toHaveLength(0);
    expect(document.documentElement.outerHTML).toBe(before);
    expect(reports).toEqual([{ featureId: 'media-speed', kind: 'unexpected' }]);
    document.dispatchEvent(new Event('test-ping'));
    expect(pings).toBe(1);
  }

  it('배속 바뀜을 처리하다 예외가 나면 그 기능의 표시창을 모두 치우고 기록한다', () => {
    const video = addVideo(320, 180);
    addVideo(320, 180);
    const before = document.documentElement.outerHTML;
    const reports = startRuntime();
    expect(document.querySelectorAll(hostTagName)).toHaveLength(2);
    // 배속을 읽다가 예외가 나는 경우를 흉내 낸다.
    Object.defineProperty(video, 'playbackRate', {
      configurable: true,
      get: () => {
        throw new Error('배속을 읽지 못함');
      },
    });
    expect(() => video.dispatchEvent(new Event('ratechange'))).not.toThrow();
    expectOnlyIndicatorStopped(reports, before);
  });

  it('크기 관찰 뒤 위치를 다시 놓다가 예외가 나도 그 기능만 멈추고 기록한다', async () => {
    const video = addVideo(320, 180);
    const before = document.documentElement.outerHTML;
    const reports = startRuntime();
    await nextFrame();
    video.getBoundingClientRect = () => {
      throw new Error('위치를 읽지 못함');
    };
    video.style.width = '400px';
    await vi.waitFor(() => {
      expect(reports).toHaveLength(1);
    });
    Reflect.deleteProperty(video, 'getBoundingClientRect');
    video.style.width = '320px';
    expectOnlyIndicatorStopped(reports, before);
  });
});
