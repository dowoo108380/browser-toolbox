import { useEffect, useState } from 'preact/hooks';
import type { FeatureDefinition } from '../contracts/index.ts';
import type { AppError, Result } from '../shared/index.ts';
import { type SettingsReaderHandlers, type Snapshot, settingsOf } from '../storage/index.ts';

// 팝업(COM-2). 05단계 뼈대에서는 기능마다 켜고 끄기만 있다. 범주와 검색은 06단계 COM-2에서 더한다.

interface PopupProps {
  readonly features: readonly FeatureDefinition[];
  readonly subscribe: (handlers: SettingsReaderHandlers) => () => void;
  readonly update: (
    featureId: string,
    patch: Readonly<Record<string, unknown>>,
  ) => Promise<Result<unknown, AppError>>;
}

const strings = {
  loading: '설정을 읽는 중이다.',
  on: '켜짐',
  off: '꺼짐',
  corrupt: '저장된 설정의 일부를 읽을 수 없어 기본값으로 바꿨다.',
  newer:
    '더 새 버전의 확장이 저장한 설정이라 이 버전에서는 기능을 쓸 수 없다. 새 버전을 다시 설치한다.',
};

export function PopupApp({ features, subscribe, update }: PopupProps) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(
    () =>
      subscribe({
        apply: setSnapshot,
        corrupt: () => {
          setNotice(strings.corrupt);
        },
        newer: () => {
          setSnapshot(null);
          setNotice(strings.newer);
        },
        problem: (error) => {
          setNotice(error.message);
        },
      }),
    [subscribe],
  );

  // 화면은 저장된 값을 보인다. 저장에 실패하면 알리고 값은 그대로 둔다(COM-3 기대 동작 3).
  const toggle = async (featureId: string, enabled: boolean) => {
    const result = await update(featureId, { enabled });
    setNotice(result.ok ? null : result.error.message);
  };

  return (
    <main>
      {snapshot === null ? (
        <p>{notice ?? strings.loading}</p>
      ) : (
        <ul class="features">
          {features.map((feature) => {
            const { enabled } = settingsOf(snapshot, feature);
            return (
              <li key={feature.id}>
                <label>
                  <input
                    type="checkbox"
                    role="switch"
                    data-feature={feature.id}
                    checked={enabled}
                    onChange={(event) => {
                      void toggle(feature.id, event.currentTarget.checked);
                    }}
                  />
                  <span class="name">{feature.name}</span>
                  <span class="state">{enabled ? strings.on : strings.off}</span>
                </label>
                <p class="description">{feature.description}</p>
              </li>
            );
          })}
        </ul>
      )}
      {snapshot !== null && notice !== null && <p role="status">{notice}</p>}
    </main>
  );
}
