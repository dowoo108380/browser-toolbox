import { describe, expect, it } from 'vitest';
import { formatRate } from './rate.ts';

describe('MED-1 배속 표시', () => {
  it.each([
    [1, '1×'],
    [1.5, '1.5×'],
    [1.25, '1.25×'],
    [0.07, '0.07×'],
    [16, '16×'],
    [1.239, '1.24×'],
    [0.1 + 0.2, '0.3×'],
  ])('%s배는 %s로 보인다', (rate, text) => {
    expect(formatRate(rate)).toBe(text);
  });
});
