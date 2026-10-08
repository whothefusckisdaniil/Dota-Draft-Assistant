import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  RESEARCH_SEED, N_BOOTSTRAP, RECALL_K, TRAIN_GATE, MIN_TEST_DISTINCT_ITEMS,
  MIN_PRIMARY_CELLS, ITEM_PRIOR_PARAMS, BACKTEST_VERDICTS,
  INSUFFICIENT_TEST_SUPPORT, INSUFFICIENT_FOLD,
  aggregateTrain, trainEligibleCells, buildLaneBaselines,
  fullItemPriorRanking, eventsPerGameRanking, positionGlobalRanking,
  recallAtK, eventWeightedRecall, ndcgAtK, novelItemRate,
  aggregateFoldMetrics, pairedBootstrap, decideBacktestVerdict,
} from './item-prior-backtest-lib.mjs';
import { getItemPrior, ITEM_PRIOR_PARAMS as PROD_PARAMS } from '../src/scoring/itemPrior';

const cell = (purchases: number, heroGames: number, wins = 0) => ({
  purchases, wins, heroGames, byMinute: { '1': purchases }, instances: { '0': purchases },
});

describe('constants (fixed BEFORE the run)', () => {
  it('pins the TZ-mandated design parameters', () => {
    expect(RESEARCH_SEED).toBe(20261006);
    expect(N_BOOTSTRAP).toBe(2000);
    expect(RECALL_K).toEqual([5, 10, 15]);
    expect(TRAIN_GATE).toEqual({ minShare: 0.08, minGames: 500 });
    expect(MIN_TEST_DISTINCT_ITEMS).toBe(3);
    expect(MIN_PRIMARY_CELLS).toBe(30);
    expect(INSUFFICIENT_TEST_SUPPORT).toBe('INSUFFICIENT_TEST_SUPPORT');
    expect(INSUFFICIENT_FOLD).toBe('INSUFFICIENT_FOLD');
  });
  it('freezes the production formula verbatim (ТЗ №14 §4)', () => {
    expect(ITEM_PRIOR_PARAMS).toEqual({ ...PROD_PARAMS });
    expect(ITEM_PRIOR_PARAMS.wIntensity + ITEM_PRIOR_PARAMS.wEventShare + ITEM_PRIOR_PARAMS.wLift).toBeCloseTo(1, 12);
  });
});

describe('aggregateTrain (weeks sum exactly like production)', () => {
  const w1 = {
    itemStats: { '1': { '1': { '10': cell(10, 100, 4), '11': cell(5, 100, 1) } } },
    positions: { '1': { totalGames: 200, positions: { '1': { games: 100, share: 0.5 }, '2': { games: 100, share: 0.5 } } } },
  };
  const w2 = {
    itemStats: { '1': { '1': { '10': cell(20, 150, 9) } } },
    positions: { '1': { totalGames: 300, positions: { '1': { games: 150, share: 0.5 }, '2': { games: 150, share: 0.5 } } } },
  };
  it('sums purchases/wins/heroGames/games across weeks — never averages', () => {
    const { itemStats, games } = aggregateTrain([w1, w2]);
    expect(itemStats['1']['1']['10']).toMatchObject({ purchases: 30, wins: 13, heroGames: 250 });
    expect(itemStats['1']['1']['10'].byMinute['1']).toBe(30);
    expect(itemStats['1']['1']['11'].purchases).toBe(5);
    expect(games.get('1:1')).toBe(250);
    expect(games.get('1:2')).toBe(250);
  });
});

describe('trainEligibleCells (production gate on TRAIN only)', () => {
  const games = new Map([['1:1', 900], ['1:2', 100], ['2:1', 400], ['2:2', 600]]);
  it('requires BOTH share >= 8% and games >= 500', () => {
    const cells = trainEligibleCells(games);
    const by = (k: string) => cells.find((c) => `${c.heroId}:${c.position}` === k)!;
    expect(by('1:1').eligible).toBe(true); // share 0.9, games 900
    expect(by('1:2').eligible).toBe(false); // share 0.1 passes, but games 100 < 500
    expect(by('2:1').eligible).toBe(false); // games 400 < 500
    expect(by('2:2').eligible).toBe(true); // share 0.6, games 600
    expect(by('1:2').share).toBeCloseTo(0.1, 12);
  });
  it('a hero-position absent from the TRAIN games map produces no cell (fail-closed)', () => {
    const cells = trainEligibleCells(new Map([['7:1', 1000]]));
    expect(cells.some((c) => c.heroId === 7 && c.position === '2')).toBe(false);
  });
});

