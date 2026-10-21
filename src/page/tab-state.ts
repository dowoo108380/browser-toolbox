import type { TabState } from '../contracts/index.ts';
import { type AppError, type Result, appError } from '../shared/index.ts';

// 콘텐츠 스크립트가 자기 탭에서 켜진 탭마다 켜고 끄는 기능을 받는다(결정 0043). 서비스 워커의 알림(tabState.changed)을 먼저
// 듣고, 지금 상태로 맞춘다: 어느 탭에서 켜졌을 수 있는 기능이 있을 때만(storage.local의 표시) 서비스 워커에 묻고
// (tabState.get), 없으면 묻지 않고 모두 꺼짐이다. 그래서 아무 데서도 켜지 않은 동안은 페이지를 열 때마다 서비스 워커를 깨우지
// 않는다. 맞추는 사이 알림이 오면 답은 버린다. 서비스 워커는 바뀔 때마다 그 탭의 모든 프레임에 알리므로, 알림 뒤에 계산된 답이
// 버려져도 그 뒤의 바뀜은 다시 알림으로 온다.
// 뒤로·앞으로 캐시(bfcache)에 든 문서에는 Chrome이 메시지를 보내지 않아 그동안의 알림을 놓친다. 그래서 되살아나면 다시 맞춘다.
// 설정은 저장소 바뀜 알림이라 Chrome이 되살아난 문서에 전한다(2026-10-21 실험).

export interface TabStateDeps {
  // 어느 탭에서 켜졌을 수 있는 기능 id(storage.local의 tabToggleHint). 읽지 못하면 던진다.
  readonly hint: () => Promise<readonly string[]>;
  readonly ask: () => Promise<Result<TabState, AppError>>;
  readonly listen: (receive: (state: TabState) => void) => () => void;
  // 이 문서가 bfcache에서 되살아나면 부른다. 돌려준 함수로 그만둔다.
  readonly restored: (handle: () => void) => () => void;
  // 이 묶음에 페이지 쪽 일이 있는 탭마다 켜는 기능.
  readonly featureIds: readonly string[];
}

export interface TabStateHandlers {
  readonly apply: (on: ReadonlySet<string>) => void;
  readonly problem: (error: AppError) => void;
}

export function subscribeTabState(deps: TabStateDeps, handlers: TabStateHandlers): () => void {
  let stopped = false;
  // 맞추기를 시작하거나 알림을 받을 때마다 올린다. 맞추기는 시작한 때의 값이 그대로일 때만 넘긴다. 그 사이 알림이 왔으면 그것이
  // 더 새것이고, 다시 맞추기를 시작했으면 그쪽이 넘긴다.
  let turn = 0;
  // await 사이에 바뀔 수 있어 함수로 읽는다. TypeScript는 await 뒤에도 앞에서 확인한 값을 그대로 이어 쓴다.
  const current = (mine: number) => !stopped && turn === mine;
  const ours = (state: TabState) => new Set(state.on.filter((id) => deps.featureIds.includes(id)));
  const stopListening = deps.listen((state) => {
    turn += 1;
    if (!stopped) handlers.apply(ours(state));
  });
  const sync = async () => {
    turn += 1;
    const mine = turn;
    // 표시를 읽지 못하면 켜졌을 수 있는 것으로 보고 묻는다(묻는 것이 늘 뿐이다).
    const hint = await deps.hint().catch(() => deps.featureIds);
    if (!current(mine)) return;
    // 되살아난 문서는 떠나기 전에 켜져 있었을 수 있어, 묻지 않을 때도 꺼짐을 넘긴다.
    if (!hint.some((id) => deps.featureIds.includes(id))) {
      handlers.apply(new Set());
      return;
    }
    const answer = await deps.ask();
    if (!current(mine)) return;
    if (answer.ok) handlers.apply(ours(answer.value));
    else handlers.problem(answer.error);
  };
  const start = () => {
    sync().catch(() => {
      // apply가 던지는 것은 일어나면 안 된다. 기다리는 쪽이 없어 실행 틀에 알린다.
      if (!stopped)
        handlers.problem(appError('unexpected', '탭의 상태를 받다 예상하지 못한 오류가 났다.'));
    });
  };
  start();
  const stopRestored = deps.restored(start);
  return () => {
    stopped = true;
    stopListening();
    stopRestored();
  };
}
