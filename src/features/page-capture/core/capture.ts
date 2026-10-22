import type { AppError } from '../../../shared/index.ts';
import {
  type Point,
  type Rect,
  type Size,
  copyAllowed,
  deviceSize,
  tilesOf,
  tooLarge,
  within,
} from './geometry.ts';

// 캡처 하나의 상태 기계(quality 062의 "캡처", 결정 0020, 0048). (상태, 사건) → (새 상태, 할 일)인 순수 함수다. 할 일(페이지
// 쪽 스크립트 부르기, 디버거 명령, 찍기, 이어 붙이기, 저장, 복사)은 기능의 서비스 워커 쪽(background.ts)이 하고, 그 결과를 할
// 일의 차례 번호(step)를 실은 사건으로 돌려 넣는다. 지금 기다리는 차례가 아닌 결과는 늦게 온 것이라 버린다.
//
// 상태는 캡처가 붙잡았을 수 있는 것(held)을 든다: 디버거 연결, 늘린 화면 높이(Emulation.setDeviceMetricsOverride), 페이지를
// 바꾼 것(맨 위로 옮긴 스크롤, 상자의 스크롤, 영역을 고르는 화면). 붙잡는 할 일을 내보낼 때 붙잡은 것으로 치고(그 할 일이 도중에
// 멈춰도 되돌리기 위해서다. 되돌리는 할 일은 붙잡지 않은 것을 되돌려도 아무 일이 없다), 되돌리는 할 일이 끝나면 놓는다. 실패,
// 멈춤 신호, 디버거의 끊김이 오면 붙잡은 것을 늘린 화면 높이 → 페이지 → 디버거의 차례로 되돌린 뒤 끝낸다. 화면 높이를 먼저
// 되돌려야 상자의 스크롤을 되돌릴 수 있다(늘린 동안 상자는 스크롤되지 않는다). 쓰는 쪽의 약속(결정 0042)대로 이 캡처가 바꾼
// 세션 상태(화면 높이)만 되돌리고, 다른 쪽(활성 상태 유지)이 바꾼 초점 흉내는 건드리지 않는다.
//
// 큰 데이터(찍은 그림 T, 이어 붙인 그림 I)는 할 일이 만든 값을 넘기기만 한다(결정 0020의 4). 상태 기계는 그 안을 보지 않는다.

export type Mode = 'full' | 'area';

// 찍는 문서(Chrome이 문서마다 붙이는 id와 그 문서의 주소). 찍은 뒤에도 같은 문서이고 주소가 같아야 저장한다(기대 동작 10). 견주는
// 주소는 전체 캡처면 시작한 때(대상을 고른 답), 영역 캡처면 놓은 때(고르기의 답)의 것이다.
export interface PageRef {
  readonly documentId: string;
  readonly href: string;
}

// 페이지 쪽이 고른 전체 캡처의 대상(inject.ts의 prepare). document: 문서 전체(맨 위로 옮겼다). box: 화면 대부분을 차지하는
// 스크롤 상자(rect는 지금 보이는 상자, overflow는 넘친 높이). viewport: 스크롤되는 것이 있는데 화면 대부분인 상자가 없다.
export type Plan =
  | {
      readonly target: 'document';
      readonly rect: Rect;
      readonly viewport: Size;
      readonly dpr: number;
    }
  | {
      readonly target: 'box';
      readonly rect: Rect;
      readonly overflow: number;
      readonly viewport: Size;
      readonly dpr: number;
    }
  | { readonly target: 'viewport' };

// 다시 잰 것(inject.ts의 measure). overflow는 상자가 아직 넘친 높이다(문서와 화면은 0).
export interface Measure {
  readonly rect: Rect;
  readonly overflow: number;
  readonly viewport: Size;
  readonly dpr: number;
}

export type Measured = 'document' | 'box' | 'viewport';

// 보이는 화면만 찍은 까닭(기대 동작 4). no-box: 화면 대부분인 스크롤 상자가 없음, box-stuck: 늘려도 상자가 펼쳐지지 않음.
type PartialReason = 'no-box' | 'box-stuck';

