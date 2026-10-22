import { describe, expect, it } from 'vitest';
import { type AppError, appError } from '../../../shared/index.ts';
import {
  type CaptureEffect,
  type CaptureEvent,
  type CaptureState,
  type Ending,
  type Measure,
  type Measured,
  type Mode,
  type PageRef,
  type Picked,
  type Plan,
  initialCapture,
  maxExpansions,
  samePage,
  transition,
} from './capture.ts';
import type { Rect } from './geometry.ts';

// 캡처의 상태 기계(quality 062, 결정 0020, 0048). 할 일에 정한 답을 차례로 주는 모의 실행으로 단계의 차례를 보고, 실패·멈춤·끊김에서
// 붙잡은 것을 되돌리는 차례를 본다. 찍은 그림은 그 조각의 y를 담은 글로 넘긴다.

type State = CaptureState<string, string>;
type Event = CaptureEvent<string, string>;
type Effect = CaptureEffect<string, string>;

const page: PageRef = { documentId: 'doc-1', href: 'https://example.test/a' };
const viewport = { width: 1000, height: 700 };

const documentPlan: Plan = {
  target: 'document',
  rect: { x: 0, y: 0, width: 1000, height: 5000 },
  viewport,
  dpr: 1,
};

const boxRect: Rect = { x: 260, y: 60, width: 740, height: 640 };
const boxPlan: Plan = { target: 'box', rect: boxRect, overflow: 9000, viewport, dpr: 1 };

const measureOf = (what: Measured): Measure => {
  switch (what) {
    case 'document':
      return { rect: { x: 0, y: 0, width: 1000, height: 5000 }, overflow: 0, viewport, dpr: 1 };
    case 'box':
      return {
        rect: { ...boxRect, height: 9640 },
        overflow: 0,
        viewport: { ...viewport, height: 9700 },
        dpr: 1,
      };
    case 'viewport':
      return { rect: { x: 0, y: 300, width: 985, height: 700 }, overflow: 0, viewport, dpr: 1 };
  }
};

const inView: Extract<Picked, { kind: 'picked' }> = {
  kind: 'picked',
  rect: { x: 100, y: 400, width: 200, height: 100 },
  view: { x: 0, y: 300, width: 1000, height: 700 },
  start: { x: 0, y: 300 },
  dpr: 2,
};

const beyond: Extract<Picked, { kind: 'picked' }> = {
  kind: 'picked',
  rect: { x: 100, y: 400, width: 200, height: 3000 },
  view: { x: 0, y: 2800, width: 1000, height: 700 },
  start: { x: 0, y: 200 },
  dpr: 1,
};

interface Script {
  readonly plan?: Plan;
  readonly picked?: Picked;
  readonly measure?: (what: Measured, count: number) => Measure;
  readonly verified?: PageRef;
  readonly copied?: boolean;
  readonly size?: { width: number; height: number };
  // 그 할 일에서 답하지 않고 멈춘다(그 뒤의 사건은 시험이 넣는다).
  readonly holdAt?: Effect['type'];
  // 그 할 일들은 실패로 답한다. 그 실패(없으면 platform)다.
  readonly failAt?: readonly Effect['type'][];
  readonly failWith?: AppError;
}

const failure: AppError = appError('platform', '실패');
// 그 문서가 사라졌거나 넣은 스크립트가 없다(platform의 callInjected).
const gone: AppError = appError('unavailable', '페이지가 바뀌었다.');

