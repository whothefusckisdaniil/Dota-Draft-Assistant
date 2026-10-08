/**
 * TZ No.38 — ItemPrior temporal backtest math (pure, deterministic).
 *
 * Question: does getItemPrior(hero, position) predict FUTURE purchases of
 * the same Hero x Position, or only describe the snapshot it was built on?
 *
 * Leakage rule (hard): everything — baselines, item ranking, position
 * eligibility (share >= 8%, games >= 500), heroGames — is computed on TRAIN
 * weeks ONLY. The TEST week is touched exclusively by the metric functions.
 *
 * Vocabulary: STRATZ counts purchase EVENTS, never ownership. Every metric
 * says "purchases" or "events", never "games that bought it".
 *
 * The production formula (alpha, lift smoothing, 0.6/0.2/0.2) is a FROZEN
 * artifact — replicated here verbatim and parity-tested against
 * src/scoring/itemPrior.ts. Never tuned on TEST. EB internals are not
 * touched either (documented limitation).
 *
 * Reused by import, never re-implemented: mulberry32 (No.36 library).
 */
import { mulberry32 } from './capability-item-prior-lib.mjs';

export { mulberry32 };

/** TZ Sec.6 — bootstrap seed. No Math.random() anywhere in this pipeline. */
export const RESEARCH_SEED = 20261006;
/** TZ Sec.5 — paired bootstrap resamples over Hero x Position cells. */
export const N_BOOTSTRAP = 2000;
/** TZ Sec.3 — recall cutoffs, fixed before the run. */
export const RECALL_K = Object.freeze([5, 10, 15]);
/** TZ Sec.4 — production position gate, computed on TRAIN only. */
export const TRAIN_GATE = Object.freeze({ minShare: 0.08, minGames: 500 });
/**
 * TZ Sec.4 — a TEST cell needs >= 3 distinct observed items so Recall@K is
 * not trivially 1/1. A measurement floor, not a model hypothesis; fixed
 * before any result was seen.
 */
export const MIN_TEST_DISTINCT_ITEMS = 3;
/**
 * TZ Sec.7 — frozen production formula (ТЗ №14 §4 / ITEM_PRIOR_PARAMS).
 * Copied, not imported, because this is a .mjs research pipeline; the
 * parity test pins it to src/scoring/itemPrior.ts.
 */
export const ITEM_PRIOR_PARAMS = Object.freeze({
  alpha: 100,
  liftSmoothing: 0.01,
  wIntensity: 0.6,
  wEventShare: 0.2,
  wLift: 0.2,
});
/** TZ Sec.6 — below this many primary cells the corpus cannot carry a verdict. */
export const MIN_PRIMARY_CELLS = 30;

export const BACKTEST_VERDICTS = {
  PREDICTIVE: 'ITEM_PRIOR_PREDICTIVE',
  MARGINAL: 'ITEM_PRIOR_MARGINAL',
  NO_ADVANTAGE: 'ITEM_PRIOR_NO_ADVANTAGE',
  INCONCLUSIVE: 'ITEM_PRIOR_INCONCLUSIVE',
};

export const INSUFFICIENT_TEST_SUPPORT = 'INSUFFICIENT_TEST_SUPPORT';
export const INSUFFICIENT_FOLD = 'INSUFFICIENT_FOLD';

/* ── week aggregation (TRAIN side) ──────────────────────────────────── */

const emptyCell = () => ({ purchases: 0, wins: 0, heroGames: 0, byMinute: {}, instances: {} });

/**
 * Sum per-week caches into one TRAIN window. Mirrors the production
 * generator exactly: purchases/wins/byMinute/instances add up, heroGames
 * ADD across weeks (production heroGames is the position-layer game count
 * summed over the same buckets). Never averages.
 */
export function aggregateTrain(weeks) {
  const itemStats = {};
  const games = new Map(); // `${heroId}:${position}` -> summed games
  for (const w of weeks ?? []) {
    for (const [heroId, byPos] of Object.entries(w?.itemStats ?? {})) {
      for (const [pos, byItem] of Object.entries(byPos)) {
        itemStats[heroId] ??= {};
        itemStats[heroId][pos] ??= {};
        for (const [itemId, cell] of Object.entries(byItem)) {
          const dst = (itemStats[heroId][pos][itemId] ??= emptyCell());
          dst.purchases += cell.purchases;
          dst.wins += cell.wins;
          dst.heroGames += cell.heroGames;
          for (const [m, n] of Object.entries(cell.byMinute ?? {})) dst.byMinute[m] = (dst.byMinute[m] ?? 0) + n;
          for (const [i, n] of Object.entries(cell.instances ?? {})) dst.instances[i] = (dst.instances[i] ?? 0) + n;
        }
      }
    }
    for (const [heroId, entry] of Object.entries(w?.positions ?? {})) {
      for (const [pos, cell] of Object.entries(entry?.positions ?? {})) {
        const key = `${heroId}:${pos}`;
        games.set(key, (games.get(key) ?? 0) + cell.games);
      }
    }
  }
  return { itemStats, games };
}