// 영역 고르기를 끝낸 까닭(기대 동작 5). error는 고르는 화면의 일이 던졌거나, 고르기를 끝까지 하지 않고 멈춘 것이다(되돌리기,
// 다시 고르기, 확장의 물러남. inject.ts).
export type SelectionEnd = 'escape' | 'right-click' | 'left' | 'timeout' | 'error';

// 페이지 쪽의 영역 고르기의 끝(inject.ts의 select). rect는 고른 영역, view는 놓은 때의 보이는 화면, start는 끌기 시작한 때의
// 스크롤 자리다(모두 문서 좌표).
export type Picked =
  | {
      readonly kind: 'picked';
      readonly rect: Rect;
      readonly view: Rect;
      readonly start: Point;
      readonly dpr: number;
    }
  | { readonly kind: 'ended'; readonly reason: SelectionEnd };

export interface Shot<T> {
  readonly rect: Rect;
  readonly data: T;
}

type CopyResult = 'copied' | 'too-big' | 'failed';

export type Failure =
  | { readonly kind: 'error'; readonly error: AppError }
  | { readonly kind: 'too-large'; readonly size: Size }
  | { readonly kind: 'page-changed' }
  | { readonly kind: 'ended'; readonly reason: SelectionEnd }
  | { readonly kind: 'lost'; readonly loss: 'cancelled' | 'closed' }
  // 일의 멈춤 신호(제한 시간, 탭 닫힘). 그 까닭은 작업 실행이 알린다.
  | { readonly kind: 'aborted' };

export type Ending =
  | {
      readonly ok: true;
      readonly name: string;
      readonly size: Size;
      readonly copy: CopyResult;
      readonly partial: PartialReason | null;
    }
  | { readonly ok: false; readonly failure: Failure };

export type CaptureEffect<T, I> =
  | { readonly type: 'inject'; readonly step: number }
  | { readonly type: 'select'; readonly step: number }
  | { readonly type: 'attach'; readonly step: number }
  | { readonly type: 'prepare'; readonly step: number }
  // 화면 높이를 height로 늘린다(늘린 동안 화면 높이에 맞춘 배치가 따라 바뀐다).
  | { readonly type: 'expand'; readonly step: number; readonly height: number }
  // 페이지가 화면을 두 번 그리기를 기다린다(늘린 배치가 그려지고 지연 로딩이 이미지를 부른다).
  | { readonly type: 'settle'; readonly step: number }
  | { readonly type: 'shrink'; readonly step: number }
  // rect(없으면 문서 전체)에 그려질 이미지를 다 불러오기를 정한 시간까지 기다린다(기대 동작 3).
  | { readonly type: 'waitImages'; readonly step: number; readonly rect: Rect | null }
  | { readonly type: 'measure'; readonly step: number; readonly what: Measured }
  // 문서를 그 스크롤 자리로 옮긴다(화면보다 큰 영역을 찍기 전, 끌기 시작한 자리).
  | { readonly type: 'position'; readonly step: number; readonly point: Point }
  // 디버거로 clip을 찍는다. beyond이면 보이는 화면 밖까지 찍는다(문서 좌표).
  | { readonly type: 'shoot'; readonly step: number; readonly clip: Rect; readonly beyond: boolean }
  // 디버거 없이 보이는 화면을 찍는다.
  | { readonly type: 'shootVisible'; readonly step: number }
  // 페이지 쪽이 바꾼 것(스크롤, 상자의 스크롤, 고르는 화면)을 되돌린다.
  | { readonly type: 'restore'; readonly step: number }
  // 지금 문서를 묻는다(찍기 전의 문서와 견준다). until이 있으면 그 문서의 주소가 until(# 뒤는 보지 않는다)로 돌아오기를 잠깐
  // 기다린 뒤 묻는다.
  | { readonly type: 'verify'; readonly step: number; readonly until: string | null }
  | {
      readonly type: 'compose';
      readonly step: number;
      readonly target: Rect;
      readonly dpr: number;
      readonly shots: readonly Shot<T>[];
    }
  | { readonly type: 'save'; readonly step: number; readonly image: I }
  | { readonly type: 'copy'; readonly step: number; readonly image: I }
  // 디버거를 그만 쓴다(기다리지 않는다).
  | { readonly type: 'release' }
  | { readonly type: 'finish'; readonly ending: Ending };

