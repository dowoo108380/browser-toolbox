import { useEffect, useState } from 'preact/hooks';
import type { FeatureDefinition } from '../contracts/index.ts';
import type { AppError, Result } from '../shared/index.ts';
import { type SettingsReaderHandlers, type Snapshot, settingsOf } from '../storage/index.ts';

// 팝업(COM-2). 05단계 뼈대에서는 기능마다 켜고 끄기만 있다. 범주와 검색은 06단계 COM-2에서 더한다.

interface PopupProps {
  readonly features: readonly FeatureDefinition[];
  readonly subscribe: (handlers: SettingsReaderHandlers) => () => void;
  // 서비스 워커를 깨운다. 응답이 오면 깨어 있는 것이다.
  readonly wake: () => Promise<Result<unknown, AppError>>;
  readonly update: (
    featureId: string,
    patch: Readonly<Record<string, unknown>>,
  ) => Promise<Result<unknown, AppError>>;
}

// Chrome은 30초 동안 일이 없는 서비스 워커를 멈추고, 메시지를 받으면 그 시간을 다시 센다(Chrome 문서).
// 팝업이 열려 있는 동안 그보다 짧은 간격으로 깨워, 오래 열어 둔 뒤 누르자마자 닫혀도 요청이 닿게 한다(N-12, R-23).
export const keepAwakeIntervalMs = 20_000;

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

export function PopupApp({ features, subscribe, wake, update }: PopupProps) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // 서비스 워커가 깨어났는지(첫 깨우기의 응답을 받았는지). 그 전에는 스위치를 쓸 수 없다.
  // 깨어나는 중에 보낸 요청은 팝업이 곧바로 닫히면 닿지 않기 때문이다(N-12, R-23).
  const [awake, setAwake] = useState(false);

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

  useEffect(() => {
    let open = true;
    const wakeAndReport = async () => {
      const result = await wake();
      // 깨우지 못했으면 이유를 보인다. 스위치를 누르면 그 요청이 다시 깨우고 결과를 알린다.
      if (open && !result.ok) setNotice({ message: result.error.message });
    };
    void wakeAndReport().then(() => {
      if (open) setAwake(true);
    });
    const timer = setInterval(() => {
      void wakeAndReport();
    }, keepAwakeIntervalMs);
    return () => {
      open = false;
      clearInterval(timer);
    };
  }, [wake]);

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
                    disabled={!awake}
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