/**
 * TZ Sec.4 — TRAIN-side position eligibility, the production gate applied
 * to the TRAIN window only: share = games(hero, pos) / sum over positions,
 * both thresholds must hold. Cells without a games record are INELIGIBLE
 * (fail-closed, never imputed).
 */
export function trainEligibleCells(games, gate = TRAIN_GATE) {
  const totalByHero = new Map();
  for (const [key, n] of games) {
    const [heroId] = key.split(':');
    totalByHero.set(heroId, (totalByHero.get(heroId) ?? 0) + n);
  }
  const cells = [];
  for (const [key, gamesAtPos] of games) {
    const [heroId, position] = key.split(':');
    const total = totalByHero.get(heroId) ?? 0;
    const share = total > 0 ? gamesAtPos / total : 0;
    const eligible = gamesAtPos >= gate.minGames && share >= gate.minShare;
    cells.push({ heroId: Number(heroId), position, games: gamesAtPos, share, eligible });
  }
  return cells;
}

/* ── the three rankers (all computed on TRAIN only) ─────────────────── */

/** Position-lane population aggregate — exact mirror of production
 *  buildBaselines (first cell of the lane, finite heroGames > 0 only). */
export function buildLaneBaselines(itemStats) {
  const byPosition = new Map();
  for (const byPos of Object.values(itemStats ?? {})) {
    for (const [position, byItem] of Object.entries(byPos)) {
      let agg = byPosition.get(position);
      if (!agg) {
        agg = { eventsByItem: new Map(), totalHeroGames: 0 };
        byPosition.set(position, agg);
      }
      const firstCell = Object.values(byItem)[0];
      if (firstCell && Number.isFinite(firstCell.heroGames) && firstCell.heroGames > 0) {
        agg.totalHeroGames += firstCell.heroGames;
      }
      for (const [rawId, cell] of Object.entries(byItem)) {
        const itemId = Number(rawId);
        const events = Number.isFinite(cell.purchases) ? cell.purchases : 0;
        agg.eventsByItem.set(itemId, (agg.eventsByItem.get(itemId) ?? 0) + events);
      }
    }
  }
  return byPosition;
}

const scoreFull = (eventsPerGame, share, lift) => {
  const p = ITEM_PRIOR_PARAMS;
  const ev = Number.isFinite(eventsPerGame) && eventsPerGame > 0 ? Math.log1p(eventsPerGame) : 0;
  const sh = Number.isFinite(share) && share > 0 ? Math.log1p(share) : 0;
  const lf = Number.isFinite(lift) && lift > 0 ? Math.log2(lift) : 0;
  return p.wIntensity * ev + p.wEventShare * sh + p.wLift * lf;
};

/**
 * Full ItemPrior ranking — the frozen production score
 * (0.6·log1p(ev/game) + 0.2·log1p(share) + 0.2·log2(lift)) with production
 * smoothing, sorted score desc / purchases desc / itemId asc (§14 of ТЗ №14).
 * Parity-tested against getItemPrior() in the unit tests.
 */
export function fullItemPriorRanking(itemStats, baselines, heroId, position) {
  const byItem = itemStats?.[String(heroId)]?.[String(position)];
  if (!byItem) return [];
  let totalPurchases = 0;
  for (const cell of Object.values(byItem)) {
    if (Number.isFinite(cell.purchases)) totalPurchases += cell.purchases;
  }
  const agg = baselines.get(String(position));
  const rows = [];
  for (const [rawId, cell] of Object.entries(byItem)) {
    const itemId = Number(rawId);
    const heroGames = cell.heroGames;
    if (!Number.isFinite(heroGames) || heroGames <= 0) continue;
    const base = agg && agg.totalHeroGames > 0 ? (agg.eventsByItem.get(itemId) ?? 0) / agg.totalHeroGames : 0;
    const smoothed = (cell.purchases + ITEM_PRIOR_PARAMS.alpha * base) / (heroGames + ITEM_PRIOR_PARAMS.alpha);
    const lift = (smoothed + ITEM_PRIOR_PARAMS.liftSmoothing) / (base + ITEM_PRIOR_PARAMS.liftSmoothing);
    const ev = cell.purchases / heroGames;
    const share = totalPurchases > 0 ? cell.purchases / totalPurchases : 0;
    rows.push({ itemId, purchases: cell.purchases, score: scoreFull(ev, share, lift) });
  }
  rows.sort((a, b) => b.score - a.score || b.purchases - a.purchases || a.itemId - b.itemId);
  return rows;
}