export type CaptureEvent<T, I> =
  | { readonly type: 'start'; readonly mode: Mode }
  | { readonly type: 'injected'; readonly step: number }
  | {
      readonly type: 'picked';
      readonly step: number;
      readonly page: PageRef;
      readonly picked: Picked;
    }
  | { readonly type: 'attached'; readonly step: number }
  | {
      readonly type: 'prepared';
      readonly step: number;
      readonly page: PageRef;
      readonly plan: Plan;
    }
  | { readonly type: 'expanded'; readonly step: number }
  | { readonly type: 'settled'; readonly step: number }
  | { readonly type: 'shrunk'; readonly step: number }
  | { readonly type: 'waited'; readonly step: number }
  | { readonly type: 'measured'; readonly step: number; readonly measure: Measure }
  | { readonly type: 'positioned'; readonly step: number }
  | { readonly type: 'shot'; readonly step: number; readonly data: T }
  | { readonly type: 'restored'; readonly step: number }
  | { readonly type: 'verified'; readonly step: number; readonly page: PageRef }
  | { readonly type: 'composed'; readonly step: number; readonly image: I; readonly size: Size }
  | { readonly type: 'saved'; readonly step: number; readonly name: string }
  | { readonly type: 'copied'; readonly step: number; readonly copied: boolean }
  // 그 차례의 할 일이 실패했다.
  | { readonly type: 'failed'; readonly step: number; readonly error: AppError }
  // 일의 멈춤 신호(제한 시간, 탭 닫힘).
  | { readonly type: 'abort' }
  // 디버거 연결이 밖에서 끊겼다(사용자가 안내 막대에서 취소함, 대상이 사라짐).
  | { readonly type: 'lost'; readonly loss: 'cancelled' | 'closed' };

// 상자를 펼치려고 화면 높이를 늘리는 가장 많은 횟수. 늘린 뒤에도 넘치면(이미지가 실려 길어짐 등) 다시 늘린다.
export const maxExpansions = 3;

interface Held {
  readonly debugger: boolean;
  readonly override: boolean;
  readonly page: boolean;
}

const nothingHeld: Held = { debugger: false, override: false, page: false };

// 찍을 것: 결과 그림의 대상과 배율, 남은 조각, 찍은 그림, 보이는 화면만 찍은 까닭.
interface Shooting<T> {
  readonly target: Rect;
  readonly dpr: number;
  readonly beyond: boolean;
  readonly tiles: readonly Rect[];
  readonly shots: readonly Shot<T>[];
  readonly partial: PartialReason | null;
}

// 전체 캡처에서 찍기 전까지의 장면. document: 문서(늘렸다 되돌려 지연 로딩을 부른 뒤 기다림), box: 상자(늘린 채 펼쳐졌는지 보고,
// 기다린 뒤 다시 봄), viewport: 보이는 화면.
type Scene =
  | { readonly kind: 'document' }
  | {
      readonly kind: 'box';
      readonly expansions: number;
      readonly waited: boolean;
    }
  | { readonly kind: 'viewport'; readonly partial: PartialReason }
  // 영역 캡처의 화면보다 큰 영역(옮긴 뒤 기다리고 찍는다).
  | { readonly kind: 'region'; readonly shooting: Shooting<never> };

type RegionScene = Extract<Scene, { readonly kind: 'region' }>;
// 다시 재는 장면(영역은 고를 때 정해 재지 않는다).
type MeasuredScene = Exclude<Scene, RegionScene>;

