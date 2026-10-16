import type { ToggleFeature } from '../contracts/index.ts';
import { strings } from './strings.ts';

// 팝업의 기능 항목 하나(결정 0023): 이름, 지금 상태, 설명, 지금 탭에서 쓸 수 없거나 동작하지 않으면 그 이유(쓸 수 없음,
// 찾지 못함, 결정 0026). 켜고 끄기 종류는 스위치이고 이름은 기능 이름이다. 이유가 있어도 스위치는 막지 않는다. 설정은 지금
// 탭이 아니라 모든 탭에 대한 것이다.
// 상태 글자는 눈으로 보는 사람을 위한 것이다. 스위치가 켜짐 여부를 스스로 알리므로 보조 기술에는 감춘다.

interface FeatureItemProps {
  readonly feature: ToggleFeature;
  readonly enabled: boolean;
  // 서비스 워커가 깨어나기 전에는 조작을 막는다(N-12).
  readonly disabled: boolean;
  readonly onToggle: (enabled: boolean) => void;
  // 지금 탭에서 쓸 수 없거나 동작하지 않는 이유. 없거나 모르면 null이다.
  readonly unavailable: string | null;
}

export function FeatureItem({
  feature,
  enabled,
  disabled,
  onToggle,
  unavailable,
}: FeatureItemProps) {
  const descriptionId = `feature-description-${feature.id}`;
  const reasonId = `feature-unavailable-${feature.id}`;
  return (
    <li class="feature">
      <div class="row">
        <label>
          <input
            type="checkbox"
            role="switch"
            data-feature={feature.id}
            checked={enabled}
            disabled={disabled}
            aria-describedby={unavailable === null ? descriptionId : `${descriptionId} ${reasonId}`}
            onChange={(event) => {
              onToggle(event.currentTarget.checked);
            }}
          />
          <span class="name">{feature.name}</span>
        </label>
        <span class="state" aria-hidden="true">
          {enabled ? strings.on : strings.off}
        </span>
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