// 할 일에 답을 주며 끝까지 돌린다. 내보낸 할 일과 끝, 마지막 상태를 돌려준다.
function drive(mode: Mode, script: Script = {}) {
  const effects: Effect[] = [];
  let state: State = initialCapture;
  let ending: Ending | null = null;
  let held: Effect | null = null;
  const counts = new Map<Measured, number>();
  const queue: Event[] = [];
  const answer = (effect: Effect): Event | null => {
    if (effect.type === 'release') return null;
    if (effect.type === 'finish') {
      ending = effect.ending;
      return null;
    }
    if (script.holdAt === effect.type && held === null) {
      held = effect;
      return null;
    }
    const { step } = effect;
    if (script.failAt?.includes(effect.type) === true) {
      return { type: 'failed', step, error: script.failWith ?? failure };
    }
    switch (effect.type) {
      case 'inject':
        return { type: 'injected', step };
      case 'select':
        return { type: 'picked', step, page, picked: script.picked ?? inView };
      case 'attach':
        return { type: 'attached', step };
      case 'prepare':
        return { type: 'prepared', step, page, plan: script.plan ?? documentPlan };
      case 'expand':
        return { type: 'expanded', step };
      case 'settle':
        return { type: 'settled', step };
      case 'shrink':
        return { type: 'shrunk', step };
      case 'waitImages':
        return { type: 'waited', step };
      case 'measure': {
        const count = (counts.get(effect.what) ?? 0) + 1;
        counts.set(effect.what, count);
        return {
          type: 'measured',
          step,
          measure: (script.measure ?? measureOf)(effect.what, count),
        };
      }
      case 'position':
        return { type: 'positioned', step };
      case 'shoot':
        return { type: 'shot', step, data: `tile:${String(effect.clip.y)}` };
      case 'shootVisible':
        return { type: 'shot', step, data: 'visible' };
      case 'restore':
        return { type: 'restored', step };
      case 'verify':
        return { type: 'verified', step, page: script.verified ?? page };
      case 'compose':
        return {
          type: 'composed',
          step,
          image: 'image',
          size: script.size ?? { width: 1000, height: 5000 },
        };
      case 'save':
        return { type: 'saved', step, name: 'a.png' };
      case 'copy':
        return { type: 'copied', step, copied: script.copied ?? true };
    }
  };
  const dispatch = (event: Event) => {
    queue.push(event);
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const step = transition(state, next);
      state = step.state;
      for (const effect of step.effects) {
        effects.push(effect);
        const reply = answer(effect);
        if (reply !== null) queue.push(reply);
      }
    }
  };
  dispatch({ type: 'start', mode });
  return {
    effects,
    types: () => effects.map((effect) => effect.type),
    ending: () => ending,
    state: () => state,
    held: () => held,
    dispatch,
  };
}

