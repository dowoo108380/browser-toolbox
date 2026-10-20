import { useState } from 'preact/hooks';
import type { TabToggleFeature } from '../contracts/index.ts';
import { strings } from './strings.ts';

// 팝업의 탭마다 켜고 끄는 기능 하나(TAB-2 기대 동작 1·8, 결정 0043): 이름, 설명, "모든 탭" 스위치(설정), 팝업을 연 창의 탭
// 목록. 목록에서 하나 또는 여러 탭을 골라 켜거나 끈다. 탭마다 켜짐·꺼짐과 그 기능이 남긴 까닭(꺼진 이유, 하지 못한 일)이나
// 쓸 수 없는 이유를 보인다. 상태 글자는 눈으로 보는 사람을 위한 것이고, 고르는 칸이 이름표와 상태를 설명으로 잇는다.

export interface TabRow {
  readonly id: number;
  readonly title: string;
  readonly on: boolean;
  // 그 탭의 까닭이나 쓸 수 없는 이유. 없으면 null이다.
  readonly reason: string | null;
}

interface TabToggleItemProps {
  readonly feature: TabToggleFeature;
  readonly allTabs: boolean;
  // 서비스 워커가 깨어나기 전에는 조작을 막는다(N-12).
  readonly disabled: boolean;
  readonly onAllTabs: (on: boolean) => void;
  // 이 창의 탭. 아직 모르거나 받지 못했으면 null이다(받지 못한 까닭은 알림 줄이 보인다).
  readonly tabs: readonly TabRow[] | null;
  readonly onApply: (tabIds: readonly number[], on: boolean) => Promise<void>;
}

export function TabToggleItem({
  feature,
  allTabs,
  disabled,
  onAllTabs,
  tabs,
  onApply,
}: TabToggleItemProps) {
  const nameId = `feature-name-${feature.id}`;
  const descriptionId = `feature-description-${feature.id}`;
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [applying, setApplying] = useState(false);
  // 목록에 없는 탭(닫힌 탭)은 고른 것에서 뺀다.
  const chosen = [...selected].filter((id) => tabs?.some((tab) => tab.id === id) === true);
  const blocked = disabled || applying || chosen.length === 0;
  const apply = (on: boolean) => {
    if (blocked) return;
    setApplying(true);
    void onApply(chosen, on).then(() => {
      setApplying(false);
      setSelected(new Set());
    });
  };
  const choose = (id: number, on: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  return (
    <li class="feature tab-toggle">
      <div class="row">
        <span class="name" id={nameId}>
          {feature.name}
        </span>
      </div>
      <p class="description" id={descriptionId}>
        {feature.description}
      </p>
      <div class="row all-tabs">
        <label>
          <input
            type="checkbox"
            role="switch"
            data-feature={feature.id}
            checked={allTabs}
            disabled={disabled}
            aria-describedby={`${nameId} ${descriptionId}`}
            onChange={(event) => {
              onAllTabs(event.currentTarget.checked);
            }}
          />
          <span>{strings.allTabs}</span>
        </label>
        <span class="state" aria-hidden="true">
          {allTabs ? strings.on : strings.off}
        </span>
      </div>
      <fieldset class="tab-list">
        <legend>{strings.windowTabs}</legend>
        {tabs === null ? (
          <p>{strings.loading}</p>
        ) : (
          <ul>
            {tabs.map((tab) => {
              const stateId = `tab-state-${feature.id}-${String(tab.id)}`;
              return (
                <li key={tab.id} data-tab={tab.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.has(tab.id)}
                      disabled={disabled}
                      aria-describedby={stateId}
                      onChange={(event) => {
                        choose(tab.id, event.currentTarget.checked);
                      }}
                    />
                    <span class="title">{tab.title}</span>
                  </label>
                  <span class="state" id={stateId}>
                    {tab.on ? strings.on : strings.off}
                    {tab.reason === null ? '' : ` · ${tab.reason}`}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <div class="tab-actions">
          <button
            type="button"
            aria-disabled={blocked ? 'true' : undefined}
            onClick={() => {
              apply(true);
            }}
          >
            {strings.turnOnSelected}
          </button>
          <button
            type="button"
            aria-disabled={blocked ? 'true' : undefined}
            onClick={() => {
              apply(false);
            }}
          >
            {strings.turnOffSelected}
          </button>
        </div>
      </fieldset>
    </li>
  );
}
