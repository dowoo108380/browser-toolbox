import type * as v from './schema.ts';

// 팝업 범주. 요구사항 묶음과 같고, 팝업은 이 순서로 보인다(quality 017, 결정 0023). 설정 범주는 설정 페이지를 만들 때 더한다.
// 범주는 설정(settings)에 들지 않아 더해도 형식 버전과 상관없다. 팝업이 기억한 범주(storage.local의 popup)가 그 판이 모르는
// 것이면(새 판이 더한 범주를 옛 판이 읽음) 알리지 않고 첫 범주로 연다(storage/popup-state.ts, 결정 0040).
export const categories = [
  'media',
  'youtube',
  'subtitles',
  'tabs',
  'page',
  'chatgpt',
  'claude',
] as const;

export type Category = (typeof categories)[number];

// 기능이 요청하는 Chrome 권한. 기능을 만들며 필요한 것을 더한다(결정 0009). debugger: 활성 상태 유지(TAB-2)의 초점
// 흉내와 가짜 입력(결정 0041), 캡처(PAGE-1)의 전체·큰 영역 찍기. downloads, clipboardWrite: 캡처를 파일로 저장하고 클립보드에
// 복사함(결정 0047). activeTab: 팝업을 연 탭의 보이는 화면을 디버거 없이 찍음(chrome.tabs.captureVisibleTab, 결정 0048).
type FeaturePermission = 'debugger' | 'downloads' | 'clipboardWrite' | 'activeTab';

// 사이트 전용 기능이 작용하는 사이트(결정 0029). 사이트마다 콘텐츠 스크립트 묶음 하나가 그 주소에 실리고, 모든 사이트의
// 묶음(공통)은 그 주소에 실리지 않는다. YouTube는 그 사이트의 기능을 만들 때 더한다.
export const sites = ['chatgpt', 'claude'] as const;

export type Site = (typeof sites)[number];

// 사이트의 주소 패턴(manifest의 matches). manifest 생성이 쓰는 원본이다.
export const siteMatches: Readonly<Record<Site, readonly string[]>> = {
  chatgpt: ['https://chatgpt.com/*'],
  claude: ['https://claude.ai/*'],
};

// 기능이 페이지에 작용하는 곳(아키텍처 2장). 사이트는 빌드가 그 기능의 페이지 쪽 일을 넣을 콘텐츠 스크립트 묶음을 고르고
// (scripts/registry.ts), 프레임은 실행 틀이 그 프레임에서 시작할 기능을 고른다(src/page/runtime.ts). 묶음은 모든 프레임에
// 실린다. 'all'이면 모든 http·https 페이지(공통 묶음과 모든 사이트 묶음), 사이트 이름이면 그 사이트의 묶음에만 든다.
export interface ContentTarget {
  readonly sites: 'all' | Site;
  // 'top'이면 탭의 최상위 프레임에서만 작용한다.
  readonly frames: 'all' | 'top';
  // 참이면 이 기능은 페이지의 세계(MAIN)에 실리는 페이지 쪽 스크립트(features/<기능>/main.ts, 진입점 entries/main-<기능 id>.ts)를
  // 가진다. manifest가 같은 사이트와 프레임에 document_start로 싣는다(아키텍처 2장, 결정 0043).
  readonly mainWorld?: true;
}

// "켜고 끄기" 기능의 설정은 켜짐 여부를 가진다(COM-1).
export interface ToggleSettings {
  readonly enabled: boolean;
}

// 기능 하나의 원본(결정 0004, 아키텍처 3장). 다른 곳은 이것을 읽기만 한다. 종류마다 그 종류에만 뜻이 있는 것을 둔다(055).
interface FeatureBase {
  readonly id: string;
  // 이 기능이 맡는 요구사항 번호(예: MED-1).
  readonly requirements: readonly string[];
  readonly name: string;
  readonly description: string;
  readonly category: Category;
  readonly content: ContentTarget | null;
  readonly permissions: readonly FeaturePermission[];
  // 참이면 이 기능은 누를 때 그 탭의 최상위 문서에 넣는 페이지 쪽 스크립트(features/<기능>/inject.ts, 진입점
  // entries/inject-<기능 id>.ts)를 가진다. 빌드가 injectedScriptFile의 이름으로 묶고, 넣는 것은 그 기능의 서비스 워커 쪽이다.
  // 모든 페이지에 싣지 않으므로 웹 페이지에 비용을 더하지 않는다(아키텍처 2장, 결정 0046). 팝업은 확장이 접근할 수 없는
  // 탭(tab.status의 denied)에서 그 기능을 쓸 수 없다고 보인다.
  readonly injectedScript?: true;
}

// 누를 때 넣는 페이지 쪽 스크립트의 파일 이름(빌드가 만들고 기능의 서비스 워커 쪽이 넣는다).
export function injectedScriptFile(featureId: string): string {
  return `inject-${featureId}.js`;
}

// 누를 때 넣은 스크립트가 확장의 격리된 세계의 전역에 두는 일의 이름(Symbol.for의 키). 서비스 워커는 이 이름으로 그 일을
// 부른다(platform의 callInjected). 페이지 전역에는 남지 않는다(격리된 세계는 페이지와 전역을 나누지 않는다).
export function injectedApiKey(featureId: string): string {
  return `browser-toolbox.inject.${featureId}`;
}