type Stage<T, I> =
  | { readonly at: 'inject' }
  | { readonly at: 'select' }
  | {
      readonly at: 'attach';
      readonly next: 'prepare' | { readonly start: Point; readonly scene: RegionScene };
    }
  | { readonly at: 'prepare' }
  | { readonly at: 'expand'; readonly scene: Scene }
  | { readonly at: 'settle'; readonly scene: Scene }
  // after: 되돌린 뒤 할 일. wait(문서의 지연 로딩을 부른 뒤), viewport(상자가 펼쳐지지 않음), restore(다 찍음).
  | {
      readonly at: 'shrink';
      readonly after: 'wait' | 'viewport' | { readonly shooting: Shooting<T> };
    }
  | { readonly at: 'wait'; readonly scene: Scene }
  | { readonly at: 'measure'; readonly scene: MeasuredScene }
  | { readonly at: 'position'; readonly scene: RegionScene }
  | { readonly at: 'shoot'; readonly shooting: Shooting<T>; readonly shrinkAfter: boolean }
  | { readonly at: 'shootVisible'; readonly shooting: Shooting<T>; readonly view: Rect }
  | { readonly at: 'restore'; readonly shooting: Shooting<T> }
  // waited: 주소가 돌아오기를 이미 한 번 기다렸다.
  | { readonly at: 'verify'; readonly shooting: Shooting<T>; readonly waited: boolean }
  | { readonly at: 'compose'; readonly size: Size; readonly partial: PartialReason | null }
  | {
      readonly at: 'save';
      readonly image: I;
      readonly size: Size;
      readonly partial: PartialReason | null;
    }
  | {
      readonly at: 'copy';
      readonly name: string;
      readonly size: Size;
      readonly partial: PartialReason | null;
    };

export type CaptureState<T, I> =
  | { readonly phase: 'idle' }
  | {
      readonly phase: 'running';
      readonly mode: Mode;
      // 지금 기다리는 할 일의 차례 번호. 할 일을 내보낼 때마다 하나씩 늘린다.
      readonly step: number;
      readonly held: Held;
      // 찍는 문서. 그 문서를 알기 전(넣기, 붙이기)에는 null이다.
      readonly page: PageRef | null;
      readonly stage: Stage<T, I>;
    }
  // 붙잡은 것을 되돌리는 중. awaiting은 기다리는 되돌리기다.
  | {
      readonly phase: 'cleaning';
      readonly step: number;
      readonly held: Held;
      readonly awaiting: 'shrink' | 'restore';
      readonly ending: Ending;
    }
  | { readonly phase: 'finished' };

export const initialCapture: CaptureState<never, never> = { phase: 'idle' };

interface Step<T, I> {
  readonly state: CaptureState<T, I>;
  readonly effects: readonly CaptureEffect<T, I>[];
}

type Running<T, I> = Extract<CaptureState<T, I>, { readonly phase: 'running' }>;

// 그 상태는 그대로, 할 일은 없다(늦게 온 결과, 끝난 뒤의 사건).
const unchanged = <T, I>(state: CaptureState<T, I>): Step<T, I> => ({ state, effects: [] });

// 주소의 # 뒤는 같은 페이지로 본다(기대 동작 10).
const withoutFragment = (href: string) => {
  const at = href.indexOf('#');
  return at < 0 ? href : href.slice(0, at);
};

// 두 주소가 같은 페이지인지. 페이지 쪽(inject.ts)도 이것으로 주소가 돌아왔는지 본다.
export function sameAddress(before: string, after: string): boolean {
  return withoutFragment(before) === withoutFragment(after);
}

// 다음 할 일을 내보낸다. 차례 번호를 늘리고, 붙잡는 할 일이면 붙잡은 것으로 친다.
function issue<T, I>(
  state: Running<T, I>,
  stage: Stage<T, I>,
  effect: (step: number) => CaptureEffect<T, I>,
  held: Held = state.held,
): Step<T, I> {
  const step = state.step + 1;
  const made = effect(step);
  const holding: Held = {
    debugger: held.debugger || made.type === 'attach',
    override: held.override || made.type === 'expand',
    page:
      held.page || made.type === 'select' || made.type === 'prepare' || made.type === 'position',
  };
  return { state: { ...state, step, held: holding, stage }, effects: [made] };
}

// 붙잡은 것을 차례로 되돌린다: 늘린 화면 높이, 페이지, 디버거. 다 되돌리면 끝낸다.
function cleanup<T, I>(step: number, held: Held, ending: Ending): Step<T, I> {
  const next = step + 1;
  if (held.override) {
    return {
      state: { phase: 'cleaning', step: next, held, awaiting: 'shrink', ending },
      effects: [{ type: 'shrink', step: next }],
    };
  }
  if (held.page) {
    return {
      state: { phase: 'cleaning', step: next, held, awaiting: 'restore', ending },
      effects: [{ type: 'restore', step: next }],
    };
  }
  return finish(held, ending);
}

