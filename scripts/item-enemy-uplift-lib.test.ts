import { describe, it, expect } from 'vitest';
import {
  N_PERMUTATIONS, RESEARCH_SEED, SUPPORT, UPLIFT_VERDICTS,
  mulberry32, benjaminiHochberg,
  slotObservations, weightedBaseline, rawUplift, hpPriorStrength, shrinkRate,
  clopperPearson, upliftPermutationTest, stratifiedPermutationTrace,
  supportTier, splitHalf,
  eligibleHpSet, positionGateDropReason,
  decideUpliftVerdict,
} from './item-enemy-uplift-lib.mjs';

describe('constants', () => {
  it('fixes the TZ-mandated design parameters', () => {
    expect(N_PERMUTATIONS).toBe(2000);
    expect(RESEARCH_SEED).toBe(20261006);
    expect(SUPPORT.PRIMARY).toBe(100);
    expect(SUPPORT.EXPLORATORY).toBe(30);
  });
});

describe('slotObservations', () => {
  const slot = (over = {}) => ({
    matchId: 1, heroId: 1, position: '1', isRadiant: true,
    inventory: [100, 101], foes: [2, 3, 4, 5, 6], ...over,
  });
  it('emits one observation per (enemy, owned item) — never per purchase event', () => {
    const { observations, dropped } = slotObservations(slot({ inventory: [100, 100, 101] }));
    expect(dropped).toBe(null);
    // Duplicate item 100 collapses: 2 items x 5 enemies = 10 observations.
    expect(observations).toHaveLength(10);
    expect(observations.filter((o) => o.itemId === 100)).toHaveLength(5);
    expect(observations.filter((o) => o.itemId === 101)).toHaveLength(5);
  });
  it('is fail-closed on incomplete slots (no imputation)', () => {
    expect(slotObservations(slot({ foes: [2] })).dropped).not.toBe(null);
    expect(slotObservations(slot({ inventory: null })).dropped).not.toBe(null);
  });
  it('keeps the mirror case as a legal observation (no exclusion)', () => {
    const { observations, dropped } = slotObservations(slot({ heroId: 7, foes: [7, 8, 9, 10, 11] }));
    expect(dropped).toBe(null);
    expect(observations.some((o) => o.enemyHeroId === 7)).toBe(true);
  });
  it('dedupes enemies and orders deterministically', () => {
    const a = slotObservations(slot({ foes: [6, 5, 4, 3, 2] })).observations;
    const b = slotObservations(slot({ foes: [2, 3, 4, 5, 6] })).observations;
    expect(a).toEqual(b);
  });
});

describe('weightedBaseline', () => {
  it('weights by the exposed composition, not the global mean', () => {
    // Background: carry buys 80%, support buys 0%. Exposed mix is all carries.
    const hpRate = new Map([['1|1', 0.8], ['2|5', 0.0]]);
    const exp = weightedBaseline([{ hp: '1|1' }, { hp: '1|1' }], hpRate);
    expect(exp.expected).toBeCloseTo(0.8, 12);
    expect(exp.covered).toBe(2);
    expect(exp.n).toBe(2);
  });
  it('returns NaN when no background covers the composition', () => {
    expect(weightedBaseline([{ hp: '9|1' }], new Map()).expected).toBeNaN();
  });
});

describe('rawUplift + shrinkage + interval', () => {
  it('computes raw delta/lift and shrinks small-N toward the baseline', () => {
    const u = rawUplift(7, 17, 0.1);
    expect(u.delta).toBeCloseTo(7 / 17 - 0.1, 12);
    // TZ example: N=17, raw +31pp collapses under a prior of strength 60.
    const s = shrinkRate(7, 17, 0.1, 60);
    expect(Math.abs(s.shrunkDelta)).toBeLessThan(Math.abs(u.delta));
    // TZ example: N=240 barely moves.
    const big = shrinkRate(74, 240, 0.1, 60);
    expect(big.shrunk).toBeCloseTo(74 / 240, 1);
  });
  it('hpPriorStrength clamps to [8, 200] and flags degenerate input', () => {
    expect(hpPriorStrength([]).m0).toBe(8);
    expect(hpPriorStrength([0.5]).note).toBe('DEGENERATE_PRIOR');
    const { m0 } = hpPriorStrength([0.1, 0.2, 0.15, 0.3, 0.12, 0.18]);
    expect(m0).toBeGreaterThanOrEqual(8);
    expect(m0).toBeLessThanOrEqual(200);
  });
  it('clopperPearson brackets the rate without normal approximation', () => {
    const { lo, hi } = clopperPearson(5, 10);
    expect(lo).toBeLessThan(0.5);
    expect(hi).toBeGreaterThan(0.5);
    expect(lo).toBeGreaterThan(0.15);
    expect(hi).toBeLessThan(0.85);
    expect(clopperPearson(0, 10).lo).toBe(0);
    expect(clopperPearson(10, 10).hi).toBe(1);
    expect(clopperPearson(0, 0).lo).toBeNaN();
  });
  it('supportTier gates inference', () => {
    expect(supportTier(17)).toBe('EXCLUDED');
    expect(supportTier(50)).toBe('EXPLORATORY_LOW_SUPPORT');
    expect(supportTier(240)).toBe('PRIMARY');
  });
  it('splitHalf is deterministic on match parity', () => {
    expect(splitHalf(100)).toBe('A');
    expect(splitHalf(101)).toBe('B');
  });
});