describe('전체 캡처의 차례', () => {
  it('PAGE-1.1 PAGE-1.10 문서: 넣기, 붙이기, 대상, 화면을 문서 높이로 늘렸다 되돌려 지연 로딩을 부르고 기다림, 다시 재고 조각마다 화면 밖까지 찍기, 되돌리기, 확인, 잇기, 저장, 복사, 떼기', () => {
    const run = drive('full');
    expect(run.types()).toEqual([
      'inject',
      'attach',
      'prepare',
      'expand',
      'settle',
      'shrink',
      'waitImages',
      'measure',
      'shoot',
      'restore',
      'verify',
      'compose',
      'save',
      'copy',
      'release',
      'finish',
    ]);
    expect(run.effects).toContainEqual(expect.objectContaining({ type: 'expand', height: 5000 }));
    expect(run.effects).toContainEqual(expect.objectContaining({ type: 'waitImages', rect: null }));
    expect(run.effects).toContainEqual(
      expect.objectContaining({ type: 'measure', what: 'document' }),
    );
    expect(run.effects).toContainEqual(
      expect.objectContaining({
        type: 'shoot',
        clip: { x: 0, y: 0, width: 1000, height: 5000 },
        beyond: true,
      }),
    );
    expect(run.effects).toContainEqual(
      expect.objectContaining({
        type: 'compose',
        target: { x: 0, y: 0, width: 1000, height: 5000 },
        dpr: 1,
        shots: [{ rect: { x: 0, y: 0, width: 1000, height: 5000 }, data: 'tile:0' }],
      }),
    );
    expect(run.ending()).toEqual({
      ok: true,
      name: 'a.png',
      size: { width: 1000, height: 5000 },
      copy: 'copied',
      partial: null,
    });
    expect(run.state()).toEqual({ phase: 'finished' });
  });

  it('화면에 다 들어가는 문서는 늘리지 않고 곧 기다린다', () => {
    const run = drive('full', {
      plan: { ...documentPlan, rect: { x: 0, y: 0, width: 1000, height: 700 } },
    });
    expect(run.types().slice(2, 5)).toEqual(['prepare', 'waitImages', 'measure']);
  });

  it('긴 문서는 조각을 위에서 아래로 차례로 찍고 모두 잇는다', () => {
    const run = drive('full', {
      plan: { ...documentPlan, rect: { x: 0, y: 0, width: 1000, height: 40_000 } },
      measure: () => ({
        rect: { x: 0, y: 0, width: 1000, height: 40_000 },
        overflow: 0,
        viewport,
        dpr: 1,
      }),
    });
    const shoots = run.effects.filter((effect) => effect.type === 'shoot');
    expect(shoots.length).toBe(3);
    const compose = run.effects.find((effect) => effect.type === 'compose');
    expect(compose?.type === 'compose' ? compose.shots.map((shot) => shot.data) : []).toEqual(
      shoots.map((effect) => `tile:${String(effect.clip.y)}`),
    );
  });

  it('PAGE-1.12 안쪽 상자: 화면을 넘친 만큼 늘려 펼치고, 펼쳐졌으면 상자 안의 이미지를 기다려 다시 잰 뒤 늘린 화면 안에서 찍고, 화면 높이를 먼저 되돌린 뒤 스크롤을 되돌린다', () => {
    const run = drive('full', { plan: boxPlan });
    expect(run.types()).toEqual([
      'inject',
      'attach',
      'prepare',
      'expand',
      'settle',
      'measure',
      'waitImages',
      'measure',
      'shoot',
      'shrink',
      'restore',
      'verify',
      'compose',
      'save',
      'copy',
      'release',
      'finish',
    ]);
    expect(run.effects).toContainEqual(expect.objectContaining({ type: 'expand', height: 9700 }));
    expect(run.effects).toContainEqual(
      expect.objectContaining({ type: 'waitImages', rect: { ...boxRect, height: 9640 } }),
    );
    expect(run.effects).toContainEqual(
      expect.objectContaining({ type: 'shoot', clip: { ...boxRect, height: 9640 }, beyond: false }),
    );
    expect(run.ending()).toMatchObject({ ok: true, partial: null });
  });

  it('상자가 기다린 사이에 길어지면 다시 늘린다', () => {
    const run = drive('full', {
      plan: boxPlan,
      measure: (what, count) =>
        what === 'box' && count === 2 ? { ...measureOf('box'), overflow: 500 } : measureOf(what),
    });
    expect(run.types().slice(5, 12)).toEqual([
      'measure',
      'waitImages',
      'measure',
      'expand',
      'settle',
      'measure',
      'shoot',
    ]);
    expect(run.effects.filter((effect) => effect.type === 'expand')).toEqual([
      expect.objectContaining({ height: 9700 }),
      expect.objectContaining({ height: 10_200 }),
    ]);
    // 기다린 뒤 다시 늘렸으면 또 기다리지 않는다.
    expect(run.effects.filter((effect) => effect.type === 'waitImages')).toHaveLength(1);
  });

  it(`PAGE-1.13 늘려도 상자가 펼쳐지지 않으면 ${String(maxExpansions)}번까지 늘린 뒤 화면 높이를 되돌리고 보이는 화면을 찍는다`, () => {
    const run = drive('full', {
      plan: boxPlan,
      measure: (what) =>
        what === 'box' ? { ...measureOf('box'), overflow: 9000 } : measureOf(what),
    });
    expect(run.effects.filter((effect) => effect.type === 'expand')).toHaveLength(maxExpansions);
    const tail = run.types().slice(run.types().lastIndexOf('measure') - 1);
    expect(tail).toEqual([
      'shrink',
      'measure',
      'shoot',
      'restore',
      'verify',
      'compose',
      'save',
      'copy',
      'release',
      'finish',
    ]);
    expect(run.effects).toContainEqual(
      expect.objectContaining({ type: 'measure', what: 'viewport' }),
    );
    expect(run.effects).toContainEqual(
      expect.objectContaining({ type: 'shoot', clip: measureOf('viewport').rect, beyond: false }),
    );
    expect(run.ending()).toMatchObject({ ok: true, partial: 'box-stuck' });
  });

  it('PAGE-1.13 화면 대부분인 상자가 없으면 보이는 화면을 재어 찍고 그 까닭을 남긴다', () => {
    const run = drive('full', { plan: { target: 'viewport' } });
    expect(run.types()).toEqual([
      'inject',
      'attach',
      'prepare',
      'measure',
      'shoot',
      'restore',
      'verify',
      'compose',
      'save',
      'copy',
      'release',
      'finish',
    ]);
    expect(run.ending()).toMatchObject({ ok: true, partial: 'no-box' });
  });
});