/** Baseline A: Model A — purchase EVENTS per game, desc (ТЗ №13). */
export function eventsPerGameRanking(itemStats, heroId, position) {
  const byItem = itemStats?.[String(heroId)]?.[String(position)];
  if (!byItem) return [];
  const rows = [];
  for (const [rawId, cell] of Object.entries(byItem)) {
    const heroGames = cell.heroGames;
    const ev = Number.isFinite(heroGames) && heroGames > 0 ? cell.purchases / heroGames : 0;
    rows.push({ itemId: Number(rawId), purchases: cell.purchases, score: ev });
  }
  rows.sort((a, b) => b.score - a.score || b.purchases - a.purchases || a.itemId - b.itemId);
  return rows;
}

/**
 * Baseline B: position-global popularity — sum of purchase events per item
 * across ALL TRAIN heroes at this position, desc. One ranking per position,
 * the same retrieved list for every hero on that lane. Ties: itemId asc.
 */
export function positionGlobalRanking(itemStats, position) {
  const totals = new Map();
  for (const byPos of Object.values(itemStats ?? {})) {
    const byItem = byPos[String(position)];
    if (!byItem) continue;
    for (const [rawId, cell] of Object.entries(byItem)) {
      const itemId = Number(rawId);
      totals.set(itemId, (totals.get(itemId) ?? 0) + cell.purchases);
    }
  }
  const rows = [...totals].map(([itemId, purchases]) => ({ itemId, purchases, score: purchases }));
  rows.sort((a, b) => b.score - a.score || a.itemId - b.itemId);
  return rows;
}


/* ── TEST-side metrics (the TEST week enters ONLY here) ─────────────── */

/**
 * Recall@K over DISTINCT items:
 *   |topK(train ranking) ∩ observed(TEST)| / |observed(TEST)|
 * NaN when TEST observed nothing (such cells fail the support gate anyway).
 */
export function recallAtK(retrievedIds, relevantIds, k) {
  const relevant = new Set(relevantIds ?? []);
  if (relevant.size === 0) return NaN;
  const top = (retrievedIds ?? []).slice(0, k);
  let hit = 0;
  for (const id of top) if (relevant.has(id)) hit += 1;
  return hit / relevant.size;
}

/**
 * Event-weighted recall ("purchase-mass recall"):
 *   Σ test purchases of items in topK / Σ test purchases of ALL observed.
 * Weights by purchase EVENTS — deliberately not by games (events, per the
 * data contract). NaN when the test mass is 0.
 */
export function eventWeightedRecall(retrievedIds, testPurchases, k) {
  let total = 0;
  for (const n of Object.values(testPurchases ?? {})) total += n;
  if (!(total > 0)) return NaN;
  let covered = 0;
  for (const id of (retrievedIds ?? []).slice(0, k)) {
    const n = testPurchases?.[String(id)];
    if (Number.isFinite(n) && n > 0) covered += n;
  }
  return covered / total;
}

/**
 * NDCG@K, SECONDARY by design: relevance = test purchase count with LINEAR
 * gain (rel / log2(rank+1)), IDCG from the ideal order of the same test
 * relevances. Repeat-heavy cheap items can inflate it — never the only
 * verdict input.
 */