function finish<T, I>(held: Held, ending: Ending): Step<T, I> {
  const effects: CaptureEffect<T, I>[] = held.debugger ? [{ type: 'release' }] : [];
  effects.push({ type: 'finish', ending });
  return { state: { phase: 'finished' }, effects };
}

const fail = <T, I>(state: Running<T, I>, failure: Failure, held: Held = state.held) =>
  cleanup<T, I>(state.step, held, { ok: false, failure });

// 다음 조각을 찍거나, 다 찍었으면 되돌리기로 간다(상자는 화면 높이를 먼저 되돌린다).
function shootNext<T, I>(
  state: Running<T, I>,
  shooting: Shooting<T>,
  shrinkAfter: boolean,
): Step<T, I> {
  const [tile] = shooting.tiles;
  if (tile !== undefined) {
    return issue(state, { at: 'shoot', shooting, shrinkAfter }, (step) => ({
      type: 'shoot',
      step,
      clip: tile,
      beyond: shooting.beyond,
    }));
  }
  if (shrinkAfter) {
    return issue(state, { at: 'shrink', after: { shooting } }, (step) => ({
      type: 'shrink',
      step,
    }));
  }
  return issue(state, { at: 'restore', shooting }, (step) => ({ type: 'restore', step }));
}

// 찍을 것을 만든다.
function shootingOf<T>(
  target: Rect,
  dpr: number,
  beyond: boolean,
  partial: PartialReason | null,
): Shooting<T> {
  return { target, dpr, beyond, tiles: tilesOf(target, dpr), shots: [], partial };
}

// 전체 캡처의 대상을 받았다.
function planned<T, I>(state: Running<T, I>, plan: Plan): Step<T, I> {
  switch (plan.target) {
    case 'document': {
      const size = deviceSize(plan.rect, plan.dpr);
      if (tooLarge(size)) return fail(state, { kind: 'too-large', size });
      const scene: Scene = { kind: 'document' };
      // 화면에 다 들어가는 문서는 지연 로딩을 부를 것이 없다.
      if (plan.rect.height <= plan.viewport.height) {
        return issue(state, { at: 'wait', scene }, (step) => ({
          type: 'waitImages',
          step,
          rect: null,
        }));
      }
      return issue(state, { at: 'expand', scene }, (step) => ({
        type: 'expand',
        step,
        height: plan.rect.height,
      }));
    }
    case 'box': {
      const size = deviceSize(
        { width: plan.rect.width, height: plan.rect.height + plan.overflow },
        plan.dpr,
      );
      if (tooLarge(size)) return fail(state, { kind: 'too-large', size });
      const scene: Scene = { kind: 'box', expansions: 1, waited: false };
      return issue(state, { at: 'expand', scene }, (step) => ({
        type: 'expand',
        step,
        height: plan.viewport.height + plan.overflow,
      }));
    }
    case 'viewport':
      return issue(
        state,
        { at: 'measure', scene: { kind: 'viewport', partial: 'no-box' } },
        (step) => ({ type: 'measure', step, what: 'viewport' }),
      );
  }
}

// 다시 잰 것을 받았다.
function measured<T, I>(state: Running<T, I>, scene: MeasuredScene, measure: Measure): Step<T, I> {
  const { rect, dpr } = measure;
  switch (scene.kind) {
    case 'document': {
      const size = deviceSize(rect, dpr);
      if (tooLarge(size)) return fail(state, { kind: 'too-large', size });
      return shootNext(state, shootingOf(rect, dpr, true, null), false);
    }
    case 'box': {
      // 아직 넘치면(늘린 만큼 펼쳐지지 않았거나 그 사이에 길어짐) 더 늘린다. 다 늘려도 넘치면 보이는 화면을 찍는다.
      if (measure.overflow > 1) {
        if (scene.expansions >= maxExpansions) {
          return issue(state, { at: 'shrink', after: 'viewport' }, (step) => ({
            type: 'shrink',
            step,
          }));
        }
        const next: Scene = { ...scene, expansions: scene.expansions + 1 };
        return issue(state, { at: 'expand', scene: next }, (step) => ({
          type: 'expand',
          step,
          height: measure.viewport.height + measure.overflow,
        }));
      }
      if (!scene.waited) {
        return issue(state, { at: 'wait', scene: { ...scene, waited: true } }, (step) => ({
          type: 'waitImages',
          step,
          rect,
        }));
      }
      const size = deviceSize(rect, dpr);
      if (tooLarge(size)) return fail(state, { kind: 'too-large', size });
      // 늘린 화면 안에 상자가 다 있으므로 보이는 화면에서 찍는다.
      return shootNext(state, shootingOf(rect, dpr, false, null), true);
    }
    case 'viewport':
      return shootNext(state, shootingOf(rect, dpr, false, scene.partial), false);
  }
}

