import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostTagName } from '../../dom/index.ts';
import type { Snapshot } from '../../storage/index.ts';
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

const enabled: Snapshot = { features: new Map([['media-speed', { enabled: true }]]), sites: {} };
const disabled: Snapshot = { features: new Map(), sites: {} };

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

describe('배속 표시창(05단계 뼈대)', () => {
  it('꺼져 있으면 시작하지 않는다', () => {
    expect(page.start(disabled, { window, document })).toBeNull();
  });

  it('영상마다 지금 배속을 보이고, 배속이 바뀌면 바로 바꾼다(MED-3.1)', async () => {
    const video = addVideo(320, 180);
    const dispose = page.start(enabled, { window, document });
    expect(labels()).toEqual(['1×']);
    video.playbackRate = 1.5;
    await vi.waitFor(() => {
      expect(labels()).toEqual(['1.5×']);
    });
    dispose?.();
  });

  it('나중에 생긴 영상에도 띄우고, 사라진 영상의 표시창은 지운다', async () => {
    const dispose = page.start(enabled, { window, document });
    const video = addVideo(320, 180);
    await vi.waitFor(() => {
      expect(document.querySelectorAll(hostTagName)).toHaveLength(1);
    });
    video.remove();
    await vi.waitFor(() => {
      expect(document.querySelectorAll(hostTagName)).toHaveLength(0);
    });
    dispose?.();
  });

  it('작은 영상(100px 미만)에는 보이지 않는다(MED-3 기대 동작 5)', async () => {
    addVideo(80, 60);
    const dispose = page.start(enabled, { window, document });
    await nextFrame();
    const label = roots[0]?.querySelector<HTMLElement>('.indicator');
    expect(label?.hidden).toBe(true);
    dispose?.();
  });

  it('COM-1.3 끄면 더한 요소가 남지 않는다', () => {
    addVideo(320, 180);
    const before = document.documentElement.outerHTML;
    const dispose = page.start(enabled, { window, document });
    expect(document.querySelectorAll(hostTagName)).toHaveLength(1);
    dispose?.();
    expect(document.documentElement.outerHTML).toBe(before);
  });
});
