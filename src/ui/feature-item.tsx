import type { FeatureDefinition } from '../contracts/index.ts';
import { strings } from './strings.ts';

// 팝업의 기능 항목 하나(결정 0023): 이름, 지금 상태, 설명. 켜고 끄기 종류는 스위치이고 이름은 기능 이름이다.
// 상태 글자는 눈으로 보는 사람을 위한 것이다. 스위치가 켜짐 여부를 스스로 알리므로 보조 기술에는 감춘다.

interface FeatureItemProps {
  readonly feature: FeatureDefinition;
  readonly enabled: boolean;
  // 서비스 워커가 깨어나기 전에는 조작을 막는다(N-12).
  readonly disabled: boolean;
  readonly onToggle: (enabled: boolean) => void;
}

export function FeatureItem({ feature, enabled, disabled, onToggle }: FeatureItemProps) {
  const descriptionId = `feature-description-${feature.id}`;
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
            aria-describedby={descriptionId}
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
    </li>
  );
}
