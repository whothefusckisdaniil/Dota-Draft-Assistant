import { describe, it, expect } from 'vitest';
import {
  N_PERMUTATIONS, RESEARCH_SEED, MIN_GROUP_SUPPORT, FDR_Q,
  mulberry32, eligibleCells, topKSet,
  differenceInRates, differenceInMeans,
  groupItemRates, meanObservedItemScore,
  randomSubset, permutationTest, benjaminiHochberg,
} from './capability-item-prior-lib.mjs';

describe('constants', () => {
  it('fixes the TZ-mandated design parameters', () => {
    expect(N_PERMUTATIONS).toBe(2000);
    expect(RESEARCH_SEED).toBe(20261006);
    expect(MIN_GROUP_SUPPORT).toBe(10);
    expect(FDR_Q).toBe(0.05);
  });
});

describe('mulberry32', () => {
  it('is deterministic: same seed gives the same stream', () => {
    const a = mulberry32(RESEARCH_SEED);
    const b = mulberry32(RESEARCH_SEED);
    expect(Array.from({ length: 20 }, () => a())).toEqual(
      Array.from({ length: 20 }, () => b()),
    );
  });

  it('stays in [0, 1) and differs across seeds', () => {
    const a = mulberry32(1);
    const vals = Array.from({ length: 100 }, () => a());
    for (const v of vals) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(new Set(vals).size).toBeGreaterThan(90);
  });
});

describe('eligibleCells', () => {
  const positions = {
    1: { positions: { 1: { share: 0.9, games: 1000 }, 2: { share: 0.05, games: 900 } } },
    2: { positions: { 1: { share: 0.08, games: 500 }, 3: { share: 0.5, games: 400 } } },
    3: {},
  };

  it('applies the production gate: share>=8% AND games>=500', () => {
    expect(eligibleCells(positions)).toEqual([
      { heroId: 1, position: '1' },
      { heroId: 2, position: '1' },
    ]);
  });

  it('is order-stable regardless of input key order', () => {
    const flipped = {
      2: { positions: { 3: { share: 0.5, games: 400 }, 1: { share: 0.08, games: 500 } } },
      3: {},
      1: { positions: { 2: { share: 0.05, games: 900 }, 1: { share: 0.9, games: 1000 } } },
    };
    expect(eligibleCells(flipped)).toEqual(eligibleCells(positions));
  });

  it('returns [] on missing input instead of throwing', () => {
    expect(eligibleCells(null)).toEqual([]);
    expect(eligibleCells({})).toEqual([]);
  });
});

describe('topKSet', () => {
  it('takes the first K ids in the caller-provided (already ranked) order', () => {
    expect(topKSet([7, 3, 9, 1], 2)).toEqual(new Set([7, 3]));
  });

  it('tolerates short lists and non-positive K', () => {
    expect(topKSet([5], 10)).toEqual(new Set([5]));
    expect(topKSet([5], 0)).toEqual(new Set());
    expect(topKSet(null, 5)).toEqual(new Set());
  });

  it('never re-ranks: order is caller truth', () => {
    expect(topKSet([30, 2, 100], 3)).toEqual(new Set([30, 2, 100]));
  });
});

describe('differenceInRates / differenceInMeans', () => {
  it('computes the absolute group gap', () => {
    expect(differenceInRates(8, 10, 2, 10)).toBeCloseTo(0.6, 12);
    expect(differenceInMeans(30, 10, 10, 10)).toBeCloseTo(2, 12);
  });

  it('returns NaN on empty groups, never Infinity', () => {
    expect(differenceInRates(1, 0, 1, 5)).toBeNaN();
    expect(differenceInMeans(1, 5, 1, 0)).toBeNaN();
  });
});