describe('rankers (TRAIN side)', () => {
  const itemStats = {
    '1': { '1': { '10': cell(100, 500), '20': cell(60, 500), '30': cell(60, 500) } },
    '2': { '1': { '10': cell(80, 500), '20': cell(10, 500) } },
  };
  it('eventsPerGameRanking orders by events/game with deterministic ties', () => {
    const rows = eventsPerGameRanking(itemStats, 1, '1');
    expect(rows.map((r) => r.itemId)).toEqual([10, 20, 30]); // 0.2 > 0.12 = 0.12, id asc
    expect(rows[0].score).toBeCloseTo(0.2, 12);
  });
  it('positionGlobalRanking pools events across ALL heroes of the lane', () => {
    const rows = positionGlobalRanking(itemStats, '1');
    expect(rows.map((r) => r.itemId)).toEqual([10, 20, 30]); // 180, 70, 60
    expect(rows[0].purchases).toBe(180);
    const tie = positionGlobalRanking({ '1': { '1': { '5': cell(50, 10) } }, '2': { '1': { '6': cell(50, 10) } } }, '1');
    expect(tie.map((r) => r.itemId)).toEqual([5, 6]); // equal totals -> itemId asc
  });
  it('fullItemPriorRanking never returns an item without heroGames evidence', () => {
    const rows = fullItemPriorRanking({ '1': { '1': { '10': cell(100, 0) } } }, buildLaneBaselines({ '1': { '1': { '10': cell(100, 0) } } }), 1, '1');
    expect(rows).toEqual([]);
  });
});

describe('TEST-side metrics', () => {
  it('recallAtK counts distinct relevant items in the top-K', () => {
    const relevant = [1, 2, 3, 4];
    expect(recallAtK([4, 5, 6, 1], relevant, 2)).toBeCloseTo(1 / 4, 12); // only 4 in top-2
    expect(recallAtK([4, 5, 6, 1], relevant, 4)).toBeCloseTo(2 / 4, 12); // 4 and 1
    expect(recallAtK([9, 8], relevant, 5)).toBe(0);
    expect(recallAtK([1], [], 5)).toBeNaN();
  });
  it('eventWeightedRecall weights by test purchase EVENTS', () => {
    const test = { 1: 10, 2: 30, 3: 60 };
    expect(eventWeightedRecall([3, 9, 1], test, 2)).toBeCloseTo(0.6, 12); // 60/100
    expect(eventWeightedRecall([3, 9, 1], test, 3)).toBeCloseTo(0.7, 12); // 60+10
    expect(eventWeightedRecall([9, 8], test, 5)).toBe(0);
    expect(eventWeightedRecall([1], {}, 5)).toBeNaN();
  });
  it('ndcgAtK: perfect order is 1, reversed is worse, linear gain on purchases', () => {
    const test = { a: 8, b: 1 };
    expect(ndcgAtK(['a', 'b'], test, 2)).toBeCloseTo(1, 12);
    const rev = ndcgAtK(['b', 'a'], test, 2);
    expect(rev).toBeLessThan(1);
    expect(rev).toBeGreaterThan(0);
    expect(ndcgAtK(['a'], {}, 5)).toBeNaN();
  });
  it('novelItemRate measures TRAIN-absent items kept in TEST as misses', () => {
    expect(novelItemRate([1, 2, 3], [3, 4, 5])).toBeCloseTo(2 / 3, 12);
    expect(novelItemRate([], [1])).toBeCloseTo(1, 12);
    expect(novelItemRate([1], [])).toBeNaN();
  });
});

describe('aggregateFoldMetrics (macro over cells)', () => {
  it('averages finite values only and counts rows', () => {
    const agg = aggregateFoldMetrics([
      { recall10: 0.5, mass10: 1, recall5: NaN, recall15: 0, ndcg10: 0.2 },
      { recall10: 0.7, mass10: 0, recall5: NaN, recall15: 1, ndcg10: 0.4 },
    ]);
    expect(agg.n).toBe(2);
    expect(agg.recall10).toBeCloseTo(0.6, 12);
    expect(agg.mass10).toBeCloseTo(0.5, 12);
    expect(agg.recall5).toBeNaN();
    expect(agg.ndcg10).toBeCloseTo(0.3, 12);
  });
});

