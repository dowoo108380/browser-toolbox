import type { ActionChoice, ActionFeature } from '../contracts/index.ts';

// 팝업의 실행 기능 하나(결정 0024, 0046): 작업 종류마다의 단추, 설명, 쓸 수 없으면 그 이유. 누르면 지금 탭에서 그 종류의 작업을
// 시작한다. 종류가 하나면 단추에 그 이름을 쓰고, 여럿이면 기능 이름을 먼저 보인 뒤 종류마다 단추를 둔다.
// 켜고 끄기와 달리 그 탭에서만 하는 일이라, 쓸 수 없을 때는 단추를 막고 이유를 단추의 설명으로 잇는다.
// 막을 때 disabled 대신 aria-disabled를 쓴다. 초점이 그대로 가서(키보드, 검색에서 간 기능) 왜 막혔는지 들을 수 있다.

interface ActionItemProps {
  readonly feature: ActionFeature;
  // 아직 쓸 수 있는지 모르면 이유 없이 막는다: 서비스 워커가 깨어나기 전, 지금 탭을 모를 때, 그 탭의 작업 기록을 처음
  // 읽기 전, 받은 기록을 작업 칸에 보인 화면이 나오기 전, 페이지에 작용하는 기능이면 그 탭에서 쓸 수 있는지 답을 받기 전
  // (N-12, 결정 0024).
  readonly waiting: boolean;
  readonly onRun: (action: ActionChoice) => void;
  // 지금 탭에서 쓸 수 없는 이유. 쓸 수 있거나 모르면 null이다.
  readonly unavailable: string | null;
}

export function ActionItem({ feature, waiting, onRun, unavailable }: ActionItemProps) {
  const descriptionId = `feature-description-${feature.id}`;
  const reasonId = `feature-unavailable-${feature.id}`;
  const blocked = waiting || unavailable !== null;
  const several = feature.actions.length > 1;
  return (
    <li class="feature action-item">
      {several && <p class="name">{feature.name}</p>}
      <div class="row">
        {feature.actions.map((action) => (
          <button
            key={action.id}
            type="button"
            class="action"
            data-feature={feature.id}
            data-action={action.id}
            aria-disabled={blocked ? 'true' : undefined}
            aria-describedby={unavailable === null ? descriptionId : `${descriptionId} ${reasonId}`}
            onClick={() => {
              if (!blocked) onRun(action);
            }}
          >
            {action.name}
          </button>
        ))}
      </div>
      <p class="description" id={descriptionId}>
        {feature.description}
      </p>
      {unavailable !== null && (
        <p class="reason" id={reasonId}>
          {unavailable}
        </p>
      )}
    </li>
  );
}