describe('영역 캡처의 차례', () => {
  it('PAGE-1.14 보이는 화면 안이면 디버거 없이 보이는 화면을 찍어 고른 영역만 잇는다', () => {
    const run = drive('area');
    expect(run.types()).toEqual([
      'inject',
      'select',
      'shootVisible',
      'verify',
      'compose',
      'save',
      'copy',
      'finish',
    ]);
    expect(run.effects).toContainEqual(
      expect.objectContaining({
        type: 'compose',
        target: inView.rect,
        dpr: 2,
        shots: [{ rect: inView.view, data: 'visible' }],
      }),
    );
  });

  it('PAGE-1.15 보이는 화면보다 크면 디버거를 붙이고 끌기 시작한 스크롤 자리로 옮겨 그 영역의 이미지를 기다린 뒤 화면 밖까지 찍고, 놓은 자리로 되돌린다', () => {
    const run = drive('area', { picked: beyond });
    expect(run.types()).toEqual([
      'inject',
      'select',
      'attach',
      'position',
      'waitImages',
      'shoot',
      'restore',
      'verify',
      'compose',
      'save',
      'copy',
      'release',
      'finish',
    ]);
    expect(run.effects).toContainEqual(
      expect.objectContaining({ type: 'position', point: { x: 0, y: 200 } }),
    );
    const { rect } = beyond;
    expect(run.effects).toContainEqual(expect.objectContaining({ type: 'waitImages', rect }));
    expect(run.effects).toContainEqual(
      expect.objectContaining({ type: 'shoot', clip: rect, beyond: true }),
    );
  });

  it.each(['escape', 'right-click', 'left', 'timeout', 'error'] as const)(
    'PAGE-1.6 PAGE-1.16 고르기를 끝내면(%s) 고르는 화면은 페이지 쪽이 이미 지웠으므로 더 하지 않고 끝낸다',
    (reason) => {
      const run = drive('area', { picked: { kind: 'ended', reason } });
      expect(run.types()).toEqual(['inject', 'select', 'finish']);
      expect(run.ending()).toEqual({ ok: false, failure: { kind: 'ended', reason } });
    },
  );

  it('PAGE-1.5 고르기를 기다리는 동안 그 문서가 사라지거나 넣은 스크립트가 없어지면(unavailable) 페이지를 떠난 것으로 취소하고, 사라진 고르는 화면을 되돌리지 않는다', () => {
    const run = drive('area', { failAt: ['select'], failWith: gone });
    expect(run.types()).toEqual(['inject', 'select', 'finish']);
    expect(run.ending()).toEqual({ ok: false, failure: { kind: 'ended', reason: 'left' } });
  });

  it('PAGE-1.5 찍는 단계에서 문서가 사라지면(unavailable) 떠남이 아니라 그 실패로 끝내고 붙잡은 것을 되돌린다', () => {
    const run = drive('area', { picked: beyond, failAt: ['waitImages'], failWith: gone });
    expect(run.types().slice(-3)).toEqual(['restore', 'release', 'finish']);
    expect(run.ending()).toEqual({ ok: false, failure: { kind: 'error', error: gone } });
  });

  it('고르기를 기다리다 그 밖의 까닭으로 실패하면 떠남이 아니라 그 실패로 끝내고 고르는 화면을 되돌린다', () => {
    const run = drive('area', { failAt: ['select'] });
    expect(run.types()).toEqual(['inject', 'select', 'restore', 'finish']);
    expect(run.ending()).toEqual({ ok: false, failure: { kind: 'error', error: failure } });
  });

  it('PAGE-1.4 고른 영역이 한도보다 크면 찍지 않는다', () => {
    const huge: Picked = { ...beyond, rect: { x: 0, y: 0, width: 1000, height: 70_000 } };
    const run = drive('area', { picked: huge });
    expect(run.types()).toEqual(['inject', 'select', 'finish']);
    expect(run.ending()).toEqual({
      ok: false,
      failure: { kind: 'too-large', size: { width: 1000, height: 70_000 } },
    });
  });
});

