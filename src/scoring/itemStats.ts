/**
 * Pure mathematics for the item layer (ТЗ №14 §24).
 *
 * SINGLE SOURCE OF TRUTH for the item maths, moved here from the former
 * `scripts/item-level1-model.mjs` (now deleted) in ТЗ №14 §24. Both the research
 * script and the production ItemPrior engine import it, so the quantile logic,
 * the shrinkage and the lift cannot drift apart from the formula that ships.
 *
 * It imports nothing: no React, no fetch, no config, no global state.
 */

/**
 * Exploratory timing buckets. NOT build phases and NOT gameplay phases — a
 * rough way to describe when a purchase tends to land.
 */
export const TIMING_BUCKETS = [
  { key: 'early', label: '0-10 min', from: 0, to: 10 },
  { key: 'mid', label: '10-20 min', from: 10, to: 20 },
  { key: 'late', label: '20-30 min', from: 20, to: 30 },
  { key: 'veryLate', label: '30+ min', from: 30, to: Infinity },
] as const;

export type TimingBucketKey = (typeof TIMING_BUCKETS)[number]['key'];

export interface HistogramStats {
  total: number;
  /** Exact for the bucketed data. */
  meanMinute: number | null;
  /** APPROXIMATE — a point inside the minute interval, not an exact minute. */
  medianMinute: number | null;
  /** APPROXIMATE, same caveat as medianMinute. */
  p25Minute: number | null;
  /** APPROXIMATE, same caveat as medianMinute. */
  p75Minute: number | null;
  earlyShare: number;
  midShare: number;
  lateShare: number;
  veryLateShare: number;
}

export const EMPTY_HISTOGRAM_STATS: HistogramStats = {
  total: 0,
  meanMinute: null,
  medianMinute: null,
  p25Minute: null,
  p75Minute: null,
  earlyShare: 0,
  midShare: 0,
  lateShare: 0,
  veryLateShare: 0,
};

/**
 * Purchase events per game. NOT a rate and NOT a percentage: the numerator is
 * purchase EVENTS, so >1 is normal (Anti-Mage buys Battle Fury in 130% as many
 * events as he plays carry games). 0 when there is no denominator.
 */
export function purchaseEventsPerGame(purchases: number, heroGames: number): number {
  if (!Number.isFinite(heroGames) || heroGames <= 0) return 0;
  if (!Number.isFinite(purchases) || purchases <= 0) return 0;
  return purchases / heroGames;
}

/** This item's share of ALL purchase events for this hero on this lane. */
export function eventShare(purchases: number, heroPositionTotalPurchases: number): number {
  if (!Number.isFinite(heroPositionTotalPurchases) || heroPositionTotalPurchases <= 0) return 0;
  if (!Number.isFinite(purchases) || purchases <= 0) return 0;
  return purchases / heroPositionTotalPurchases;
}

/**
 * wins / purchases — the winrate AMONG purchase events.
 *
 * NOT a causal "this item gives you X%". A hero who buys an item in minute 40
 * of a decided game inflates it; a hero saved by a teammate's item never
 * records it. Diagnostic only, never a score component.
 */
export function purchaseWinRate(wins: number, purchases: number): number {
  if (!Number.isFinite(purchases) || purchases <= 0) return 0;
  if (!Number.isFinite(wins)) return 0;
  return wins / purchases;
}

/** Sum of a purchase-minute histogram. */
export function histogramTotal(byMinute: Record<number, number> | undefined): number {
  if (!byMinute) return 0;
  return Object.values(byMinute).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
}

/**
 * Statistics over a purchase-minute histogram.
 *
 * The quantiles are APPROXIMATE by construction: the histogram is bucketed by
 * minute, so a quantile reports the point inside the interval where the
 * cumulative count crosses, instead of claiming precision the data does not
 * have. `meanMinute` is exact for the bucketed data.
 */