describe('noise control (Hero x Position-stratified permutation + BH)', () => {
  // Two strata with different rates and different exposed shares — the
  // shape that let composition leak under the old POOLED permutation.
  const stratumA = {
    values: [1, 1, 0, 1, 0, 0, 1, 0, 0, 1],
    isExposed: [true, true, true, false, false, false, false, false, false, false],
    baseline: 0.5,
  };
  const stratumB = {
    values: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
    isExposed: [true, false, false, false, false, true, true, true, false, false],
    baseline: 0.3,
  };

  /** Pre-audit POOLED permutation — test-local reference the regression
   *  must beat; never used in production code. */
  const pooledPermutation = (values, isExposed, nPerms, rng) => {
    const n = values.length;
    const nE = isExposed.filter(Boolean).length;
    const nB = n - nE;
    const total = values.reduce((a, b) => a + b, 0);
    let eSum = 0;
    for (let i = 0; i < n; i += 1) if (isExposed[i]) eSum += values[i];
    const observed = Math.abs(eSum / nE - (total - eSum) / nB);
    let ge = 0;
    for (let r = 0; r < nPerms; r += 1) {
      const work = Array.from({ length: n }, (_, i) => i);
      for (let i = 0; i < nE; i += 1) {
        const j = i + Math.floor(rng() * (n - i));
        [work[i], work[j]] = [work[j], work[i]];
      }
      let s = 0;
      for (let i = 0; i < nE; i += 1) s += values[work[i]];
      if (Math.abs(s / nE - (total - s) / nB) >= observed - 1e-12) ge += 1;
    }
    return { observed, p: (ge + 1) / (nPerms + 1) };
  };

  it('permutation + BH machinery is deterministic for the same seed', () => {
    const a = upliftPermutationTest([stratumA, stratumB], 200, mulberry32(RESEARCH_SEED));
    const b = upliftPermutationTest([stratumA, stratumB], 200, mulberry32(RESEARCH_SEED));
    expect(a.p).toBe(b.p);
    expect(a.observed).toBe(b.observed);
    const q = benjaminiHochberg([{ key: 'x', p: a.p }]);
    expect(q[0].q).toBeGreaterThanOrEqual(q[0].p);
  });

  it('constant strata short-circuit to p=1 without consuming RNG', () => {
    let calls = 0;
    const rng = () => {
      calls += 1;
      return 0.5;
    };
    const r = upliftPermutationTest(
      [{ values: [1, 1, 1, 1], isExposed: [true, true, false, false], baseline: 1 }],
      50, rng,
    );
    expect(r.p).toBe(1);
    expect(r.observed).toBe(0);
    expect(calls).toBe(0);
  });

  it('No.37 REGRESSION: every permutation preserves each stratum exposed count', () => {
    const trace = stratifiedPermutationTrace(
      [stratumA, stratumB], 200, mulberry32(RESEARCH_SEED),
    );
    expect(trace.exposedCounts).toHaveLength(200);
    // stratumA has 3 exposed, stratumB has 4. A POOLED shuffle could move
    // labels between Hero x Position strata and break these counts;
    // stratified permutation must preserve them in EVERY draw.
    for (const counts of trace.exposedCounts) expect(counts).toEqual([3, 4]);
    expect(trace.p).toBeGreaterThan(0);
    expect(trace.p).toBeLessThanOrEqual(1);
  });

  it('No.37 REGRESSION: pooled null differs from stratified on composition confound', () => {
    // Simpson-style input: exposed concentrated in the high-rate stratum,
    // background in the low-rate one; WITHIN each stratum exposed == background,
    // so there is no enemy effect at all — only composition.
    const high = {
      values: Array(10).fill(1),
      isExposed: [...Array(8).fill(true), ...Array(2).fill(false)],
      baseline: 1,
    };
    const low = {
      values: Array(10).fill(0),
      isExposed: [...Array(2).fill(true), ...Array(8).fill(false)],
      baseline: 0,
    };
    const strat = upliftPermutationTest([high, low], 2000, mulberry32(RESEARCH_SEED));
    expect(strat.observed).toBe(0); // composition fully explained by baselines
    expect(strat.p).toBe(1); // stratified: no false positive
    const pooled = pooledPermutation(
      [...high.values, ...low.values],
      [...high.isExposed, ...low.isExposed],
      2000, mulberry32(RESEARCH_SEED),
    );
    expect(pooled.p).toBeLessThan(0.05); // old behaviour: composition leaks
  });

  it('identity: random within-stratum labelling produces no systematic significance', () => {
    const rng = mulberry32(RESEARCH_SEED);
    const values = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? 1 : 0));
    const base = values.map((_, i) => i < 30);
    let sig = 0;
    for (let t = 0; t < 20; t += 1) {
      // Random null labelling inside the same stratum.
      const perm = [...base];
      for (let i = perm.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [perm[i], perm[j]] = [perm[j], perm[i]];
      }
      const { p } = upliftPermutationTest(
        [{ values, isExposed: perm, baseline: 0.5 }], 200, mulberry32(t + 1),
      );
      if (p < 0.05) sig += 1;
    }
    expect(sig).toBeLessThan(5);
  });
});