// 영역 고르기가 끝났다. 고르는 화면은 페이지 쪽이 이미 지웠으므로(문서가 사라졌으면 그 화면도 함께 사라졌다) 되돌리지 않고
// 끝낸다.
function selectionEnded<T, I>(state: Running<T, I>, reason: SelectionEnd): Step<T, I> {
  return finish(state.held, { ok: false, failure: { kind: 'ended', reason } });
}

// 영역을 골랐다.
function picked<T, I>(state: Running<T, I>, page: PageRef, choice: Picked): Step<T, I> {
  if (choice.kind === 'ended') return selectionEnded(state, choice.reason);
  // 고르는 화면은 고르기가 끝나면 페이지 쪽이 지운다.
  const held: Held = { ...state.held, page: false };
  const size = deviceSize(choice.rect, choice.dpr);
  if (tooLarge(size)) return finish(held, { ok: false, failure: { kind: 'too-large', size } });
  const withPage: Running<T, I> = { ...state, held, page };
  if (within(choice.rect, choice.view)) {
    const shooting = shootingOf<T>(choice.rect, choice.dpr, false, null);
    return issue(withPage, { at: 'shootVisible', shooting, view: choice.view }, (step) => ({
      type: 'shootVisible',
      step,
    }));
  }
  const region = shootingOf<never>(choice.rect, choice.dpr, true, null);
  return issue(
    withPage,
    { at: 'attach', next: { start: choice.start, scene: { kind: 'region', shooting: region } } },
    (step) => ({ type: 'attach', step }),
  );
}

