/**
 * Item statistics feature tests (ТЗ №13 §27, relocated by ТЗ №14 §24).
 *
 * Pure-function tests on synthetic inputs. The two that matter most are the
 * ones that pin a research finding rather than a convention:
 *  - `purchaseEventsPerGame(130, 100) === 1.3` — events, not a rate (§3)
 *  - shrinkage actually pulls a thin cell toward the baseline (§6), which the
 *    production data never exercises because no multi-item cell is thin.
 */
import { describe, expect, it } from 'vitest';
import {
  eventShare, histogramStats, histogramTotal, positionLift, purchaseEventsPerGame,
  purchaseWinRate, scoreEventShare, scoreLift, scoreRawIntensity, smoothedIntensity, supportWeight,
} from './itemStats';

describe('purchaseEventsPerGame — events, never a rate (§3)', () => {
  it('exceeds 1 when a hero buys more events than games', () => {
    expect(purchaseEventsPerGame(130, 100)).toBeCloseTo(1.3, 10);
  });

  it('is 0 without a denominator rather than Infinity or NaN', () => {
    expect(purchaseEventsPerGame(130, 0)).toBe(0);
    expect(purchaseEventsPerGame(0, 0)).toBe(0);
    expect(purchaseEventsPerGame(130, undefined as unknown as number)).toBe(0);
  });
});

describe('eventShare — share of the hero’s own events (§4B)', () => {
  it('is a fraction of the hero-position total', () => {
    expect(eventShare(250, 1000)).toBeCloseTo(0.25, 10);
  });

  it('is 0 when the hero has no events at all', () => {
    expect(eventShare(0, 0)).toBe(0);
    expect(eventShare(100, 0)).toBe(0);
  });
});

describe('purchaseWinRate — a diagnostic, and a bounded fraction (§4D)', () => {
  it('is wins among purchases', () => {
    expect(purchaseWinRate(50, 100)).toBeCloseTo(0.5, 10);
  });
  it('is 0 with no purchases', () => {
    expect(purchaseWinRate(0, 0)).toBe(0);
  });
});

describe('histogramStats — timing features (§7)', () => {
  it('sums the histogram', () => {
    expect(histogramTotal({ 0: 10, 5: 20, 30: 5 })).toBe(35);
  });

  it('returns a zeroed shape for an empty histogram', () => {
    const s = histogramStats({});
    expect(s.total).toBe(0);
    expect(s.medianMinute).toBeNull();
    expect(s.earlyShare).toBe(0);
    expect(histogramStats(undefined).total).toBe(0);
  });

  it('computes an exact mean and quantiles inside the bucket interval', () => {
    // 100 events at minute 10, 100 at minute 20.
    const s = histogramStats({ 10: 100, 20: 100 });
    expect(s.total).toBe(200);
    expect(s.meanMinute).toBeCloseTo(15, 10);
    // The median falls in the minute-10 bucket; we report a point inside it,
    // not a false claim of exact minute precision.
    expect(s.medianMinute).toBeGreaterThanOrEqual(10);
    expect(s.medianMinute).toBeLessThan(20);
  });

  it('splits the exploratory 0-10 / 10-20 / 20-30 / 30+ buckets', () => {
    const s = histogramStats({ 5: 10, 15: 20, 25: 30, 40: 40 });
    expect(s.earlyShare).toBeCloseTo(0.1, 10);
    expect(s.midShare).toBeCloseTo(0.2, 10);
    expect(s.lateShare).toBeCloseTo(0.3, 10);
    expect(s.veryLateShare).toBeCloseTo(0.4, 10);
  });

  it('ignores non-numeric and zero-count buckets', () => {
    // The data is typed `Record<number, number>`, so malformed keys have to be
    // forced in from an unknown source — which is exactly the runtime case
    // histogramStats has to survive.
    const dirty = { 10: 5, 20: 0, 30: 5, bad: 99, nan: Number.NaN } as unknown as Record<number, number>;
    const s = histogramStats(dirty);
    expect(s.total).toBe(10);
    expect(s.meanMinute).toBeCloseTo(20, 10);
  });
});

