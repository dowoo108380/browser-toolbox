import { describe, expect, it } from 'vitest';
import { specs, stored } from '../../tests/support/settings.ts';
import { checkItems, withoutItems } from './items.ts';

// 설정 항목 검증(결정 0011 읽는 쪽 계약 4, 결정 0017). 읽는 쪽, 서비스 워커의 고쳐 쓰기, 쓰기 직전의 최종 값 검증이
// 모두 이 기준을 쓴다. 시험 기능(sample)은 사이트 설정이 있고 다른 기능(other)은 없다(tests/support/settings.ts).

describe('결정 0017 사이트 항목 검증', () => {
  it('사이트 값이 객체가 아니면(null, 배열, 문자열, 수) 그 사이트 전체가 손상이다', () => {
    const value = stored(1, {}, { a: null, b: [], c: 'x', d: 1, e: {} });
    const { sites, corruptSites } = checkItems(value, specs);
    expect(corruptSites).toEqual([
      { host: 'a', featureId: null },
      { host: 'b', featureId: null },
      { host: 'c', featureId: null },
      { host: 'd', featureId: null },
    ]);
    expect(sites).toEqual(new Map());
  });

  it('사이트 설정을 정한 기능의 항목만 그 스키마로 검증한다. 통과한 항목이 없는 사이트는 결과에 없다', () => {
    const value = stored(
      1,
      {},
      {
        a: { sample: { rules: ['#ad'] }, other: 'x', 'future-feature': 1 },
        b: { sample: { rules: [1] } },
        c: { other: { rules: [] } },
      },
    );
    const { sites, corruptSites, corruptFeatures } = checkItems(value, specs);
    expect(sites).toEqual(new Map([['a', new Map([['sample', { rules: ['#ad'] }]])]]));
    expect(corruptSites).toEqual([{ host: 'b', featureId: 'sample' }]);
    expect(corruptFeatures).toEqual([]);
  });
});

describe('손상 항목 지우기', () => {
  const value = stored(
    1,
    { sample: { enabled: 'no' }, other: { enabled: true }, 'future-feature': [1] },
    {
      whole: 'x',
      split: { sample: { rules: 1 }, other: { kept: true } },
      both: { sample: { rules: 1 }, 'future-feature': { rules: 1 } },
      untouched: { sample: { rules: 1 } },
      // 받은 목록에 없으면 객체가 아니어도 그대로 둔다. 무엇을 지울지는 받은 목록이 정한다.
      odd: 7,
    },
  );

  it('받은 기능 항목과 사이트 항목만 지우고, 나머지는 저장된 값 그대로 둔다', () => {
    expect(
      withoutItems(
        value,
        ['sample'],
        [
          { host: 'whole', featureId: null },
          { host: 'split', featureId: 'sample' },
          { host: 'both', featureId: 'sample' },
          { host: 'both', featureId: 'future-feature' },
        ],
      ),
    ).toEqual(
      stored(
        1,
        { other: { enabled: true }, 'future-feature': [1] },
        {
          split: { other: { kept: true } },
          both: {},
          untouched: { sample: { rules: 1 } },
          odd: 7,
        },
      ),
    );
  });

  it('지울 것이 없으면 내용이 같다', () => {
    expect(withoutItems(value, [], [])).toEqual(value);
  });
});