describe('저장과 복사의 끝', () => {
  it('PAGE-1.21 복사 한도보다 큰 그림은 복사하지 않고 그 까닭을 남긴다', () => {
    const run = drive('full', { size: { width: 5000, height: 10_001 } });
    expect(run.types().slice(-3)).toEqual(['save', 'release', 'finish']);
    expect(run.ending()).toMatchObject({ ok: true, copy: 'too-big' });
  });

  it('복사하지 못해도 저장한 것으로 끝내고 그 까닭을 남긴다', () => {
    expect(drive('full', { copied: false }).ending()).toMatchObject({ ok: true, copy: 'failed' });
  });

  it('PAGE-1.5 찍기 전과 찍은 뒤의 문서가 다르면 저장도 복사도 하지 않는다', () => {
    const otherDocument = drive('full', { verified: { ...page, documentId: 'doc-2' } });
    expect(otherDocument.types().slice(-4)).toEqual(['restore', 'verify', 'release', 'finish']);
    expect(otherDocument.ending()).toEqual({ ok: false, failure: { kind: 'page-changed' } });
    const otherAddress = drive('area', { verified: { ...page, href: 'https://example.test/b' } });
    expect(otherAddress.types().slice(-2)).toEqual(['verify', 'finish']);
    expect(otherAddress.ending()).toEqual({ ok: false, failure: { kind: 'page-changed' } });
  });

  it('PAGE-1.4 다시 잰 문서가 한도보다 크면(기다리는 사이에 길어짐) 찍지 않고 되돌린다', () => {
    const run = drive('full', {
      measure: () => ({
        rect: { x: 0, y: 0, width: 1000, height: 70_000 },
        overflow: 0,
        viewport,
        dpr: 1,
      }),
    });
    expect(run.types().slice(-3)).toEqual(['restore', 'release', 'finish']);
    expect(run.ending()).toMatchObject({ ok: false, failure: { kind: 'too-large' } });
  });

  it('PAGE-1.4 처음 고른 대상이 한도보다 크면 늘리지도 기다리지도 않고 되돌린다', () => {
    const tall = drive('full', {
      plan: { ...documentPlan, rect: { x: 0, y: 0, width: 1000, height: 60_000 }, dpr: 1.25 },
    });
    expect(tall.types()).toEqual(['inject', 'attach', 'prepare', 'restore', 'release', 'finish']);
    expect(tall.ending()).toEqual({
      ok: false,
      failure: { kind: 'too-large', size: { width: 1250, height: 75_000 } },
    });
    const box = drive('full', { plan: { ...boxPlan, overflow: 70_000 } });
    expect(box.types()).toEqual(['inject', 'attach', 'prepare', 'restore', 'release', 'finish']);
  });

  it('상자가 기다린 뒤 한도를 넘게 길어졌으면 화면 높이와 스크롤을 되돌리고 끝낸다', () => {
    const run = drive('full', {
      plan: boxPlan,
      measure: (what, count) =>
        what === 'box' && count === 2
          ? { ...measureOf('box'), rect: { ...boxRect, height: 70_000 } }
          : measureOf(what),
    });
    expect(run.types().slice(-4)).toEqual(['shrink', 'restore', 'release', 'finish']);
    expect(run.ending()).toMatchObject({ ok: false, failure: { kind: 'too-large' } });
  });
});

describe('실패하면 붙잡은 것을 늘린 화면 높이 → 페이지 → 디버거의 차례로 되돌린다', () => {
  it.each([
    ['넣기', 'full', 'inject', ['inject', 'finish']],
    ['붙이기(PAGE-1.7)', 'full', 'attach', ['inject', 'attach', 'release', 'finish']],
    [
      '대상 고르기',
      'full',
      'prepare',
      ['inject', 'attach', 'prepare', 'restore', 'release', 'finish'],
    ],
    [
      '화면 높이 늘리기',
      'full',
      'expand',
      ['inject', 'attach', 'prepare', 'expand', 'shrink', 'restore', 'release', 'finish'],
    ],
    ['영역 고르기', 'area', 'select', ['inject', 'select', 'restore', 'finish']],
    ['보이는 화면 찍기', 'area', 'shootVisible', ['inject', 'select', 'shootVisible', 'finish']],
  ] as const)('%s', (_name, mode, failAt, expected) => {
    const run = drive(mode, { failAt: [failAt] });
    expect(run.types()).toEqual(expected);
    expect(run.ending()).toEqual({ ok: false, failure: { kind: 'error', error: failure } });
  });

  it('찍다가 실패하면 상자의 늘린 화면 높이와 스크롤을 되돌린다', () => {
    const run = drive('full', { plan: boxPlan, failAt: ['shoot'] });
    expect(run.types().slice(-5)).toEqual(['shoot', 'shrink', 'restore', 'release', 'finish']);
  });

  it('저장하지 못하면 복사하지 않고 떼고 끝낸다', () => {
    const run = drive('full', { failAt: ['save'] });
    expect(run.types().slice(-3)).toEqual(['save', 'release', 'finish']);
    expect(run.ending()).toEqual({ ok: false, failure: { kind: 'error', error: failure } });
  });

  it('되돌리기가 실패해도 다음 것을 되돌린다', () => {
    const run = drive('full', { plan: boxPlan, failAt: ['shoot', 'shrink', 'restore'] });
    expect(run.types().slice(-5)).toEqual(['shoot', 'shrink', 'restore', 'release', 'finish']);
    expect(run.ending()).toEqual({ ok: false, failure: { kind: 'error', error: failure } });
  });
});