// 할 일이 끝났다는 사건을 지금 단계에서 받는다. 단계와 맞지 않는 사건은 버린다(일어나면 안 된다).
function advance<T, I>(state: Running<T, I>, event: CaptureEvent<T, I>): Step<T, I> {
  const { stage } = state;
  switch (event.type) {
    case 'injected':
      if (stage.at !== 'inject') break;
      return state.mode === 'full'
        ? issue(state, { at: 'attach', next: 'prepare' }, (step) => ({ type: 'attach', step }))
        : issue(state, { at: 'select' }, (step) => ({ type: 'select', step }));
    case 'picked':
      if (stage.at !== 'select') break;
      return picked(state, event.page, event.picked);
    case 'attached': {
      if (stage.at !== 'attach') break;
      const { next } = stage;
      if (next === 'prepare') {
        return issue(state, { at: 'prepare' }, (step) => ({ type: 'prepare', step }));
      }
      return issue(state, { at: 'position', scene: next.scene }, (step) => ({
        type: 'position',
        step,
        point: next.start,
      }));
    }
    case 'prepared':
      if (stage.at !== 'prepare') break;
      return planned({ ...state, page: event.page }, event.plan);
    case 'expanded':
      if (stage.at !== 'expand') break;
      return issue(state, { at: 'settle', scene: stage.scene }, (step) => ({
        type: 'settle',
        step,
      }));
    case 'settled':
      if (stage.at !== 'settle') break;
      if (stage.scene.kind === 'box') {
        return issue(state, { at: 'measure', scene: stage.scene }, (step) => ({
          type: 'measure',
          step,
          what: 'box',
        }));
      }
      // 문서는 지연 로딩을 부르기만 하고 화면 높이를 곧 되돌린다(찍을 때는 그대로의 배치다, R-10).
      return issue(state, { at: 'shrink', after: 'wait' }, (step) => ({ type: 'shrink', step }));
    case 'shrunk': {
      if (stage.at !== 'shrink') break;
      const held: Held = { ...state.held, override: false };
      if (stage.after === 'wait') {
        return issue(
          state,
          { at: 'wait', scene: { kind: 'document' } },
          (step) => ({ type: 'waitImages', step, rect: null }),
          held,
        );
      }
      if (stage.after === 'viewport') {
        return issue(
          state,
          { at: 'measure', scene: { kind: 'viewport', partial: 'box-stuck' } },
          (step) => ({ type: 'measure', step, what: 'viewport' }),
          held,
        );
      }
      return shootNext({ ...state, held }, stage.after.shooting, false);
    }
    case 'waited':
      if (stage.at !== 'wait') break;
      switch (stage.scene.kind) {
        case 'document':
          return issue(state, { at: 'measure', scene: stage.scene }, (step) => ({
            type: 'measure',
            step,
            what: 'document',
          }));
        case 'box':
          return issue(state, { at: 'measure', scene: stage.scene }, (step) => ({
            type: 'measure',
            step,
            what: 'box',
          }));
        case 'region':
          return shootNext(state, stage.scene.shooting, false);
        case 'viewport':
          break;
      }
      break;
    case 'measured':
      if (stage.at !== 'measure') break;
      return measured(state, stage.scene, event.measure);
    case 'positioned': {
      if (stage.at !== 'position') break;
      const { scene } = stage;
      return issue(state, { at: 'wait', scene }, (step) => ({
        type: 'waitImages',
        step,
        rect: scene.shooting.target,
      }));
    }
    case 'shot': {
      if (stage.at === 'shootVisible') {
        const shooting: Shooting<T> = {
          ...stage.shooting,
          shots: [{ rect: stage.view, data: event.data }],
        };
        return issue(state, { at: 'verify', shooting, waited: false }, (step) => ({
          type: 'verify',
          step,
          until: null,
        }));
      }
      if (stage.at !== 'shoot') break;
      const [tile, ...rest] = stage.shooting.tiles;
      if (tile === undefined) break;
      const shooting: Shooting<T> = {
        ...stage.shooting,
        tiles: rest,
        shots: [...stage.shooting.shots, { rect: tile, data: event.data }],
      };
      return shootNext(state, shooting, stage.shrinkAfter);
    }
    case 'restored':
      if (stage.at !== 'restore') break;
      return issue(
        state,
        { at: 'verify', shooting: stage.shooting, waited: false },
        (step) => ({ type: 'verify', step, until: null }),
        { ...state.held, page: false },
      );
    case 'verified': {
      if (stage.at !== 'verify') break;
      const before = state.page;
      // 다른 문서가 되었으면 기다리지 않는다(기대 동작 10). 찍기 전의 문서는 늘 안다(대상을 고르거나 영역을 고른 답).
      if (before?.documentId !== event.page.documentId) {
        return fail(state, { kind: 'page-changed' });
      }
      if (!sameAddress(before.href, event.page.href)) {
        // 같은 문서에서 주소만 다르다. 스크롤에 맞춰 주소를 바꾸는 페이지는 찍으려고 옮긴 스크롤에 맞춰 주소를 바꿨다가, 되돌린
        // 스크롤에 맞춰 돌려놓는다(2026-10-22 실험: 되돌린 뒤 화면을 한 번 그릴 때). 견주는 주소로 돌아오기를 한 번 기다리고, 그래도
        // 다르면 페이지가 바뀐 것이다(사용자, 2026-10-22).
        if (stage.waited) return fail(state, { kind: 'page-changed' });
        return issue(state, { ...stage, waited: true }, (step) => ({
          type: 'verify',
          step,
          until: before.href,
        }));
      }
      const { target, dpr, shots, partial } = stage.shooting;
      return issue(state, { at: 'compose', size: deviceSize(target, dpr), partial }, (step) => ({
        type: 'compose',
        step,
        target,
        dpr,
        shots,
      }));
    }
    case 'composed':
      if (stage.at !== 'compose') break;
      return issue(
        state,
        { at: 'save', image: event.image, size: event.size, partial: stage.partial },
        (step) => ({ type: 'save', step, image: event.image }),
      );
    case 'saved': {
      if (stage.at !== 'save') break;
      const done = (copy: CopyResult) =>
        finish<T, I>(state.held, {
          ok: true,
          name: event.name,
          size: stage.size,
          copy,
          partial: stage.partial,
        });
      if (!copyAllowed(stage.size)) return done('too-big');
      return issue(
        state,
        { at: 'copy', name: event.name, size: stage.size, partial: stage.partial },
        (step) => ({ type: 'copy', step, image: stage.image }),
      );
    }
    case 'copied':
      if (stage.at !== 'copy') break;
      return finish(state.held, {
        ok: true,
        name: stage.name,
        size: stage.size,
        copy: event.copied ? 'copied' : 'failed',
        partial: stage.partial,
      });
    case 'failed':
      // 고르기를 기다리는 동안 그 문서가 사라지거나 넣은 스크립트가 없어졌다(unavailable): 사용자가 다른 문서로 떠났다(기대 동작
      // 5). 떠나는 문서는 pagehide에 곧 답하지만(inject.ts), 그 답이 닿기 전에 문서가 사라지면 이 길로 온다. 찍는 단계의
      // unavailable은 찍는 동안 페이지가 바뀐 것이다(기대 동작 10).
      if (stage.at === 'select' && event.error.kind === 'unavailable') {
        return selectionEnded(state, 'left');
      }
      return fail(state, { kind: 'error', error: event.error });
    case 'start':
    case 'abort':
    case 'lost':
      break;
  }
  return unchanged(state);
}

