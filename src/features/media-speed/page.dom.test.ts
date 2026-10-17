import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { retireEventName } from '../../contracts/index.ts';
import { createScope, hostTagName } from '../../dom/index.ts';
import { type PagePart, startPageRuntime } from '../../page/index.ts';
import { type ErrorKind, ok } from '../../shared/index.ts';
import type { SettingsReaderHandlers, Snapshot } from '../../storage/index.ts';
import { page } from './page.ts';

// 표시창은 닫힌 shadow root 안에 있다. 테스트는 attachShadow가 돌려준 root를 잡아서 안을 본다.
// 시험이 페이지 쪽에 만드는 shadow root(영상 플레이어 흉내)는 잡지 않는다.
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
    if (this.localName === hostTagName) roots.push(root);
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

// 표시창이 그려지는 상태인지(display: none이 아닌지). 스크롤 컨테이너에 가려져 숨는 것(position-visibility)은
// 이것으로 알 수 없어(checkVisibility가 그대로 참이다) 확장 전체 시험이 화면의 픽셀로 본다
// (tests/e2e/indicator-visibility.spec.ts).
function shown(index: number): boolean {
  return labelAt(index).checkVisibility();
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

// 몇 프레임 기다린다. 시작 직후 화면 그리기에 걸쳐 일어나는 일(관찰자의 첫 알림 등)이 끝난 뒤를 본다.
async function frames() {
  for (let frame = 0; frame < 5; frame += 1) await nextFrame();
}

// 실행 틀 없이 기능만 시작한다. 돌려준 close가 실행 틀이 기능을 끌 때 하는 일이다.
function start(snapshot: Snapshot) {
  const errors: unknown[] = [];
  const scope = createScope({
    window,
    onError: (error) => errors.push(error),
    isLive: () => true,
  });
  stops.push(scope.close);
  // 배속 표시창은 외부 화면 요소에 기대지 않는다.
  const find = () => {
    throw new Error('배속 표시창은 외부 화면 요소를 찾지 않는다.');
  };
  page.start(snapshot, { window, document, scope, find });
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
    expect([0, 1, 2].map(shown)).toEqual([false, false, true]);
  });

  describe('크기는 화면에 그려진 크기로 정한다(transform으로 확대·축소된 영상)', () => {
    // 영상을 감싼 요소. 감싼 요소나 영상 자체에 준 transform은 레이아웃 크기를 바꾸지 않아 크기 관찰 알림이 오지 않는다.
    function wrap(video: HTMLVideoElement): HTMLElement {
      const wrapper = document.createElement('div');
      wrapper.style.transformOrigin = '0 0';
      video.before(wrapper);
      wrapper.append(video);
      added.push(wrapper);
      return wrapper;
    }

    it('처음부터 확대·축소된 경우', async () => {
      // 200×200을 감싼 요소에서 0.4배(80×80으로 그려짐), 80×80을 영상 자체에서 2배(160×160), 200×200을 0.5배(100×100).
      wrap(addVideo(200, 200)).style.transform = 'scale(0.4)';
      const enlarged = addVideo(80, 80);
      enlarged.style.transformOrigin = '0 0';
      enlarged.style.transform = 'scale(2)';
      wrap(addVideo(200, 200)).style.transform = 'scale(0.5)';
      start(enabled);
      await frames();
      expect([0, 1, 2].map(shown)).toEqual([false, true, true]);
    });

    it('실행 중에 배율만 바뀌는 경우', async () => {
      const video = addVideo(200, 200);
      const wrapper = wrap(video);
      start(enabled);
      await frames();
      expect(shown(0)).toBe(true);
      wrapper.style.transform = 'scale(0.4)';
      await vi.waitFor(() => {
        expect(shown(0)).toBe(false);
      });
      wrapper.style.transform = '';
      await vi.waitFor(() => {
        expect(shown(0)).toBe(true);
      });
      // 영상 자체의 배율이 바뀌어 작은 영상이 커지는 경우.
      video.style.width = '80px';
      video.style.height = '80px';
      await vi.waitFor(() => {
        expect(shown(0)).toBe(false);
      });
      video.style.transformOrigin = '0 0';
      video.style.transform = 'scale(1.5)';
      await vi.waitFor(() => {
        expect(shown(0)).toBe(true);
      });
    });
  });

  it('영상이 display: none이 되면 숨고, 다시 나타나면 보인다', async () => {
    const video = addVideo(320, 180);
    start(enabled);
    await frames();
    expect(shown(0)).toBe(true);
    video.style.display = 'none';
    await vi.waitFor(() => {
      expect(shown(0)).toBe(false);
    });
    video.style.display = 'block';
    await vi.waitFor(() => {
      expect(shown(0)).toBe(true);
    });
  });

  it('처음부터 display: none인 영상에는 보이지 않는다', async () => {
    const video = addVideo(320, 180);
    video.style.display = 'none';
    start(enabled);
    await frames();
    expect(shown(0)).toBe(false);
  });

  it('표시창의 틀은 영상이 그려진 상자와 같고 영상 위의 클릭을 가로채지 않는다', async () => {
    const video = addVideo(320, 180);
    start(enabled);
    await frames();
    const host = document.querySelector(hostTagName)?.getBoundingClientRect();
    const label = labelAt(0).getBoundingClientRect();
    const box = ({ left, top, width, height }: DOMRect) => ({ left, top, width, height });
    expect(host && box(host)).toEqual(box(video.getBoundingClientRect()));
    const center = video.getBoundingClientRect();
    expect(
      document.elementFromPoint(center.left + center.width / 2, center.top + center.height / 2),
    ).toBe(video);
    // 표시창 자리를 눌러도 영상이 받는다. 뼈대의 동작이다. MED-3에서 누르기와 드래그를 정할 때 바꾼다.
    expect(
      document.elementFromPoint(label.left + label.width / 2, label.top + label.height / 2),
    ).toBe(video);
  });

  describe('영상이 다른 자리로 옮겨져도 표시창이 영상이 그려진 상자의 왼쪽 위를 따라간다(MED-3)', () => {
    // 영상의 레이아웃 크기는 그대로인 경우들이다(크기 관찰 알림이 오지 않는다).
    function indicatorOn(video: HTMLVideoElement) {
      const label = labelAt(0);
      const from = video.getBoundingClientRect();
      const at = label.getBoundingClientRect();
      expect(label.checkVisibility()).toBe(true);
      expect(at.left - from.left).toBeCloseTo(8, 0);
      expect(at.top - from.top).toBeCloseTo(8, 0);
      return from.top;
    }

    // 시작 직후의 일이 모두 끝난 뒤에 바꾼다. 그러지 않으면 바꾼 뒤에 온 시작 직후의 알림이 우연히 새 위치를
    // 반영해 결함을 가린다(크기 관찰로 다시 놓던 05단계 뼈대에서 그랬다).
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

    it('문서가 스크롤될 때', async () => {
      const video = addVideo(320, 180);
      document.body.append(addBlock(3000));
      const { close } = start(enabled);
      const first = await settled(video);
      window.scrollTo(0, 120);
      await vi.waitFor(() => {
        expect(indicatorOn(video)).toBeCloseTo(first - 120, 0);
      });
      window.scrollTo(0, 0);
      close();
    });

    it('안쪽 스크롤 컨테이너가 스크롤될 때', async () => {
      const scroller = addBlock(200);
      scroller.style.overflow = 'auto';
      document.body.append(scroller);
      const video = addVideo(320, 180);
      scroller.append(addBlock(100), video, addBlock(600));
      const { close } = start(enabled);
      const first = await settled(video);
      scroller.scrollTop = 50;
      await vi.waitFor(() => {
        expect(indicatorOn(video)).toBeCloseTo(first - 50, 0);
      });
      close();
    });

    it('감싼 요소의 transform으로 옮겨지고 줄어들 때', async () => {
      const video = addVideo(320, 180);
      const wrapper = addBlock(180);
      video.before(wrapper);
      wrapper.append(video);
      const { close } = start(enabled);
      const first = await settled(video);
      wrapper.style.transformOrigin = '0 0';
      wrapper.style.transform = 'translate(40px, 30px) scale(0.8)';
      await vi.waitFor(() => {
        expect(indicatorOn(video)).toBeCloseTo(first + 30, 0);
      });
      close();
    });
  });

  it('영상 요소에는 아무것도 적지 않는다(앵커는 popover를 연 source로 정한다)', async () => {
    const video = addVideo(320, 180);
    const before = video.outerHTML;
    start(enabled);
    await frames();
    expect(video.outerHTML).toBe(before);
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

describe('shadow root 안의 영상(MED 머리말: 모든 프레임의 미디어, 결정 0019)', () => {
  // 영상 플레이어를 사용자 정의 요소로 만든 페이지처럼, 영상이 문서 트리가 아닌 shadow 트리에 있다.
  function playerHost(mode: ShadowRootMode = 'open') {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode });
    return { host, root };
  }

  function videoInto(parent: ParentNode): HTMLVideoElement {
    const video = document.createElement('video');
    video.style.cssText = 'display: block; width: 320px; height: 180px';
    parent.append(video);
    return video;
  }

  // 문서에 붙이고, 시험이 끝나면 지운다.
  function intoDocument(host: HTMLElement) {
    document.body.append(host);
    added.push(host);
  }

  const indicatorCount = () => document.querySelectorAll(hostTagName).length;

  const box = (element: Element) => {
    const { left, top, width, height } = element.getBoundingClientRect();
    return { left, top, width, height };
  };

  // 영상마다 그 영상이 그려진 상자와 같은 자리·크기의 표시창 틀이 하나씩 있다.
  function expectIndicatorsOn(videos: readonly HTMLVideoElement[]) {
    const hosts = [...document.querySelectorAll(hostTagName)].map(box);
    expect(hosts).toHaveLength(videos.length);
    for (const video of videos) expect(hosts).toContainEqual(box(video));
  }

  it('처음부터 열린 shadow root 안에 있는 영상(겹친 root 안 포함)에 띄우고, 배속이 바뀌면 바꾼다', async () => {
    const outer = playerHost();
    intoDocument(outer.host);
    const first = videoInto(outer.root);
    const inner = playerHost();
    outer.root.append(inner.host);
    const second = videoInto(inner.root);
    start(enabled);
    await frames();
    expectIndicatorsOn([first, second]);
    second.playbackRate = 2;
    await vi.waitFor(() => {
      expect(labels().sort()).toEqual(['1×', '2×']);
    });
  });

  it('나중에 생긴 영상에도 띄운다: 있던 root 안에 더해짐, 영상이 든 root를 가진 요소가 문서나 root 안에 더해짐', async () => {
    const known = playerHost();
    intoDocument(known.host);
    start(enabled);
    const a = videoInto(known.root);
    await vi.waitFor(() => {
      expect(indicatorCount()).toBe(1);
    });
    // 영상이 든 root와, 그 안에 겹친 root와 영상을 가진 요소가 문서에 더해진다.
    const outer = playerHost();
    const b = videoInto(outer.root);
    const nested = playerHost();
    const c = videoInto(nested.root);
    outer.root.append(nested.host);
    intoDocument(outer.host);
    await vi.waitFor(() => {
      expect(indicatorCount()).toBe(3);
    });
    // 영상이 든 root를 가진 요소가 있던 root 안에 더해진다.
    const later = playerHost();
    const d = videoInto(later.root);
    known.root.append(later.host);
    await vi.waitFor(() => {
      expect(indicatorCount()).toBe(4);
    });
    // 나중에 찾은 겹친 root 안에 더해진 영상도 본다.
    const e = videoInto(nested.root);
    await vi.waitFor(() => {
      expect(indicatorCount()).toBe(5);
    });
    await frames();
    expectIndicatorsOn([a, b, c, d, e]);
  });

  it('제거 뒤 정리: root 안에서 지운 영상과 지운 요소의 root 안 영상(겹친 것 포함)의 표시창을 지우고, 다시 넣으면 다시 띄운다', async () => {
    const outer = playerHost();
    intoDocument(outer.host);
    const first = videoInto(outer.root);
    const nested = playerHost();
    outer.root.append(nested.host);
    const second = videoInto(nested.root);
    start(enabled);
    expect(indicatorCount()).toBe(2);
    first.remove();
    await vi.waitFor(() => {
      expect(indicatorCount()).toBe(1);
    });
    outer.host.remove();
    await vi.waitFor(() => {
      expect(indicatorCount()).toBe(0);
    });
    // 문서에서 떼어 둔 동안 root 안에 더해진 영상에는 띄우지 않는다.
    const whileDetached = videoInto(nested.root);
    await frames();
    expect(indicatorCount()).toBe(0);
    // 다시 넣으면 그 안의 영상에 다시 띄우고, 그 뒤의 바뀜도 본다.
    document.body.append(outer.host);
    await vi.waitFor(() => {
      expect(indicatorCount()).toBe(2);
    });
    const third = videoInto(outer.root);
    await vi.waitFor(() => {
      expect(indicatorCount()).toBe(3);
    });
    await frames();
    expectIndicatorsOn([second, whileDetached, third]);
  });

  it('영상이 문서에서 shadow root 안으로 옮겨져도 표시창은 하나이고 그 영상을 따라간다', async () => {
    const { host, root } = playerHost();
    intoDocument(host);
    const video = addVideo(320, 180);
    start(enabled);
    root.prepend(document.createElement('div'), video);
    await frames();
    expectIndicatorsOn([video]);
  });

  it('닫힌 shadow root 안의 영상에는 띄우지 않는다(지원 범위, 결정 0019)', async () => {
    const { host, root } = playerHost('closed');
    intoDocument(host);
    videoInto(root);
    start(enabled);
    await frames();
    expect(indicatorCount()).toBe(0);
  });

  it('quality 078 시작한 뒤에는 바뀐 부분(더해진 요소와 그 안의 shadow root)만 훑고 문서 전체를 다시 훑지 않는다', async () => {
    // 무엇을 훑었는지는 밖에서 보이지 않아 훑는 도구(TreeWalker)를 만든 시작점을 본다.
    const walk = vi.spyOn(Document.prototype, 'createTreeWalker');
    const known = playerHost();
    intoDocument(known.host);
    start(enabled);
    walk.mockClear();
    const outer = playerHost();
    videoInto(outer.root);
    intoDocument(outer.host);
    videoInto(known.root);
    await vi.waitFor(() => {
      expect(indicatorCount()).toBe(2);
    });
    outer.host.remove();
    await vi.waitFor(() => {
      expect(indicatorCount()).toBe(1);
    });
    const starts = walk.mock.calls.map(([root]) => root);
    expect(starts).not.toContain(document);
    expect(starts).not.toContain(document.documentElement);
    expect(starts).not.toContain(document.body);
    expect(starts).toEqual(expect.arrayContaining([outer.host, outer.root]));
  });
});

describe('quality 010 배속 표시창의 콜백이 실패할 때(결정 0014)', () => {
  // 실행 틀에 배속 표시창과 다른 기능 하나를 올린다. 다른 기능은 문서의 ping 이벤트를 센다.
  const connected = { value: true };
  let pings = 0;
  const other: PagePart = {
    featureId: 'other',
    frames: 'all',
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
      topFrame: true,
      subscribe: (next) => {
        handlers = next;
        return () => undefined;
      },
      report: (problem) => {
        reports.push(problem);
        return Promise.resolve(ok(null));
      },
      isConnected: () => connected.value,
      listenNotices: () => () => undefined,
      listenStatus: () => () => undefined,
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
});