export function ndcgAtK(retrievedIds, testPurchases, k) {
  const rel = (id) => {
    const n = testPurchases?.[String(id)];
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const allRel = Object.values(testPurchases ?? {}).filter((n) => Number.isFinite(n) && n > 0);
  if (allRel.length === 0) return NaN;
  let dcg = 0;
  const top = (retrievedIds ?? []).slice(0, k);
  for (let i = 0; i < top.length; i += 1) dcg += rel(top[i]) / Math.log2(i + 2);
  const ideal = allRel.sort((a, b) => b - a).slice(0, k);
  let idcg = 0;
  for (let i = 0; i < ideal.length; i += 1) idcg += ideal[i] / Math.log2(i + 2);
  return idcg > 0 ? dcg / idcg : NaN;
}

/**
 * Novel-item rate: share of DISTINCT test-observed items the TRAIN prior
 * physically could not have ranked (absent from the TRAIN cell). Those
 * items are NEVER removed from TEST — they are misses; a high rate means
 * temporal drift, not a ranking failure. NaN when nothing was observed.
 */
export function novelItemRate(trainItemIds, testItemIds) {
  const test = new Set(testItemIds ?? []);
  if (test.size === 0) return NaN;
  const train = new Set(trainItemIds ?? []);
  let novel = 0;
  for (const id of test) if (!train.has(id)) novel += 1;
  return novel / test.size;
}

/* ── aggregation + paired bootstrap ─────────────────────────────────── */

export const FOLD_METRIC_KEYS = Object.freeze([
  'recall5', 'recall10', 'recall15', 'mass10', 'ndcg10',
]);

/** Macro-average over cells (each Hero x Position counts once). */
export function aggregateFoldMetrics(cellRows) {
  const out = { n: 0 };
  for (const key of FOLD_METRIC_KEYS) out[key] = 0;
  const counts = { ...out, n: 0 };
  for (const row of cellRows ?? []) {
    out.n += 1;
    for (const key of FOLD_METRIC_KEYS) {
      if (Number.isFinite(row[key])) {
        out[key] += row[key];
        counts[key] += 1;
      }
    }
  }
  for (const key of FOLD_METRIC_KEYS) out[key] = counts[key] > 0 ? out[key] / counts[key] : NaN;
  return out;
}

/**
 * Paired bootstrap over Hero x Position cells: each resample takes whole
 * cells (the per-cell DELTA array — pairing is preserved by construction),
 * mean delta + 95% percentile CI (nearest-rank), N and seed fixed by TZ.
 * No normal approximation anywhere.
 */
export function pairedBootstrap(deltas, { n = N_BOOTSTRAP, seed = RESEARCH_SEED } = {}) {
  const values = (deltas ?? []).filter((d) => Number.isFinite(d));
  if (values.length === 0) return { nCells: 0, mean: NaN, lo: NaN, hi: NaN, n, seed };
  const rng = mulberry32(seed);
  const means = new Array(n);
  for (let r = 0; r < n; r += 1) {
    let s = 0;
    for (let i = 0; i < values.length; i += 1) {
      s += values[Math.floor(rng() * values.length)];
    }
    means[r] = s / values.length;
  }
  means.sort((a, b) => a - b);
  const at = (q) => means[Math.min(means.length - 1, Math.floor(q * means.length))];
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { nCells: values.length, mean, lo: at(0.025), hi: at(0.975), n, seed };
}

/* ── verdict (rule fixed BEFORE the run) ────────────────────────────── */

/**
 * Pre-registered decision order:
 *   INCONCLUSIVE  — fewer than MIN_PRIMARY_CELLS primary cells;
 *   PREDICTIVE    — 95% CI lower bound > 0 vs BOTH baselines on the primary
 *                   metric AND per-fold delta sign >= 0 in every fold that
 *                   has cells;
 *   NO_ADVANTAGE  — point delta <= 0 vs BOTH baselines;
 *   MARGINAL      — anything else (some improvement, small/unstable).
 */
export function decideBacktestVerdict({
  primaryCells = 0,
  fullMinusA,
  fullMinusB,
  foldSignsNonNegative = true,
} = {}) {
  if (!(primaryCells >= MIN_PRIMARY_CELLS)) return BACKTEST_VERDICTS.INCONCLUSIVE;
  const beatsA = Number.isFinite(fullMinusA?.lo) && fullMinusA.lo > 0;
  const beatsB = Number.isFinite(fullMinusB?.lo) && fullMinusB.lo > 0;
  if (beatsA && beatsB && foldSignsNonNegative) return BACKTEST_VERDICTS.PREDICTIVE;
  const pointA = fullMinusA?.mean ?? NaN;
  const pointB = fullMinusB?.mean ?? NaN;
  if (Number.isFinite(pointA) && Number.isFinite(pointB) && pointA <= 0 && pointB <= 0) {
    return BACKTEST_VERDICTS.NO_ADVANTAGE;
  }
  return BACKTEST_VERDICTS.MARGINAL;
}