describe('멈춤 신호와 디버거의 끊김', () => {
  it('멈춤 신호가 오면 그 자리에서 되돌리기를 시작하고, 늦게 온 할 일의 결과와 거듭 온 멈춤은 버린다', () => {
    const run = drive('full', { holdAt: 'waitImages' });
    const held = run.held();
    if (held?.type !== 'waitImages') throw new Error('기다리기에서 멈추지 않았다.');
    run.dispatch({ type: 'abort' });
    expect(run.types().slice(-4)).toEqual(['waitImages', 'restore', 'release', 'finish']);
    const count = run.effects.length;
    run.dispatch({ type: 'waited', step: held.step });
    run.dispatch({ type: 'abort' });
    expect(run.effects).toHaveLength(count);
    expect(run.ending()).toEqual({ ok: false, failure: { kind: 'aborted' } });
  });

  it('화면 높이를 늘린 동안 멈추면 그것부터 되돌린다', () => {
    const run = drive('full', { plan: boxPlan, holdAt: 'settle' });
    run.dispatch({ type: 'abort' });
    expect(run.types().slice(-5)).toEqual(['settle', 'shrink', 'restore', 'release', 'finish']);
  });

  it('영역을 고르는 동안 멈추면 고르는 화면을 지운다(되돌리기)', () => {
    const run = drive('area', { holdAt: 'select' });
    run.dispatch({ type: 'abort' });
    expect(run.types()).toEqual(['inject', 'select', 'restore', 'finish']);
  });

  it('PAGE-1.24 찍는 동안 디버거가 끊기면 Chrome이 화면 높이도 함께 없앴으므로 스크롤만 되돌리고 떼지 않고 끝낸다', () => {
    const run = drive('full', { plan: boxPlan, holdAt: 'shoot' });
    run.dispatch({ type: 'lost', loss: 'cancelled' });
    expect(run.types().slice(-3)).toEqual(['shoot', 'restore', 'finish']);
    expect(run.ending()).toEqual({ ok: false, failure: { kind: 'lost', loss: 'cancelled' } });
  });

  it('화면 높이를 되돌리는 동안 끊기면 기다리지 않고 스크롤을 되돌린다', () => {
    const run = drive('full', { plan: boxPlan, failAt: ['shoot'], holdAt: 'shrink' });
    expect(run.types().slice(-2)).toEqual(['shoot', 'shrink']);
    run.dispatch({ type: 'lost', loss: 'closed' });
    expect(run.types().slice(-3)).toEqual(['shrink', 'restore', 'finish']);
  });

  it('스크롤을 되돌리는 동안 끊기면 붙잡은 것만 놓고 그 되돌리기를 기다린다', () => {
    const run = drive('full', { failAt: ['shoot'], holdAt: 'restore' });
    run.dispatch({ type: 'lost', loss: 'closed' });
    expect(run.types().slice(-2)).toEqual(['shoot', 'restore']);
    const restore = run.held();
    run.dispatch({ type: 'restored', step: restore?.type === 'restore' ? restore.step : 0 });
    // 끊겼으므로 떼지 않는다.
    expect(run.types().slice(-2)).toEqual(['restore', 'finish']);
  });

  it('다 찍고 문서를 확인한 뒤(저장하는 동안) 끊기면 그대로 저장하고 끝낸다(떼지 않는다)', () => {
    const run = drive('full', { holdAt: 'save' });
    run.dispatch({ type: 'lost', loss: 'cancelled' });
    const save = run.effects.at(-1);
    run.dispatch({ type: 'saved', step: save?.type === 'save' ? save.step : 0, name: 'a.png' });
    expect(run.types().slice(-3)).toEqual(['save', 'copy', 'finish']);
    expect(run.ending()).toMatchObject({ ok: true });
  });

  it('디버거를 쓰지 않는 영역 캡처는 끊김을 받지 않는다', () => {
    const run = drive('area', { holdAt: 'shootVisible' });
    run.dispatch({ type: 'lost', loss: 'cancelled' });
    expect(run.types()).toEqual(['inject', 'select', 'shootVisible']);
  });
});

