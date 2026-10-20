import type { FeatureCommand, TabToggleFeature } from '../contracts/index.ts';
import type {
  KeyValueStore,
  Sender,
  TabActivityHandlers,
  TabInfo,
  TabResponse,
} from '../platform/index.ts';
import type { AppError, Result } from '../shared/index.ts';
import type { DebuggerManager } from './debugger.ts';
import type { Problem } from './problems.ts';

// 탭마다 켜고 끄는 기능의 서비스 워커 쪽 일(features/<기능>/background.ts, 결정 0043). 탭마다의 켜짐(고른 것과 "모든 탭"
// 스위치)과 그 기록은 공용 부분(tab-toggles.ts)이 맡고, 기능은 켜짐에 맞춰 Chrome의 상태(디버거 연결 등)를 만들고 없앤다.
// 기록이 Chrome의 상태보다 먼저 생기고 나중에 없어지게(결정 0038): 공용 부분은 기록을 쓴 뒤에 sync를 부르고, 기능은 자기가
// 만든 Chrome 상태를 그 기능의 기록(예: 원래 값)에 먼저 적은 뒤 만든다.

// 공용 부분이 기능에 주는 것.
export interface TabToggleHost {
  // 그 탭에서 이 기능이 켜졌는지(탭마다 고른 것, 없으면 "모든 탭" 스위치).
  readonly isOn: (tabId: number) => boolean;
  // 기능이 그 탭들을 끄고 까닭(이 기능의 notices 이름)을 남긴다. 기록을 쓴 뒤 그 탭들의 sync를 부른다.
  readonly turnOff: (tabIds: readonly number[], notice: string) => Promise<void>;
  // 켜진 탭을 모두 끄고 "모든 탭" 스위치도 끈다. 켜져 있던 탭에 까닭을 남긴다. 사용자가 그 기능의 일을 거절했을 때 쓴다(예:
  // 디버깅 안내 막대의 취소, TAB-2 기대 동작 9). 사용자가 다시 켤 때까지 다시 하지 않기 위해서다.
  readonly disable: (notice: string) => Promise<void>;
  // 켜진 채 하지 못한 일을 그 탭에 알린다. null이면 알림을 지운다. 켜짐은 그대로다.
  readonly notice: (tabId: number, notice: string | null) => Promise<void>;
}

// 기능이 쓰는 서비스 워커의 Chrome 경계와 공용 서비스. 진입점이 실제 것을, 시험이 가짜를 넣는다.
export interface TabToggleServices {
  readonly debuggers: DebuggerManager;
  // 기능의 기록을 두는 storage.local(다시 불러와도 남는다).
  readonly local: KeyValueStore;
  // 닫힌 탭이면 null이고, 묻지 못하면 던진다.
  readonly tabInfo: (tabId: number) => Promise<TabInfo | null>;
  readonly setAutoDiscardable: (tabId: number, autoDiscardable: boolean) => Promise<void>;
  // 닫힌 창이면 null이고, 묻지 못하면 던진다.
  readonly windowInfo: (
    windowId: number,
  ) => Promise<{ readonly minimized: boolean; readonly focused: boolean } | null>;
  // 그 탭의 최상위 프레임의 이 기능 페이지 쪽에 명령을 보낸다.
  readonly askTop: <Payload, Value>(
    tabId: number,
    command: FeatureCommand<Payload, Value>,
    payload: Payload,
  ) => Promise<TabResponse<Value>>;
  readonly record: (problem: Problem) => void;
}

// 공용 부분이 기능에 넘기는 탭 사건. 공용 부분이 켜진 탭이 있을 수 있는 동안만 듣는다.
type TabToggleEvents = Omit<TabActivityHandlers, 'created'>;

export interface TabToggleRunner extends TabToggleEvents {
  // 그 탭들의 Chrome 상태를 지금 켜짐에 맞춘다. 기능이 자기 줄에서 차례로 하고, 끝을 기다리지 않는다.
  readonly sync: (tabIds: readonly number[]) => void;
  // 서비스 워커가 시작할 때 앞 서비스 워커나 다시 불러오기 전의 판이 남긴 Chrome 상태를 기능의 기록으로 맞춘다. 공용 부분이
  // 기록을 읽은 뒤, 그 시작의 sync보다 먼저 부른다. sync처럼 기능이 자기 줄에서 하고, 끝을 기다리지 않는다.
  readonly recover: () => void;
  // 페이지 쪽이 보낸 이 기능의 명령(feature.command). 이름과 내용은 기능이 검증한다.
  readonly command: (
    name: string,
    payload: unknown,
    sender: Extract<Sender, { readonly kind: 'content' }>,
  ) => Promise<Result<unknown, AppError>>;
}

export interface TabTogglePart {
  readonly featureId: string;
  readonly start: (host: TabToggleHost, services: TabToggleServices) => TabToggleRunner;
}

export function defineTabTogglePart(
  definition: TabToggleFeature,
  start: (host: TabToggleHost, services: TabToggleServices) => TabToggleRunner,
): TabTogglePart {
  return { featureId: definition.id, start };
}