describe('smoothedIntensity — shrinkage toward the baseline (§6)', () => {
  it('reproduces the raw intensity when the cell dominates alpha', () => {
    // 1000 events over 10000 games, baseline 0.1, alpha=10: the cell is
    // overwhelmingly its own evidence.
    expect(smoothedIntensity(1000, 10000, 0.1, 10)).toBeGreaterThan(0.099);
  });

  it('pulls a thin cell hard toward the baseline', () => {
    // 10 events over 12 games is a high raw intensity on almost no evidence.
    const raw = purchaseEventsPerGame(10, 12);
    const shrunk = smoothedIntensity(10, 12, 0.1, 100);
    expect(raw).toBeCloseTo(10 / 12, 10);
    expect(shrunk).toBeCloseTo((10 + 100 * 0.1) / 112, 10);
    expect(shrunk).toBeLessThan(raw);
  });

  it('shrinks monotonically as alpha grows', () => {
    const a = smoothedIntensity(10, 12, 0.1, 10);
    const b = smoothedIntensity(10, 12, 0.1, 100);
    const c = smoothedIntensity(10, 12, 0.1, 500);
    expect(b).toBeLessThan(a);
    expect(c).toBeLessThan(b);
    // Tends toward the baseline, not instantly: at alpha=500 the cell's own 10
    // events still carry (12 / 512) of the weight, so the result is 0.117, not
    // 0.1. Shrinkage is a guard against noise, not a replacement for evidence.
    expect(c).toBeCloseTo((10 + 500 * 0.1) / (12 + 500), 10);
    expect(c).toBeGreaterThan(0.1);
  });

  it('falls back to the baseline when there is no denominator at all', () => {
    expect(smoothedIntensity(0, 0, 0.25, 10)).toBeCloseTo(0.25, 10);
  });
});

describe('positionLift — hero affinity vs the population (§5 Model C)', () => {
  it('is 1 when the hero matches the population', () => {
    expect(positionLift(0.5, 0.5, 0)).toBeCloseTo(1, 10);
  });

  it('is >1 for a hero-specific item and <1 for a universal one', () => {
    expect(positionLift(1.0, 0.25, 0)).toBeCloseTo(4, 10);
    expect(positionLift(0.25, 1.0, 0)).toBeCloseTo(0.25, 10);
  });

  it('stays finite when the item is globally unbought', () => {
    const lift = positionLift(0.5, 0, 0.01);
    expect(Number.isFinite(lift)).toBe(true);
    expect(lift).toBeLessThan(100);
  });
});

describe('scores', () => {
  it('Model A compresses the heavy tail', () => {
    expect(scoreRawIntensity(1)).toBeCloseTo(Math.log(2), 10);
    expect(scoreRawIntensity(1.3)).toBeGreaterThan(scoreRawIntensity(0.5));
    expect(scoreRawIntensity(-1)).toBe(0);
  });

  it('Model B is log1p of the share', () => {
    expect(scoreEventShare(0.25)).toBeCloseTo(Math.log1p(0.25), 10);
    expect(scoreEventShare(-0.1)).toBe(0);
  });

  it('Model C reads as "times the average hero"', () => {
    expect(scoreLift(4)).toBeCloseTo(2, 10);
    expect(scoreLift(1)).toBe(0);
    expect(scoreLift(0.5)).toBeCloseTo(-1, 10);
    expect(scoreLift(0)).toBe(0);
    expect(scoreLift(Number.NaN)).toBe(0);
  });

  it('support weight is monotone and zero without purchases', () => {
    expect(supportWeight(0)).toBe(0);
    expect(supportWeight(1000)).toBeGreaterThan(supportWeight(100));
  });
});