export function histogramStats(byMinute: Record<number, number> | undefined): HistogramStats {
  const entries = Object.entries(byMinute ?? {})
    .map(([m, n]) => [Number(m), n] as const)
    .filter(([m, n]) => Number.isFinite(m) && Number.isFinite(n) && n > 0)
    .sort((a, b) => a[0] - b[0]);

  const total = entries.reduce((s, [, n]) => s + n, 0);
  if (total === 0) return EMPTY_HISTOGRAM_STATS;

  const meanMinute = entries.reduce((s, [m, n]) => s + m * n, 0) / total;

  const quantile = (q: number): number => {
    const target = q * total;
    let cum = 0;
    let previous = 0;
    for (const [m, n] of entries) {
      if (cum + n >= target) {
        const offset = (target - cum) / n;
        return previous + (m - previous) * offset;
      }
      cum += n;
      previous = m;
    }
    return entries[entries.length - 1][0];
  };

  const shares: Record<TimingBucketKey, number> = { early: 0, mid: 0, late: 0, veryLate: 0 };
  for (const [m, n] of entries) {
    const bucket = TIMING_BUCKETS.find((x) => m >= x.from && m < x.to);
    if (bucket) shares[bucket.key] += n;
  }
  for (const k of Object.keys(shares) as TimingBucketKey[]) shares[k] /= total;

  return {
    total,
    meanMinute,
    medianMinute: quantile(0.5),
    p25Minute: quantile(0.25),
    p75Minute: quantile(0.75),
    earlyShare: shares.early,
    midShare: shares.mid,
    lateShare: shares.late,
    veryLateShare: shares.veryLate,
  };
}

/**
 * Shrink a hero's intensity toward the population baseline for the same lane:
 *
 *   smoothed = (purchases + alpha * baseline) / (heroGames + alpha)
 *
 * `alpha` counts PSEUDO-games: how strongly thin evidence is pulled toward the
 * population. It is not a probability. On the current dataset alpha barely
 * matters (even the thinnest multi-item cells hold hundreds of thousands of
 * events) — it guards a future thin-cell regime rather than tuning anything now.
 */
export function smoothedIntensity(
  purchases: number,
  heroGames: number,
  baselineIntensity: number,
  alpha: number,
): number {
  const games = Number.isFinite(heroGames) ? heroGames : 0;
  const buys = Number.isFinite(purchases) ? purchases : 0;
  const base = Number.isFinite(baselineIntensity) ? baselineIntensity : 0;
  const denom = games + alpha;
  if (denom <= 0) return base;
  return (buys + alpha * base) / denom;
}

/**
 * How much MORE this hero buys this item on this lane than the average hero
 * does on the same lane:
 *
 *   lift = (smoothed hero intensity + s) / (global intensity + s)
 *
 * The second smoothing term keeps a globally-unbought item from producing an
 * unbounded ratio. lift = 1 means "this hero buys it like the average hero".
 */
export function positionLift(
  smoothedHeroIntensity: number,
  globalPositionIntensity: number,
  smoothing = 0.01,
): number {
  const hero = Number.isFinite(smoothedHeroIntensity) ? smoothedHeroIntensity : 0;
  const global = Number.isFinite(globalPositionIntensity) ? globalPositionIntensity : 0;
  return (hero + smoothing) / (global + smoothing);
}

/** Raw intensity, log-scaled so a heavy tail does not dominate. */
export function scoreRawIntensity(eventsPerGame: number): number {
  if (!Number.isFinite(eventsPerGame) || eventsPerGame <= 0) return 0;
  return Math.log1p(eventsPerGame);
}

/** Share of the hero's own purchase events, log-scaled. */
export function scoreEventShare(share: number): number {
  if (!Number.isFinite(share) || share <= 0) return 0;
  return Math.log1p(share);
}

/** log2 of the lift, which reads directly as "times the average hero". */
export function scoreLift(lift: number): number {
  if (!Number.isFinite(lift) || lift <= 0) return 0;
  return Math.log2(lift);
}

/**
 * How much confidence a cell's own evidence deserves, on a log scale.
 * `minSamples` is a scale, not a cutoff: a thin cell is not excluded, it is
 * simply outvoted by the shrunk baseline.
 */
export function supportWeight(purchases: number, minSamples = 100): number {
  if (!Number.isFinite(purchases) || purchases <= 0) return 0;
  return Math.log1p(purchases / minSamples);
}