// 켜 두면 계속 작용한다. 켜짐 여부와 그 밖의 설정을 저장한다(COM-1, COM-3).
export interface ToggleFeature<S extends ToggleSettings = ToggleSettings> extends FeatureBase {
  readonly kind: 'toggle';
  readonly settings: {
    readonly schema: v.Schema<S>;
    readonly defaults: S;
  };
}

// 실행 기능의 작업 종류 하나(결정 0046). 팝업에 단추 하나로 보이고, 작업 기록과 결과 알림이 이 이름으로 그 작업을 부른다.
export interface ActionChoice<A extends string = string> {
  readonly id: A;
  readonly name: string;
}

// 누를 때 그 탭에서 작업 하나를 끝까지 한다(COM-10, 결정 0024). 작업의 일은 기능의 background.ts에 있다.
// 지금은 설정이 없다. 설정이 필요한 실행 기능이 생기면 그때 더한다.
export interface ActionFeature<A extends string = string> extends FeatureBase {
  readonly kind: 'action';
  readonly task: {
    // 작업 하나의 제한 시간(ms). 넘기면 일에 멈춤 신호를 보내고 timeout으로 끝낸다(quality 068).
    readonly timeoutMs: number;
  };
  // 작업 종류(결정 0046). 하나 이상이고 id가 겹치지 않는다. 팝업은 종류마다 단추를 보이고, 작업은 그 종류로 시작한다.
  readonly actions: readonly [ActionChoice<A>, ...ActionChoice<A>[]];
}

// 탭마다 켜고 끄기(용어집, 결정 0043). 설정의 enabled는 "모든 탭" 스위치다: 켜면 열린 탭과 앞으로 여는 탭이 모두 켜지고, 끄면
// 모두 꺼진다. 탭마다 따로 켜고 끈 것은 서비스 워커가 storage.session에 두고, 스위치가 바뀌면 지운다. 확장을 다시 불러오거나
// 브라우저를 다시 켜면 탭마다 켠 것은 사라지고 스위치는 남는다(TAB-2 기대 동작 1, 10).
export interface TabToggleFeature<S extends ToggleSettings = ToggleSettings> extends FeatureBase {
  readonly kind: 'tab-toggle';
  readonly settings: {
    readonly schema: v.Schema<S>;
    readonly defaults: S;
  };
  // 탭마다의 알림: 그 기능의 서비스 워커 쪽이 정하는 이름 → 팝업의 탭 목록이 그 탭에 보이는 문구. 그 탭을 끈 까닭(예: 디버거를
  // 붙이지 못함)이나 켜진 채 하지 못한 일(예: 가짜 입력을 보낼 곳이 없음)이다.
  readonly notices: Readonly<Record<string, string>>;
}

export type FeatureDefinition = ToggleFeature | ActionFeature | TabToggleFeature;

// 설정을 저장하는 기능(켜고 끄기, 탭마다 켜고 끄기의 "모든 탭" 스위치). 설정을 읽고 쓰는 곳은 이것만 받는다.
export type SettingsFeature = ToggleFeature | TabToggleFeature;

// 페이지에 작용하는 켜고 끄기 기능. 페이지 쪽 일(definePagePart)은 이것만 받는다.
export type PageToggleFeature<S extends ToggleSettings = ToggleSettings> = ToggleFeature<S> & {
  readonly content: ContentTarget;
};

// 페이지에 작용하는 탭마다 켜고 끄기 기능. 탭마다의 페이지 쪽 일(defineTabPagePart)은 이것만 받는다.
export type PageTabToggleFeature<S extends ToggleSettings = ToggleSettings> =
  TabToggleFeature<S> & {
    readonly content: ContentTarget;
  };

// 페이지에 작용한다고 적은 정의는 그 타입을 그대로 돌려준다. 그래서 페이지에 작용하지 않는 기능(content: null)에 페이지 쪽
// 일을 만들면 타입 검사가 막는다.
export function defineFeature<S extends ToggleSettings>(
  definition: PageToggleFeature<S>,
): PageToggleFeature<S>;
export function defineFeature<S extends ToggleSettings>(
  definition: ToggleFeature<S>,
): ToggleFeature<S>;
export function defineFeature<A extends string>(definition: ActionFeature<A>): ActionFeature<A>;
export function defineFeature<S extends ToggleSettings>(
  definition: PageTabToggleFeature<S>,
): PageTabToggleFeature<S>;
export function defineFeature(definition: FeatureDefinition): FeatureDefinition {
  return definition;
}

// 설정을 저장하는 기능. 설정을 읽고 쓰는 곳(읽기 도우미, 서비스 워커의 설정 쓰기)은 이것만 받는다.
export function featuresWithSettings(
  features: readonly FeatureDefinition[],
): readonly SettingsFeature[] {
  return features.filter((feature) => feature.kind !== 'action');
}

// 그 실행 기능의 작업 종류. 없는 id면 null이다.
export function actionOf<A extends string>(
  feature: ActionFeature<A>,
  actionId: string,
): ActionChoice<A> | null {
  return feature.actions.find((action) => action.id === actionId) ?? null;
}

// 탭마다 켜고 끄는 기능.
export function tabToggleFeatures(
  features: readonly FeatureDefinition[],
): readonly TabToggleFeature[] {
  return features.filter((feature) => feature.kind === 'tab-toggle');
}