describe('pairedBootstrap (cells resampled whole, seed fixed)', () => {
  it('is deterministic for the same seed and brackets the mean', () => {
    const deltas = [0.1, -0.05, 0.2, 0, -0.1, 0.15, 0.05, -0.02];
    const a = pairedBootstrap(deltas, { n: 500, seed: RESEARCH_SEED });
    const b = pairedBootstrap(deltas, { n: 500, seed: RESEARCH_SEED });
    expect(a).toEqual(b);
    expect(a.mean).toBeCloseTo(deltas.reduce((s, d) => s + d, 0) / deltas.length, 12);
    expect(a.lo).toBeLessThanOrEqual(a.mean);
    expect(a.hi).toBeGreaterThanOrEqual(a.mean);
    expect(a.nCells).toBe(8);
  });
  it('constant deltas collapse the CI to the point estimate; NaN pairs drop', () => {
    const r = pairedBootstrap([0.2, 0.2, 0.2, NaN], { n: 200, seed: RESEARCH_SEED });
    expect(r.nCells).toBe(3);
    expect(r.lo).toBeCloseTo(0.2, 12);
    expect(r.hi).toBeCloseTo(0.2, 12);
    expect(pairedBootstrap([], { n: 10, seed: RESEARCH_SEED }).mean).toBeNaN();
  });
});

describe('decideBacktestVerdict (pre-registered rule)', () => {
  const strong = { mean: 0.05, lo: 0.01, hi: 0.09 };
  it('INCONCLUSIVE below the minimum primary cells', () => {
    expect(decideBacktestVerdict({ primaryCells: 29, fullMinusA: strong, fullMinusB: strong }))
      .toBe(BACKTEST_VERDICTS.INCONCLUSIVE);
  });
  it('PREDICTIVE only when CI > 0 vs BOTH baselines and fold signs hold', () => {
    expect(decideBacktestVerdict({ primaryCells: 30, fullMinusA: strong, fullMinusB: strong, foldSignsNonNegative: true }))
      .toBe(BACKTEST_VERDICTS.PREDICTIVE);
    expect(decideBacktestVerdict({ primaryCells: 30, fullMinusA: strong, fullMinusB: strong, foldSignsNonNegative: false }))
      .toBe(BACKTEST_VERDICTS.MARGINAL);
  });
  it('NO_ADVANTAGE when point deltas are <= 0 vs both', () => {
    expect(decideBacktestVerdict({
      primaryCells: 30,
      fullMinusA: { mean: -0.01, lo: -0.03, hi: 0.01 },
      fullMinusB: { mean: -0.02, lo: -0.05, hi: 0.01 },
    })).toBe(BACKTEST_VERDICTS.NO_ADVANTAGE);
  });
  it('MARGINAL when improvement exists but is small or unstable', () => {
    expect(decideBacktestVerdict({
      primaryCells: 30,
      fullMinusA: { mean: 0.03, lo: 0.001, hi: 0.06 },
      fullMinusB: { mean: 0.01, lo: -0.02, hi: 0.04 },
    })).toBe(BACKTEST_VERDICTS.MARGINAL);
  });
});


describe('PARITY: backtest ranking is the frozen production ItemPrior', () => {
  // The backtest may not invent its own "full formula": on the committed
  // production dataset it must reproduce getItemPrior() — same scores, same
  // order — for EVERY (hero, position) cell. This pins the frozen artifact.
  const itemStats = JSON.parse(readFileSync('public/data/item-stats.json', 'utf8'));
  const items = JSON.parse(readFileSync('public/data/items.json', 'utf8'));
  const dataset = { items, itemStats };
  const baselines = buildLaneBaselines(itemStats);

  it('matches getItemPrior() order and score on all production cells', () => {
    const mismatches: string[] = [];
    let checked = 0;
    let scoreDiffs = 0;
    for (const [heroId, byPos] of Object.entries(itemStats as Record<string, Record<string, unknown>>)) {
      for (const pos of Object.keys(byPos)) {
        const prod = getItemPrior(dataset, Number(heroId), pos);
        const mine = fullItemPriorRanking(itemStats, baselines, Number(heroId), pos);
        checked += 1;
        if (prod.length !== mine.length
          || prod.some((p, i) => p.itemId !== mine[i].itemId)) {
          mismatches.push(`${heroId}|${pos}: order or length differs`);
          continue;
        }
        for (let i = 0; i < prod.length; i += 1) {
          if (Math.abs(prod[i].score - mine[i].score) > 1e-12) scoreDiffs += 1;
        }
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(scoreDiffs).toBe(0);
    // The committed dataset has exactly 448 (hero, position) cells —
    // verified by counting. Pin the count, not a floor.
    expect(checked).toBe(448);
  });
});

