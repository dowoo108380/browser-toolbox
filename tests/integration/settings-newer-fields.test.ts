import { describe, expect, it } from 'vitest';
import { featuresWithSettings, settingsUpdate } from '../../src/contracts/index.ts';
import { features } from '../../src/features/list.ts';
import { createFakeStore } from '../../src/platform/fake.ts';
import { repairNoticeKey, settingsFormat, settingsKey } from '../../src/storage/index.ts';
import { startTestBackground } from '../support/background.ts';

// 같은 형식 버전 안에서 더 새 판이 기능 설정에 필드를 더한 뒤(결정 0021의 규칙) 사용자가 옛 판으로 되돌려 그 기능을
// 바꿔도, 더 새 판의 필드는 사용자 값 그대로 남는다(결정 0022). 그래야 다시 새 판으로 올렸을 때 그 값을 잃지 않는다
// (quality 118). 이 판이 옛 판 노릇을 한다: 실제 기능 목록의 기능마다 실제 라우터와 설정 저장에 settings.update를
// 보낸다. 가짜는 저장소와 메시지 통로뿐이다. 그래서 쓰기가 스키마를 거친 값을 저장해 모르는 필드를 지우는 것뿐 아니라,
// 기능의 스키마가 모르는 필드를 거절해(z.strictObject) 그 항목을 손상으로 보고 기본값으로 고쳐 쓰는 것도 여기서 드러난다.

const t = 1_800_000_000_000;

describe('결정 0022 옛 판이 더 새 판의 필드가 든 기능 설정을 바꿈', () => {
  it.each(featuresWithSettings(features))(
    '$id: 바꾼 필드만 바뀌고 더 새 판이 더한 필드는 저장된 값 그대로 남는다',
    async (feature) => {
      // 더 새 판이 더한 필드(savedFuturePreference)와, 사용자가 그 판에서 켜 둔 기능.
      const newer = { ...feature.settings.defaults, enabled: true, savedFuturePreference: 2.5 };
      const store = createFakeStore({
        [settingsKey]: {
          version: settingsFormat.version,
          revision: t - 1000,
          features: { [feature.id]: newer },
          sites: {},
        },
      });
      const request = startTestBackground({ store, features, startTime: t });

      const result = await request(settingsUpdate, {
        featureId: feature.id,
        patch: { enabled: false },
      });

      if (!result.ok) throw new Error(`설정을 바꾸지 못했다: ${result.error.message}`);
      expect(store.peek(settingsKey)).toEqual({
        version: settingsFormat.version,
        revision: result.value.revision,
        features: { [feature.id]: { ...newer, enabled: false } },
        sites: {},
      });
      // 손상으로 보지 않았다.
      expect(store.peek(repairNoticeKey)).toBeUndefined();
      expect(store.peek('problems')).toBeUndefined();
    },
  );
});