describe('받지 않는 사건', () => {
  it('시작 전에는 시작만 받고, 시작은 한 번이다', () => {
    expect(transition<string, string>(initialCapture, { type: 'abort' })).toEqual({
      state: initialCapture,
      effects: [],
    });
    const run = drive('full', { holdAt: 'inject' });
    run.dispatch({ type: 'start', mode: 'area' });
    expect(run.types()).toEqual(['inject']);
  });

  it('지금 단계와 맞지 않거나 차례가 다른 결과는 버린다', () => {
    const run = drive('full', { holdAt: 'measure' });
    const held = run.held();
    const step = held?.type === 'measure' ? held.step : 0;
    run.dispatch({ type: 'saved', step, name: 'x.png' });
    run.dispatch({ type: 'measured', step: step - 1, measure: measureOf('document') });
    run.dispatch({ type: 'shot', step, data: 'x' });
    run.dispatch({ type: 'prepared', step, page, plan: documentPlan });
    expect(run.types().slice(-1)).toEqual(['measure']);
  });

  it('끝난 뒤의 사건은 버린다', () => {
    const run = drive('full');
    const count = run.effects.length;
    run.dispatch({ type: 'abort' });
    run.dispatch({ type: 'lost', loss: 'cancelled' });
    expect(run.effects).toHaveLength(count);
  });

  it('되돌리는 동안 기다리는 것이 아닌 결과는 버린다', () => {
    const run = drive('full', { plan: boxPlan, failAt: ['settle'], holdAt: 'shrink' });
    const shrink = run.held();
    const step = shrink?.type === 'shrink' ? shrink.step : 0;
    run.dispatch({ type: 'restored', step });
    run.dispatch({ type: 'shrunk', step: step - 1 });
    run.dispatch({ type: 'start', mode: 'full' });
    expect(run.types().slice(-1)).toEqual(['shrink']);
  });
});

describe('차례 번호는 맞는데 기다리는 것이 아닌 결과', () => {
  // 할 일마다 그 결과의 사건.
  const resultOf: Readonly<Partial<Record<Effect['type'], Event['type']>>> = {
    inject: 'injected',
    select: 'picked',
    attach: 'attached',
    prepare: 'prepared',
    expand: 'expanded',
    settle: 'settled',
    shrink: 'shrunk',
    waitImages: 'waited',
    measure: 'measured',
    position: 'positioned',
    shoot: 'shot',
    shootVisible: 'shot',
    restore: 'restored',
    verify: 'verified',
    compose: 'composed',
    save: 'saved',
    copy: 'copied',
  };
  // 그 차례 번호로 올 수 있는 모든 결과(실패는 빼고).
  const everyResult = (step: number): Event[] => [
    { type: 'injected', step },
    { type: 'picked', step, page, picked: inView },
    { type: 'attached', step },
    { type: 'prepared', step, page, plan: documentPlan },
    { type: 'expanded', step },
    { type: 'settled', step },
    { type: 'shrunk', step },
    { type: 'waited', step },
    { type: 'measured', step, measure: measureOf('document') },
    { type: 'positioned', step },
    { type: 'shot', step, data: 'x' },
    { type: 'restored', step },
    { type: 'verified', step, page },
    { type: 'composed', step, image: 'image', size: { width: 10, height: 10 } },
    { type: 'saved', step, name: 'x.png' },
    { type: 'copied', step, copied: true },
  ];
  const viewportPlan: Plan = { target: 'viewport' };
  const cases: readonly [string, Mode, Script][] = [
    ['넣기', 'full', { holdAt: 'inject' }],
    ['고르기', 'area', { holdAt: 'select' }],
    ['붙이기', 'full', { holdAt: 'attach' }],
    ['대상 고르기', 'full', { holdAt: 'prepare' }],
    ['늘리기', 'full', { holdAt: 'expand' }],
    ['두 번 그리기', 'full', { holdAt: 'settle' }],
    ['되돌리기(찍는 중)', 'full', { holdAt: 'shrink' }],
    ['이미지 기다리기', 'full', { holdAt: 'waitImages' }],
    ['문서 재기', 'full', { holdAt: 'measure' }],
    ['상자 재기', 'full', { plan: boxPlan, holdAt: 'measure' }],
    ['보이는 화면 재기', 'full', { plan: viewportPlan, holdAt: 'measure' }],
    ['조각 찍기', 'full', { holdAt: 'shoot' }],
    ['보이는 화면 찍기', 'area', { holdAt: 'shootVisible' }],
    ['영역의 스크롤 옮기기', 'area', { picked: beyond, holdAt: 'position' }],
    ['영역의 이미지 기다리기', 'area', { picked: beyond, holdAt: 'waitImages' }],
    ['페이지 되돌리기(찍은 뒤)', 'full', { holdAt: 'restore' }],
    ['문서 확인', 'full', { holdAt: 'verify' }],
    ['잇기', 'full', { holdAt: 'compose' }],
    ['저장', 'full', { holdAt: 'save' }],
    ['복사', 'full', { holdAt: 'copy' }],
    ['되돌리는 중의 화면 높이', 'full', { plan: boxPlan, failAt: ['shoot'], holdAt: 'shrink' }],
    ['되돌리는 중의 페이지', 'full', { failAt: ['shoot'], holdAt: 'restore' }],
  ];

  it.each(cases)('%s를 기다리는 동안 다른 결과는 버린다', (_name, mode, script) => {
    const run = drive(mode, script);
    const held = run.held();
    if (held === null || !('step' in held)) throw new Error('붙잡은 할 일이 없다.');
    const before = run.state();
    const count = run.effects.length;
    for (const event of everyResult(held.step)) {
      if (event.type !== resultOf[held.type]) run.dispatch(event);
    }
    expect(run.effects).toHaveLength(count);
    expect(run.state()).toEqual(before);
  });
});

