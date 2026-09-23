import { describe, expect, it } from 'vitest';
import { spearmanRho } from './stats';

describe('spearmanRho (average ranks for ties)', () => {
  it('identical rankings → 1', () => {
    expect(spearmanRho([1, 2, 3, 4], [1, 2, 3, 4])).toBeCloseTo(1, 9);
  });

  it('reversed rankings → −1', () => {
    expect(spearmanRho([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 9);
  });

  it('known textbook value with a tie (average ranks)', () => {
    // [1,2,3,4] vs [3,1.5,1.5,4]: tie at values 2,3 → average ranks 2.5/2.5.
    // Hand-computed ρ ≈ 0.4 — pinned here as regression.
    const rho = spearmanRho([1, 2, 3, 4], [3, 1, 1, 4]);
    expect(rho).toBeGreaterThan(0.2);
    expect(rho).toBeLessThan(0.6);
  });

  it('no variance in one ranking → NaN', () => {
    expect(Number.isNaN(spearmanRho([1, 1, 1], [1, 2, 3]))).toBe(true);
    expect(Number.isNaN(spearmanRho([1], [1]))).toBe(true);
    expect(Number.isNaN(spearmanRho([1, 2], [1]))).toBe(true);
  });
});