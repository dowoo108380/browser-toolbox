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

// 알림. 실패할 때마다 새 객체를 둔다. 같은 문구라도 다시 그려야 스위치가 저장된 값으로 돌아가기 때문이다.
interface Notice {
  readonly message: string;
}

export function PopupApp({ features, subscribe, update }: PopupProps) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(
    () =>
      subscribe({
        apply: setSnapshot,
        corrupt: () => {
          setNotice({ message: strings.corrupt });
        },
        newer: () => {
          setSnapshot(null);
          setNotice({ message: strings.newer });
        },
        problem: (error) => {
          setNotice({ message: error.message });
        },
      }),
    [subscribe],
  );

  // 화면은 저장된 값을 보인다. 저장에 실패하면 알리고 스위치를 저장된 값으로 되돌린다(COM-3 기대 동작 3).
  const toggle = async (featureId: string, enabled: boolean) => {
    const result = await update(featureId, { enabled });
    setNotice(result.ok ? null : { message: result.error.message });
  };

  return (
    <main>
      {snapshot === null ? (
        <p>{notice?.message ?? strings.loading}</p>
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
      {snapshot !== null && notice !== null && <p role="status">{notice.message}</p>}
    </main>
  );
}