describe('찍은 뒤의 끊김과 그 밖의 차례', () => {
  it('잇는 동안 끊기면 그대로 잇고 저장·복사한 뒤 끝낸다(떼지 않는다)', () => {
    const run = drive('full', { holdAt: 'compose' });
    run.dispatch({ type: 'lost', loss: 'closed' });
    const compose = run.held();
    run.dispatch({
      type: 'composed',
      step: compose?.type === 'compose' ? compose.step : 0,
      image: 'image',
      size: { width: 1000, height: 5000 },
    });
    expect(run.types().slice(-4)).toEqual(['compose', 'save', 'copy', 'finish']);
    expect(run.ending()).toMatchObject({ ok: true, copy: 'copied' });
  });

  it('복사하는 동안 끊기면 그대로 복사하고 끝낸다(떼지 않는다)', () => {
    const run = drive('full', { holdAt: 'copy' });
    run.dispatch({ type: 'lost', loss: 'cancelled' });
    const copy = run.held();
    run.dispatch({ type: 'copied', step: copy?.type === 'copy' ? copy.step : 0, copied: true });
    expect(run.types().slice(-2)).toEqual(['copy', 'finish']);
    expect(run.ending()).toMatchObject({ ok: true, copy: 'copied' });
  });

  it('끝난 뒤에 다시 시작하라는 사건도 버린다', () => {
    const run = drive('full');
    const count = run.effects.length;
    run.dispatch({ type: 'start', mode: 'full' });
    expect(run.effects).toHaveLength(count);
  });

  it('영역의 스크롤을 옮기는 할 일을 내면 페이지를 붙잡은 것으로 쳐, 그 사이에 멈추면 페이지를 되돌린다', () => {
    const run = drive('area', { picked: beyond, holdAt: 'position' });
    run.dispatch({ type: 'abort' });
    expect(run.types().slice(-4)).toEqual(['position', 'restore', 'release', 'finish']);
  });

  it('PAGE-1.4 펼친 상자가 이미지를 기다린 뒤 한도보다 커졌으면 찍지 않고 그 크기로 끝낸다', () => {
    const tall = { ...boxRect, height: 70_000 };
    const run = drive('full', {
      plan: boxPlan,
      measure: (what, count) =>
        what === 'box' && count === 2
          ? { rect: tall, overflow: 0, viewport: { ...viewport, height: 70_060 }, dpr: 1 }
          : measureOf(what),
    });
    expect(run.types()).not.toContain('shoot');
    expect(run.ending()).toEqual({
      ok: false,
      failure: { kind: 'too-large', size: { width: tall.width, height: tall.height } },
    });
  });

  it('PAGE-1.4 상자의 내용(보이는 높이와 넘친 높이)이 처음부터 한도보다 크면 늘리지 않고 그 크기로 끝낸다', () => {
    const run = drive('full', { plan: { ...boxPlan, overflow: 80_000 } });
    expect(run.types()).not.toContain('expand');
    expect(run.ending()).toEqual({
      ok: false,
      failure: {
        kind: 'too-large',
        size: { width: boxRect.width, height: boxRect.height + 80_000 },
      },
    });
  });

  it('상자가 1픽셀까지만 넘치면 다 펼친 것으로 본다', () => {
    const run = drive('full', {
      plan: boxPlan,
      measure: (what) => (what === 'box' ? { ...measureOf('box'), overflow: 1 } : measureOf(what)),
    });
    expect(run.types().filter((type) => type === 'expand')).toHaveLength(1);
  });
});

describe('같은 페이지', () => {
  it('문서 id가 같고 주소가 # 뒤만 다르면 같은 페이지다', () => {
    expect(samePage(page, { ...page, href: `${page.href}#part` })).toBe(true);
    expect(samePage({ ...page, href: '#a' }, { ...page, href: '#b' })).toBe(true);
    expect(samePage({ ...page, href: `${page.href}#a` }, { ...page, href: `${page.href}#b` })).toBe(
      true,
    );
    expect(samePage(page, { ...page, href: `${page.href}?q=1` })).toBe(false);
    expect(samePage(page, { ...page, documentId: 'doc-2' })).toBe(false);
  });
});
