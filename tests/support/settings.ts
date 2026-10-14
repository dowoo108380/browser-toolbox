import * as z from 'zod/mini';
import { type FeatureDefinition, defineFeature } from '../../src/contracts/index.ts';
import { type SettingsFormat, currentStructure } from '../../src/storage/index.ts';

// storage와 background 테스트가 함께 쓰는 설정 시험 자료. 테스트에서만 가져온다.

// 시험 기능은 사이트마다 따로 정하는 설정(사이트 규칙처럼 문자열 목록)도 있다. 사이트 설정은 아직 기능 정의(FeatureDefinition)에
// 없어 저장 모듈이 받는 모양(FeatureSettingsSpec)으로 더한다. 사이트 설정이 있는 기능을 처음 만들 때 정의에 더한다(결정 0017).
const sampleFeature: FeatureDefinition<{
  readonly enabled: boolean;
  readonly step: number;
  readonly label: string;
}> & { readonly siteSettings: { readonly schema: z.ZodMiniType } } = {
  ...defineFeature({
    id: 'sample',
    requirements: [],
    name: '시험 기능',
    description: '시험용',
    category: 'media',
    kind: 'toggle',
    content: null,
    permissions: [],
    settings: {
      schema: z.object({ enabled: z.boolean(), step: z.number(), label: z.string() }),
      defaults: { enabled: false, step: 0.1, label: '' },
    },
  }),
  siteSettings: { schema: z.object({ rules: z.array(z.string()) }) },
};

const otherFeature: FeatureDefinition = defineFeature({
  id: 'other',
  requirements: [],
  name: '다른 기능',
  description: '시험용',
  category: 'page',
  kind: 'toggle',
  content: null,
  permissions: [],
  settings: { schema: z.object({ enabled: z.boolean() }), defaults: { enabled: false } },
});

export const specs = [sampleFeature, otherFeature];

export function stored(
  revision: number,
  features: Record<string, unknown> = {},
  sites: Record<string, unknown> = {},
) {
  return { version: 1, revision, features, sites };
}

// 구조가 지금과 다른 가짜 옛 버전 1과, 그것을 이전하는 지금 버전 2(결정 0011 "형식 이전과 고쳐 쓰기").
// 옛 버전 1은 설정을 data.featureSettings에 두고 세대 번호를 rev라 불렀다.
const oldStructure = z.object({
  version: z.literal(1),
  rev: z.int(),
  data: z.object({ featureSettings: z.record(z.string(), z.unknown()) }),
});

export const twoVersionFormat: SettingsFormat = {
  version: 2,
  structure: currentStructure(2),
  migrations: new Map([
    [
      1,
      {
        structure: oldStructure,
        migrate: (value: unknown) => {
          const old = oldStructure.parse(value);
          return {
            version: 2,
            revision: old.rev,
            features: old.data.featureSettings,
            sites: {},
          };
        },
      },
    ],
  ]),
};

export function oldStored(rev: number, featureSettings: Record<string, unknown> = {}) {
  return { version: 1, rev, data: { featureSettings } };
}
