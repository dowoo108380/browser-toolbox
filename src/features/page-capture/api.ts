import { v } from '../../contracts/index.ts';
import type { Measure, Measured, Picked, Plan } from './core/capture.ts';
import type { Point, Rect, Size } from './core/geometry.ts';

// 서비스 워커 쪽(background.ts)이 페이지 쪽(inject.ts)에 부르는 일(결정 0046). 페이지 쪽은 누를 때 넣은 스크립트가 확장의
// 격리된 세계의 전역에 이 이름들의 일을 두고, 서비스 워커 쪽은 platform의 callInjected로 부른 답을 아래 스키마로 검증한다(웹
// 페이지의 세계와 나뉜 곳이지만 페이지의 DOM에서 잰 값이다, quality 064).

// 늦게 불러오는 이미지를 기다리는 한도(기대 동작 3). 2026-10-21 실험: 화면 밖의 지연 로딩 이미지 60개(하나에 0.3초, 동시 6개)가
// 늘렸다 되돌린 뒤 3.1초에 다 실렸다.
export const imageWaitMs = 5000;

// 영역을 고르기를 기다리는 한도(기대 동작 5).
export const selectionLimitMs = 120_000;

// 찍은 뒤 같은 문서에서 주소만 다르면 그 주소가 견주는 주소로 돌아오기를 기다리는 한도(기대 동작 10, 사용자 2026-10-22). 스크롤에
// 맞춰 주소를 바꾸는 페이지는 되돌린 스크롤에 맞춰 화면을 한 번 그릴 때 돌려놓았다(2026-10-22 실험).
export const addressWaitMs = 1000;

export interface PageApi {
  // 영역을 고른다. 고르는 화면은 끝나면 지우고, 화면을 두 번 그린 뒤 답한다(찍을 때 남지 않게).
  readonly select: () => Promise<Picked>;
  // 전체 캡처의 대상을 고르고, 지금 스크롤을 기억한다. 문서를 찍으면 맨 위로 옮긴다.
  readonly prepare: () => Plan;
  // 화면을 두 번 그리기를 기다린다(숨은 문서에서도 끝나게 시간 한도가 있다).
  readonly settle: () => Promise<null>;
  // rect(없으면 문서 전체)에 그려질 이미지를 다 불러오기를 limitMs까지 기다리고, 그때 아직 불러오는 수를 준다.
  readonly waitImages: (
    rect: Rect | null,
    limitMs: number,
  ) => Promise<{ readonly pending: number }>;
  readonly measure: (what: Measured) => Measure;
  // 문서를 그 스크롤 자리로 옮긴다. 옮기기 전의 자리를 기억한다.
  readonly position: (point: Point) => null;
  // 바꾼 것(스크롤, 상자의 스크롤, 고르는 화면)을 되돌린다. 바꾼 것이 없으면 할 일이 없다.
  readonly restore: () => null;
  // 아무것도 하지 않는다. 지금 그 탭의 최상위에 있는 문서(답과 함께 오는 문서 id와 주소)를 알려고 부른다.
  readonly ping: () => null;
  // 이 문서의 주소가 href(# 뒤는 보지 않는다)가 되기를 limitMs까지 기다린다. 이미 같으면 곧 답한다. 답과 함께 그때의 주소가 온다.
  readonly awaitAddress: (href: string, limitMs: number) => Promise<null>;
}

export type PageMethod = keyof PageApi;

const pointSchema: v.Schema<Point> = v.object({ x: v.number(), y: v.number() });
const sizeSchema: v.Schema<Size> = v.object({ width: v.number(), height: v.number() });
const rectSchema: v.Schema<Rect> = v.object({
  x: v.number(),
  y: v.number(),
  width: v.number(),
  height: v.number(),
});
const dprSchema = v.pipe(v.number(), v.minValue(0.01));

export const answers = {
  select: v.union([
    v.object({
      kind: v.literal('picked'),
      rect: rectSchema,
      view: rectSchema,
      start: pointSchema,
      dpr: dprSchema,
    }),
    v.object({
      kind: v.literal('ended'),
      reason: v.picklist(['escape', 'right-click', 'left', 'timeout', 'error']),
    }),
  ]) satisfies v.Schema<Picked>,
  prepare: v.union([
    v.object({
      target: v.literal('document'),
      rect: rectSchema,
      viewport: sizeSchema,
      dpr: dprSchema,
    }),
    v.object({
      target: v.literal('box'),
      rect: rectSchema,
      overflow: v.number(),
      viewport: sizeSchema,
      dpr: dprSchema,
    }),
    v.object({ target: v.literal('viewport') }),
  ]) satisfies v.Schema<Plan>,
  measure: v.object({
    rect: rectSchema,
    overflow: v.number(),
    viewport: sizeSchema,
    dpr: dprSchema,
  }) satisfies v.Schema<Measure>,
  done: v.null(),
  waited: v.object({ pending: v.number() }),
};