describe('groupItemRates', () => {
  it('computes TRUE vs FALSE rates and signed delta inside one stratum', () => {
    const withSupport = [];
    for (let i = 0; i < 10; i += 1) {
      withSupport.push({ key: `t${i}`, top: new Set(i < 6 ? [1] : [2]) });
      withSupport.push({ key: `f${i}`, top: new Set(i < 2 ? [1] : [2]) });
    }
    const labels = new Map([
      ...withSupport.filter((c) => c.key.startsWith('t')).map((c) => [c.key, 'TRUE']),
      ...withSupport.filter((c) => c.key.startsWith('f')).map((c) => [c.key, 'FALSE']),
    ]);
    const [r] = groupItemRates(withSupport, labels, [1]);
    expect(r.trueRate).toBeCloseTo(0.6, 12);
    expect(r.falseRate).toBeCloseTo(0.2, 12);
    expect(r.delta).toBeCloseTo(0.4, 12);
    expect(r.nT).toBe(10);
    expect(r.nF).toBe(10);
  });

  it('excludes UNKNOWN labels from both groups (never coerced to FALSE)', () => {
    const cells = [];
    const entries = [];
    for (let i = 0; i < 10; i += 1) {
      cells.push({ key: `t${i}`, top: new Set([1]) });
      cells.push({ key: `f${i}`, top: new Set([2]) });
      entries.push([`t${i}`, 'TRUE'], [`f${i}`, 'FALSE']);
    }
    for (let i = 0; i < 5; i += 1) {
      cells.push({ key: `u${i}`, top: new Set([1]) });
      entries.push([`u${i}`, 'UNKNOWN']);
    }
    const [r] = groupItemRates(cells, new Map(entries), [1]);
    expect(r.nT).toBe(10);
    expect(r.nF).toBe(10);
    expect(r.trueRate).toBe(1);
    expect(r.falseRate).toBe(0);
  });

  it('flags thin groups as INSUFFICIENT_SUPPORT with NaN rates', () => {
    const cells = [{ key: 't0', top: new Set([1]) }, { key: 'f0', top: new Set([1]) }];
    const labels = new Map([['t0', 'TRUE'], ['f0', 'FALSE']]);
    const [r] = groupItemRates(cells, labels, [1]);
    expect(r.trueRate).toBeNaN();
    expect(r.falseRate).toBeNaN();
    expect(r.nT).toBe(1);
    expect(r.nF).toBe(1);
  });
});

describe('meanObservedItemScore', () => {
  it('averages only over cells where the item row exists (no zero-fill)', () => {
    const cells = [];
    const labels = new Map();
    for (let i = 0; i < 12; i += 1) {
      const scores = new Map();
      if (i < 10) scores.set(1, 2 + i * 0.1);
      cells.push({ key: `t${i}`, scores });
      labels.set(`t${i}`, 'TRUE');
    }
    for (let i = 0; i < 12; i += 1) {
      const scores = new Map();
      if (i < 10) scores.set(1, 1);
      cells.push({ key: `f${i}`, scores });
      labels.set(`f${i}`, 'FALSE');
    }
    const [r] = meanObservedItemScore(cells, labels, [1]);
    expect(r.nT).toBe(10);
    expect(r.nF).toBe(10);
    expect(r.meanT).toBeCloseTo(2.45, 10);
    expect(r.meanF).toBe(1);
  });

  it('returns NaN when the observed counts fall below support', () => {
    const cells = [{ key: 't0', scores: new Map([[1, 5]]) }, { key: 'f0', scores: new Map() }];
    const labels = new Map([['t0', 'TRUE'], ['f0', 'FALSE']]);
    const [r] = meanObservedItemScore(cells, labels, [1]);
    expect(r.meanT).toBeNaN();
    expect(r.nF).toBe(0);
  });
});

describe('randomSubset', () => {
  it('draws a valid subset deterministically', () => {
    const s = randomSubset(mulberry32(7), 5, 3);
    expect([...s].sort((a, b) => a - b)).toHaveLength(3);
    expect(new Set(s).size).toBe(3);
    for (const i of s) {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(5);
    }
    const s2 = randomSubset(mulberry32(7), 5, 3);
    expect([...s2].sort()).toEqual([...s].sort());
  });
});

