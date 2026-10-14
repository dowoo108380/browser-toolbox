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
// 시작한 기능을 끄는 함수. 시험이 중간에 실패해도 다음 시험에 기능이 남지 않게 afterEach에서 끈다.
const stops: (() => void)[] = [];
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
  for (const stop of stops.splice(0)) stop();
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

// index번째로 만든 표시창. 영상은 문서 순서대로 붙는다.
function labelAt(index: number): HTMLElement {
  const label = roots[index]?.querySelector<HTMLElement>('.indicator');
  if (label === null || label === undefined) throw new Error('표시창이 없다.');
  return label;
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

// 몇 프레임 기다린다. 시작 직후 크기 관찰의 첫 알림은 첫 프레임의 requestAnimationFrame 뒤에 온다.
async function frames() {
  for (let frame = 0; frame < 5; frame += 1) await nextFrame();
}

// 실행 틀 없이 기능만 시작한다. 돌려준 close가 실행 틀이 기능을 끌 때 하는 일이다.
function start(snapshot: Snapshot) {
  const errors: unknown[] = [];
  const scope = createScope(window, {
    onError: (error) => errors.push(error),
    isLive: () => true,
  });
  stops.push(scope.close);
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

  it('가로나 세로가 100px 미만인 영상에는 보이지 않고 큰 영상에는 보인다(MED-3 기대 동작 5)', async () => {
    addVideo(99, 180);
    addVideo(320, 99);
    addVideo(100, 100);
    start(enabled);
    await frames();
    expect([0, 1, 2].map((index) => labelAt(index).hidden)).toEqual([true, true, false]);
  });

  it('영상이 display: none이 되면 숨고, 다시 나타나면 보인다', async () => {
    const video = addVideo(320, 180);
    start(enabled);
    await frames();
    expect(labelAt(0).hidden).toBe(false);
    video.style.display = 'none';
    await vi.waitFor(() => {
      expect(labelAt(0).hidden).toBe(true);
    });
    video.style.display = 'block';
    await vi.waitFor(() => {
      expect(labelAt(0).hidden).toBe(false);
    });
  });

  it('처음부터 display: none인 영상에는 보이지 않는다', async () => {
    const video = addVideo(320, 180);
    video.style.display = 'none';
    start(enabled);
    await frames();
    expect(labelAt(0).hidden).toBe(true);
  });

  it('표시창의 틀은 표시창 크기만 차지하고 영상 위의 클릭을 가로채지 않는다', async () => {
    const video = addVideo(320, 180);
    start(enabled);
    await frames();
    const host = document.querySelector(hostTagName)?.getBoundingClientRect();
    const label = labelAt(0).getBoundingClientRect();
    const box = ({ left, top, width, height }: DOMRect) => ({ left, top, width, height });
    expect(host && box(host)).toEqual(box(label));
    const center = video.getBoundingClientRect();
    expect(
      document.elementFromPoint(center.left + center.width / 2, center.top + center.height / 2),
    ).toBe(video);
    // 표시창 자리를 눌러도 영상이 받는다. 뼈대의 동작이다. MED-3에서 누르기와 드래그를 정할 때 바꾼다.
    expect(
      document.elementFromPoint(label.left + label.width / 2, label.top + label.height / 2),
    ).toBe(video);
  });

  describe('영상만 다른 자리로 옮겨져도 표시창이 영상의 왼쪽 위를 따라간다(MED-3)', () => {
    // 영상의 크기는 그대로이고 스크롤도 창 크기 변경도 없는 경우들이다.
    function indicatorOn(video: HTMLVideoElement) {
      const label = labelAt(0);
      const from = video.getBoundingClientRect();
      const at = label.getBoundingClientRect();
      expect(label.hidden).toBe(false);
      expect(at.left - from.left).toBeCloseTo(8, 0);
      expect(at.top - from.top).toBeCloseTo(8, 0);
      return from.top;
    }

    // 시작 직후의 알림(크기 관찰의 첫 알림과 그에 따른 일)이 모두 끝난 뒤에 바꾼다.
    // 그러지 않으면 바꾼 뒤에 온 첫 알림이 우연히 새 위치를 반영해 결함을 가린다.
    async function settled(video: HTMLVideoElement) {
      await frames();
      return indicatorOn(video);
    }

    function addBlock(height: number): HTMLElement {
      const block = document.createElement('div');
      block.style.height = `${String(height)}px`;
      added.push(block);
      return block;
    }

    it('영상 앞에 블록이 더해지거나 빠질 때', async () => {
      const video = addVideo(320, 180);
      const { close } = start(enabled);
      const first = await settled(video);
      const block = addBlock(150);
      video.before(block);
      await vi.waitFor(() => {
        expect(indicatorOn(video)).toBeCloseTo(first + 150, 0);
      });
      block.remove();
      await vi.waitFor(() => {
        expect(indicatorOn(video)).toBeCloseTo(first, 0);
      });
      close();
    });

    it('영상 앞 블록의 높이가 바뀔 때(DOM에 더하거나 빼는 것 없이, 예: 이미지가 늦게 실림)', async () => {
      const block = addBlock(0);
      document.body.append(block);
      const video = addVideo(320, 180);
      const { close } = start(enabled);
      const first = await settled(video);
      block.style.height = '120px';
      await vi.waitFor(() => {
        expect(indicatorOn(video)).toBeCloseTo(first + 120, 0);
      });
      close();
    });

    it('같은 영상을 문서의 다른 자리로 옮길 때', async () => {
      // 영상, 200px 블록, 빈 자리 순서에서 영상을 빈 자리로 옮기면 영상은 200px 아래로 간다.
      const video = addVideo(320, 180);
      document.body.append(addBlock(200));
      const elsewhere = addBlock(0);
      elsewhere.style.height = 'auto';
      document.body.append(elsewhere);
      const { close } = start(enabled);
      const first = await settled(video);
      elsewhere.append(video);
      await vi.waitFor(() => {
        expect(indicatorOn(video)).toBeCloseTo(first + 200, 0);
      });
      // 옮겨도 같은 영상이므로 표시창은 하나다.
      expect(document.querySelectorAll(hostTagName)).toHaveLength(1);
      close();
    });
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

  it('크기 관찰 뒤 보일지 정하다가 예외가 나도 그 기능만 멈추고 기록한다', async () => {
    const video = addVideo(320, 180);
    const before = document.documentElement.outerHTML;
    const reports = startRuntime();
    await frames();
    // 표시창을 숨기거나 보이다가 예외가 나는 경우를 흉내 낸다.
    const hiding = vi.spyOn(HTMLElement.prototype, 'hidden', 'set').mockImplementation(() => {
      throw new Error('표시창을 숨기지 못함');
    });
    video.style.width = '80px';
    await vi.waitFor(() => {
      expect(reports).toHaveLength(1);
    });
    hiding.mockRestore();
    video.style.width = '320px';
    expectOnlyIndicatorStopped(reports, before);
  });
});