// 되돌리는 중에 받은 사건. 기다리던 되돌리기가 끝나면(실패해도) 다음 것을 한다. 디버거가 끊기면 늘린 화면 높이도 Chrome이
// 함께 없앴으므로 놓는다.
function cleaning<T, I>(
  state: Extract<CaptureState<T, I>, { readonly phase: 'cleaning' }>,
  event: CaptureEvent<T, I>,
): Step<T, I> {
  if (event.type === 'lost') {
    const held: Held = { ...state.held, debugger: false, override: false };
    if (state.awaiting === 'shrink') return cleanup(state.step, held, state.ending);
    return unchanged({ ...state, held });
  }
  if (!('step' in event) || event.step !== state.step) return unchanged(state);
  const awaited =
    (state.awaiting === 'shrink' && event.type === 'shrunk') ||
    (state.awaiting === 'restore' && event.type === 'restored') ||
    event.type === 'failed';
  if (!awaited) return unchanged(state);
  const held: Held =
    state.awaiting === 'shrink'
      ? { ...state.held, override: false }
      : { ...state.held, page: false };
  return cleanup(state.step, held, state.ending);
}

export function transition<T, I>(state: CaptureState<T, I>, event: CaptureEvent<T, I>): Step<T, I> {
  switch (state.phase) {
    case 'finished':
      return unchanged(state);
    case 'idle':
      if (event.type !== 'start') return unchanged(state);
      return issue(
        {
          phase: 'running',
          mode: event.mode,
          step: 0,
          held: nothingHeld,
          page: null,
          stage: { at: 'inject' },
        },
        { at: 'inject' },
        (step) => ({ type: 'inject', step }),
      );
    case 'cleaning':
      return cleaning(state, event);
    case 'running':
      return running(state, event);
  }
}

// 찍는 중에 받은 사건.
function running<T, I>(state: Running<T, I>, event: CaptureEvent<T, I>): Step<T, I> {
  if (event.type === 'abort') return fail(state, { kind: 'aborted' });
  if (event.type === 'lost') {
    if (!state.held.debugger) return unchanged(state);
    const held: Held = { ...state.held, debugger: false, override: false };
    // 다 찍고 문서도 확인한 뒤(이어 붙이기, 저장, 복사)에 끊기면 그대로 마친다. 찍은 그림은 그대로다.
    if (state.stage.at === 'compose' || state.stage.at === 'save' || state.stage.at === 'copy') {
      return unchanged({ ...state, held });
    }
    return fail(state, { kind: 'lost', loss: event.loss }, held);
  }
  if (event.type === 'start' || event.step !== state.step) return unchanged(state);
  return advance(state, event);
}