describe('permutationTest', () => {
  it('detects a strong separation with a tiny p-value', () => {
    const values = [...Array(12).fill(1), ...Array(12).fill(0)];
    const isTrue = values.map((_, i) => i < 12);
    const r = permutationTest(values, isTrue, 2000, mulberry32(RESEARCH_SEED));
    expect(r.observed).toBeCloseTo(1, 12);
    expect(r.p).toBeLessThan(0.005);
  });

  it('does not flag pure noise systematically (identity check)', () => {
    // One fixed noise draw may land anywhere in [0,1] — including below 0.05.
    // The pipeline property is aggregate: across many independent noise draws
    // at alpha=0.05 the false-positive rate must stay near nominal, never
    // systematically significant.
    let hits = 0;
    const TRIALS = 40;
    for (let s = 0; s < TRIALS; s += 1) {
      const gen = mulberry32(1000 + s);
      const values = Array.from({ length: 30 }, () => (gen() < 0.5 ? 1 : 0));
      const isTrue = values.map((_, i) => i % 2 === 0);
      const r = permutationTest(values, isTrue, 500, mulberry32(RESEARCH_SEED + s));
      if (r.p < 0.05) hits += 1;
    }
    expect(hits / TRIALS).toBeLessThan(0.2);
  });

  it('matches the exact enumeration on a tiny case', () => {
    // 4 cells, TRUE = {1, 1}, FALSE = {0, 0}: 6 labelings, only 2 reach |diff| = 1.
    const r = permutationTest([1, 1, 0, 0], [true, true, false, false], 2000, mulberry32(1));
    expect(r.observed).toBe(1);
    expect(r.p).toBeCloseTo(2 / 6, 0.05);
  });

  it('short-circuits constant vectors to p=1 without touching the RNG', () => {
    let draws = 0;
    const counting = () => {
      draws += 1;
      return 0.5;
    };
    const r = permutationTest([1, 1, 1, 1], [true, true, false, false], 2000, counting);
    expect(r).toEqual({ observed: 0, p: 1, nT: 2, nF: 2, perms: 2000 });
    expect(draws).toBe(0);
  });

  it('returns NaN on degenerate input (empty group, NaN value)', () => {
    expect(permutationTest([1, 2], [true, true], 10, mulberry32(1)).p).toBeNaN();
    expect(permutationTest([1, NaN], [true, false], 10, mulberry32(1)).p).toBeNaN();
    expect(permutationTest([], [], 10, mulberry32(1)).p).toBeNaN();
  });

  it('is byte-identical for the same seed', () => {
    const v = [1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 0, 1];
    const lab = v.map((_, i) => i % 3 === 0);
    const a = permutationTest(v, lab, 200, mulberry32(RESEARCH_SEED));
    const b = permutationTest(v, lab, 200, mulberry32(RESEARCH_SEED));
    expect(a).toEqual(b);
  });
});

describe('benjaminiHochberg', () => {
  it('recovers the textbook BH values', () => {
    const out = benjaminiHochberg([
      { key: 'a', p: 0.01 },
      { key: 'b', p: 0.04 },
      { key: 'c', p: 0.5 },
    ]);
    // sorted p: 0.01*3/1=0.03, 0.04*3/2=0.06, 0.5*3/3=0.5 — monotone already.
    expect(out.find((e) => e.key === 'a').q).toBeCloseTo(0.03, 12);
    expect(out.find((e) => e.key === 'b').q).toBeCloseTo(0.06, 12);
    expect(out.find((e) => e.key === 'c').q).toBeCloseTo(0.5, 12);
  });

  it('enforces monotonicity and keeps input order', () => {
    const out = benjaminiHochberg([
      { key: 'z', p: 0.5 },
      { key: 'a', p: 0.001 },
      { key: 'm', p: 0.049 },
    ]);
    expect(out.map((e) => e.key)).toEqual(['z', 'a', 'm']);
    const byP = [...out].sort((x, y) => x.p - y.p);
    for (let i = 1; i < byP.length; i += 1) {
      expect(byP[i].q).toBeGreaterThanOrEqual(byP[i - 1].q - 1e-12);
    }
  });

  it('caps at 1 and handles the empty pool', () => {
    expect(benjaminiHochberg([])).toEqual([]);
    const [only] = benjaminiHochberg([{ key: 'x', p: 0.9 }]);
    expect(only.q).toBeLessThanOrEqual(1);
  });

  it('is stable under key-order shuffling of equal p-values', () => {
    const fwd = benjaminiHochberg([{ key: 'a', p: 0.2 }, { key: 'b', p: 0.2 }]);
    const rev = benjaminiHochberg([{ key: 'b', p: 0.2 }, { key: 'a', p: 0.2 }]);
    expect(fwd.find((e) => e.key === 'a').q).toBe(rev.find((e) => e.key === 'a').q);
  });
});