describe('position production gate (No.37 blocker)', () => {
  const positions = {
    '1': { positions: { '1': { share: 0.5, games: 1000 }, '5': { share: 0.01, games: 100 } } },
    '2': { positions: { '2': { share: 0.5, games: 100 } } }, // games too low
    '3': { positions: { '3': { share: 0.01, games: 1000 } } }, // share too low
  };

  it('builds the catalogue gate verbatim: share >= 8% AND games >= 500', () => {
    const set = eligibleHpSet(positions);
    expect(set.has('1|1')).toBe(true);
    expect(set.has('1|5')).toBe(false);
    expect(set.has('2|2')).toBe(false); // share ok, games 100 < 500
    expect(set.has('3|3')).toBe(false); // games ok, share 1% < 8%
  });

  it('drops ineligible Hero x Position BEFORE exposure/baseline/inference can see it', () => {
    const set = eligibleHpSet(positions);
    // Eligible slot passes the gate; every ineligible Hero x Position
    // returns a drop reason, so the slot never enters the buildSlots
    // output — and exposure, hpRate, weighted baseline and permutation
    // strata are built ONLY from that output. An ineligible slot therefore
    // cannot reach any of them.
    expect(positionGateDropReason(set, 1, '1')).toBe(null);
    expect(positionGateDropReason(set, 1, '5')).toBe('POSITION_NOT_ELIGIBLE');
    expect(positionGateDropReason(set, 999, '1')).toBe('POSITION_NOT_ELIGIBLE');
  });

  it('fails closed when the gate set itself is missing', () => {
    expect(positionGateDropReason(null, 1, '1')).toBe('POSITION_GATE_MISSING');
    expect(positionGateDropReason(undefined, 1, '1')).toBe('POSITION_GATE_MISSING');
  });
});

describe('decideUpliftVerdict', () => {
  it('SPARSE when no primary cell reaches support', () => {
    expect(decideUpliftVerdict({ primaryCells: 0 })).toBe(UPLIFT_VERDICTS.SPARSE);
  });
  it('FEASIBLE only with stable FDR-controlled hits', () => {
    expect(decideUpliftVerdict({ primaryCells: 10, stableHits: 2 })).toBe(UPLIFT_VERDICTS.FEASIBLE);
  });
  it('SPOTTY for exploratory-only signals', () => {
    expect(decideUpliftVerdict({ primaryCells: 10, exploratoryHits: 3 })).toBe(UPLIFT_VERDICTS.SPOTTY);
  });
  it('ABSENT when coverage is adequate and nothing survives', () => {
    expect(decideUpliftVerdict({ primaryCells: 10 })).toBe(UPLIFT_VERDICTS.ABSENT);
  });
});
