import { defineCommand, defineFeature, v } from '../../contracts/index.ts';

// 페이지 활성 상태 유지(TAB-2, 결정 0041). 탭마다 켜고 끄고, 설정의 enabled는 "모든 탭" 스위치다(결정 0043). 설정을 바꾸면
// 설정 형식 버전의 규칙을 따른다(아키텍처 6장).
const settingsSchema = v.object({ enabled: v.boolean() });

export const tabKeepActive = defineFeature({
  id: 'tab-keep-active',
  requirements: ['TAB-2'],
  name: '페이지 활성 상태 유지',
  description:
    '고른 탭을 보고 있지 않아도 보고 있는 탭처럼 둔다. 영상과 강의가 멈추지 않고, 타이머가 느려지지 않고, 자리 비움으로 로그아웃되지 않는다.',
  category: 'tabs',
  kind: 'tab-toggle',
  // 모든 웹 페이지의 모든 프레임. 페이지 쪽 방패(main.ts)도 같은 곳에 실린다. 다른 사이트의 iframe에도 있어야 한다(TAB-2 기대
  // 동작 4).
  content: { sites: 'all', frames: 'all', mainWorld: true },
  // 보지 않는 탭의 초점 흉내와 가짜 입력(결정 0041).
  permissions: ['debugger'],
  // 처음 설치하면 꺼져 있다(COM-1.1).
  settings: { schema: settingsSchema, defaults: { enabled: false } },
  // 팝업의 탭 목록이 그 탭에 보이는 까닭(TAB-2 기대 동작 9).
  notices: {
    'attach-failed':
      '디버거를 붙이지 못해 껐다. 페이지 안에 다른 확장이 넣은 화면이 있거나 보안 경고 화면이면 Chrome이 막는다.',
    cancelled: '디버깅 안내 막대에서 취소해 껐다. 다시 켜면 다시 붙인다.',
    'no-safe-point': '가짜 입력을 보낼 안전한 곳이 없어 보내지 않는다.',
  },
});

// 화면 안의 점(CSS 픽셀, 최상위 문서의 보이는 영역 기준). 가짜 입력(Input.dispatchMouseEvent)의 좌표와 같다.
const pointSchema = v.object({ x: v.number(), y: v.number() });

// 1픽셀씩 번갈아 쓰는 두 점(TAB-2 기대 동작 7).
const pairSchema = v.object({ first: pointSchema, second: pointSchema });

export type SafePair = v.InferOutput<typeof pairSchema>;

// 최상위 프레임의 페이지 쪽이 서비스 워커 쪽에 알린다: 켜진 이 탭의 문서가 실제로 숨김이 되었다(hidden) 또는 다시 보인다.
// 페이지 쪽 방패가 페이지에는 숨기지만, 보는 탭인데 숨김이면 창이 가려진 것이라 디버거를 붙인다(결정 0041).
export const hiddenCommand = defineCommand({
  featureId: tabKeepActive.id,
  name: 'hidden',
  payload: v.object({ hidden: v.boolean() }),
  value: v.null(),
});

// 서비스 워커 쪽이 최상위 프레임의 페이지 쪽에 묻는다: 가짜 입력을 보낼 안전한 두 점. keep은 지난번에 쓴 두 점이고, 아직
// 안전하면 그대로 쓴다. 안전한 곳이 없으면 null이다(TAB-2 기대 동작 7).
export const pointCommand = defineCommand({
  featureId: tabKeepActive.id,
  name: 'point',
  payload: v.object({ keep: v.nullable(pairSchema) }),
  value: v.object({ pair: v.nullable(pairSchema) }),
});
