/**
 * Temporal eligibility helper tests (ТЗ §27).
 *
 * The distinctions worth locking down are the ones the project has got wrong
 * before: pre-horn times are DATA, not errors; presence and event counts are
 * different measures; and a presence rate can never exceed 1.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  CUTOFFS,
  MIN_SAMPLE_FOR_CONCLUSION,
  SUPPORT_FLOORS,
  aggregateItemPresence,
  classifyPurchaseTiming,
  isInWindow,
  isValidPurchaseTime,
  lateFraction,
  rankCorrelation,
  rankedRows,
  relativePurchaseTime,
  topKOverlap,
} from './public-temporal-lib.mjs';

describe('classifyPurchaseTiming — pre-horn is data, not an error (§7)', () => {
  it('treats -59s in an 1800s match as valid and early', () => {
    expect(classifyPurchaseTiming({ time: -59 }, 1800, 0.25)).toBe('pre_horn');
    expect(isInWindow({ time: -59 }, 1800, 0.25)).toBe(true);
  });

  it('places an event inside the window when time <= cutoff * duration', () => {
    expect(classifyPurchaseTiming({ time: 450 }, 1800, 0.25)).toBe('in_window');
    expect(classifyPurchaseTiming({ time: 451 }, 1800, 0.25)).toBe('after_cutoff');
  });

  it('at cutoff 1.00 every in-match event is in the window', () => {
    expect(classifyPurchaseTiming({ time: 1800 }, 1800, 1.0)).toBe('in_window');
  });

  it('excludes events after the match ended, at every cutoff', () => {
    for (const c of CUTOFFS) {
      expect(classifyPurchaseTiming({ time: 1900 }, 1800, c), `cutoff ${c}`).toBe('after_duration');
    }
  });

  it('excludes non-numeric times', () => {
    expect(classifyPurchaseTiming({ time: 'x' }, 1800, 0.5)).toBe('invalid_type');
    expect(classifyPurchaseTiming({}, 1800, 0.5)).toBe('invalid_type');
    expect(classifyPurchaseTiming(null, 1800, 0.5)).toBe('invalid_type');
  });

  it('refuses to scale when duration is zero or unknown', () => {
    expect(classifyPurchaseTiming({ time: -59 }, 0, 0.5)).toBe('pre_horn');
    expect(classifyPurchaseTiming({ time: 100 }, 0, 0.5)).toBe('no_duration');
    expect(classifyPurchaseTiming({ time: 100 }, undefined, 0.5)).toBe('no_duration');
  });
});

describe('relativePurchaseTime (§7)', () => {
  it('is a fraction of duration, negative included', () => {
    expect(relativePurchaseTime(900, 1800)).toBeCloseTo(0.5, 10);
    expect(relativePurchaseTime(-59, 1800)).toBeCloseTo(-0.03277, 4);
  });

  it('returns null rather than Infinity for a zero duration', () => {
    expect(relativePurchaseTime(100, 0)).toBeNull();
    expect(relativePurchaseTime(100, -5)).toBeNull();
  });

  it('returns null for a non-numeric time', () => {
    expect(relativePurchaseTime('100', 1800)).toBeNull();
  });
});

describe('lateFraction — cumulative post-cutoff shares (§15)', () => {
  const events = [{ time: -59 }, { time: 100 }, { time: 900 }, { time: 1700 }];
  const f = lateFraction(events, 1800);

  it('counts strictly after the cutoff', () => {
    // rel times: -0.033, 0.056, 0.500, 0.944
    expect(f[0.25]).toBeCloseTo(2 / 4, 10); // 0.500 and 0.944
    expect(f[0.5]).toBeCloseTo(1 / 4, 10);  // 0.500 is NOT strictly after 0.5
    expect(f[0.8]).toBeCloseTo(1 / 4, 10);
  });

  it('is 0 at cutoff 1.00 by definition', () => {
    expect(f[1]).toBe(0);
  });

  it('separately counts the final two minutes', () => {
    expect(f.final120).toBeCloseTo(1 / 4, 10); // 1700 > 1800-120
  });

  it('returns nulls, not zeros, for an empty sample', () => {
    const e = lateFraction([], 1800);
    expect(e[0.5]).toBeNull();
    expect(e.final120).toBeNull();
  });
});

describe('lateFraction excludes invalid timestamps from both sides (§1, §2, §3)', () => {
  // The ТЗ §26.3 fixture. Valid: -59, 100, 900, 1700. Invalid: 1900, "x".
  const events = [{ time: -59 }, { time: 100 }, { time: 900 }, { time: 1700 }, { time: 1900 }, { time: 'x' }];
  const f = lateFraction(events, 1800);

  it('counts 4 valid events and 2 excluded', () => {
    expect(f.validEvents).toBe(4);
    expect(f.excludedEvents).toBe(2);
  });

  it('does not let an after-duration event inflate the post-cutoff share', () => {
    expect(f[0.8]).toBeCloseTo(1 / 4, 10); // only 1700 — not 1/6, not 2/5
  });

  it('is exact at each cutoff, counting only valid events', () => {
    // valid rel times: -0.033, 0.056, 0.500, 0.944
    expect(f[0.25]).toBeCloseTo(2 / 4, 10); // 0.500 and 0.944
    expect(f[0.5]).toBeCloseTo(1 / 4, 10);  // 0.500 is NOT strictly after 0.5
    expect(f[0.8]).toBeCloseTo(1 / 4, 10);
  });

  it('uses the same valid denominator for final120', () => {
    // 1700 counts; 1900 is invalid, "x" is non-numeric — neither may count.
    expect(f.final120).toBeCloseTo(1 / 4, 10);
  });

  it('treats time === duration as valid', () => {
    const g = lateFraction([{ time: 1800 }], 1800);
    expect(g.validEvents).toBe(1);
    expect(g[0.8]).toBe(1); // rel 1.0 IS after 80%
    expect(g.final120).toBeCloseTo(1, 10);
  });

  it('still counts pre-horn as valid', () => {
    const g = lateFraction([{ time: -59 }, { time: 900 }], 1800);
    expect(g.validEvents).toBe(2);
  });

  it('returns nulls for an all-invalid sample rather than 0', () => {
    const g = lateFraction([{ time: 1900 }, { time: 'x' }], 1800);
    expect(g.validEvents).toBe(0);
    expect(g[0.5]).toBeNull();
    expect(g.final120).toBeNull();
  });

  it('is unaffected by a missing duration', () => {
    const g = lateFraction([{ time: 100 }, { time: 200 }], 0);
    expect(g.validEvents).toBe(0);
    expect(g[0.5]).toBeNull();
  });
});

describe('isValidPurchaseTime is the single rule (§4)', () => {
  it('accepts pre-horn and the whole match including both ends', () => {
    expect(isValidPurchaseTime(-59, 1800)).toBe(true);
    expect(isValidPurchaseTime(0, 1800)).toBe(true);
    expect(isValidPurchaseTime(1800, 1800)).toBe(true);
  });

  it('rejects past-end, non-numeric and unusable durations', () => {
    expect(isValidPurchaseTime(1801, 1800)).toBe(false);
    expect(isValidPurchaseTime('x', 1800)).toBe(false);
    expect(isValidPurchaseTime(undefined, 1800)).toBe(false);
    expect(isValidPurchaseTime(NaN, 1800)).toBe(false);
    expect(isValidPurchaseTime(100, 0)).toBe(false);
    expect(isValidPurchaseTime(100, undefined)).toBe(false);
  });
});

describe('all four views agree on one event set (§4)', () => {
  // One dataset, four interpretations. If these ever diverge again, a future
  // reader is comparing numbers that were computed on different populations.
  const duration = 1800;
  // Every event carries a key, otherwise it describes no item and cannot be
  // part of the signal — see the unkeyed case tested separately below.
  const raw = [{ time: -59 }, { time: 100 }, { time: 900 }, { time: 1700 }, { time: 1900 }, { time: 'x' }];
  const events = raw.map((e) => ({ ...e, key: 'probe' }));
  const valid = events.filter((e) => isValidPurchaseTime(e.time, duration));

  it('agrees on which events are valid', () => {
    expect(valid.map((e) => e.time)).toEqual([-59, 100, 900, 1700]);
  });

  it('agrees with classifyPurchaseTiming at the full window', () => {
    for (const e of events) {
      const c = classifyPurchaseTiming(e, duration, 1.0);
      const byClass = c === 'pre_horn' || c === 'in_window';
      expect(isValidPurchaseTime(e.time, duration)).toBe(byClass);
    }
  });

  it('agrees with isInWindow', () => {
    for (const e of events) {
      expect(isValidPurchaseTime(e.time, duration)).toBe(isInWindow(e, duration, 1.0));
    }
  });

  it('agrees with what aggregateItemPresence counted as in-window', () => {
    const a = aggregateItemPresence([{ heroId: 1, matchId: 'm1', duration, events }], 1.0);
    expect(a.inWindow).toBe(valid.length);
    expect(a.afterDuration + a.invalid).toBe(events.length - valid.length);
  });

  it('keeps the timing median on the same population as the rows', () => {
    // An unkeyed event describes no item, so it must not enter inWindow, must
    // not create a row, and must not move the median.
    const keyed = aggregateItemPresence([{ heroId: 1, matchId: 'm1', duration, events }], 1.0);
    const unkeyed = aggregateItemPresence([{
      heroId: 1, matchId: 'm1', duration, events: [...events, { time: 1750 }],
    }], 1.0);
    expect(unkeyed.inWindow).toBe(keyed.inWindow);
    expect(unkeyed.rows).toEqual(keyed.rows);
    expect(unkeyed.medianRelativeTime).toBe(keyed.medianRelativeTime);
  });

  it('agrees with what lateFraction counted as valid', () => {
    expect(lateFraction(events, duration).validEvents).toBe(valid.length);
  });

  it('gives special-item timing the same population', () => {
    // specialItems() is the same rule applied per item key.
    const shard = events.filter((e) => isValidPurchaseTime(e.time, duration));
    expect(shard).toHaveLength(4);
    const a = aggregateItemPresence([{
      heroId: 1, matchId: 'm1', duration, events: raw.map((e) => ({ ...e, key: 'moon_shard' })),
    }], 1.0);
    const row = a.rows.find((r) => r.itemId === 'moon_shard');
    expect(row.events).toBe(valid.length);
  });

  it('never lets any view report a relative time above 1', () => {
    const lf = lateFraction(events, duration);
    for (const c of CUTOFFS) expect(lf[c]).toBeLessThanOrEqual(1);
    const a = aggregateItemPresence([{ heroId: 1, matchId: 'm1', duration, events }], 1.0);
    expect(a.medianRelativeTime).toBeLessThanOrEqual(1);
    for (const r of a.rows) expect(r.medianRelativeTime).toBeLessThanOrEqual(1);
  });
});

describe('aggregateItemPresence — presence and events are different measures (§6)', () => {
  const pm = [
    // boots bought THREE times across two hero-matches: 2 presences, 3 events.
    { heroId: 1, matchId: 'm1', duration: 1800, events: [{ key: 'boots', time: -59 }, { key: 'boots', time: 300 }, { key: 'bfury', time: 200 }] },
    { heroId: 22, matchId: 'm2', duration: 1800, events: [{ key: 'boots', time: 300 }, { key: 'bfury', time: 1000 }] },
  ];

  it('counts a repeated item once per hero-match', () => {
    const a = aggregateItemPresence(pm, 0.5);
    const boots = a.rows.find((r) => r.itemId === 'boots');
    expect(boots.presenceMatches).toBe(2);
    expect(boots.events).toBe(3);
  });

  it('never reports a presence rate above 1', () => {
    const a = aggregateItemPresence(pm, 0.5);
    for (const r of a.rows) expect(r.presenceRate).toBeLessThanOrEqual(1);
  });

  it('lets events per match exceed 1 while presence does not', () => {
    const a = aggregateItemPresence(pm, 0.5);
    const boots = a.rows.find((r) => r.itemId === 'boots');
    expect(boots.eventsPerHeroMatch).toBeCloseTo(1.5, 10);
    expect(boots.presenceRate).toBeCloseTo(1, 10);
  });

  it('separates pre-horn from after-cutoff accounting', () => {
    const a = aggregateItemPresence(pm, 0.5);
    expect(a.preHorn).toBe(1);
    expect(a.afterCutoff).toBe(1); // bfury at 1000s in an 1800s match
  });

  it('drops the item entirely when the cutoff is below every event', () => {
    const a = aggregateItemPresence([{ heroId: 1, matchId: 'm1', duration: 1800, events: [{ key: 'late', time: 1700 }] }], 0.25);
    expect(a.rows).toHaveLength(0);
    expect(a.afterCutoff).toBe(1);
  });

  it('ignores events with no key but still counts them as events', () => {
    const a = aggregateItemPresence([{ heroId: 1, matchId: 'm1', duration: 1800, events: [{ time: 100 }] }], 0.5);
    expect(a.totalEvents).toBe(1);
    expect(a.rows).toHaveLength(0);
  });

  it('a support floor is a filter, not a silent drop', () => {
    const a = aggregateItemPresence(pm, 0.5);
    const floor = SUPPORT_FLOORS[0];
    const kept = a.rows.filter((r) => r.presenceMatches >= floor);
    expect(kept.length).toBeLessThanOrEqual(a.rows.length);
  });
});

describe('grain is (heroId, matchId, itemId), not (matchId, itemId) (§1)', () => {
  it('counts different heroes in the same match separately', () => {
    const rows = [
      { heroId: 1, matchId: 'm1', duration: 1800, events: [{ key: 'bfury', time: 300 }] },
      { heroId: 22, matchId: 'm1', duration: 1800, events: [{ key: 'bfury', time: 400 }] },
      { heroId: 29, matchId: 'm1', duration: 1800, events: [{ key: 'bfury', time: 500 }] },
    ];
    const a = aggregateItemPresence(rows, 1.0);
    const bfury = a.rows.find((r) => r.itemId === 'bfury');
    expect(a.heroMatches).toBe(3);
    expect(bfury.presenceMatches).toBe(3);
    expect(bfury.presenceRate).toBe(1);
  });

  it('still collapses repeated purchases by the SAME hero in the SAME match', () => {
    const rows = [{ heroId: 1, matchId: 'm1', duration: 1800, events: [{ key: 'bfury', time: 300 }, { key: 'bfury', time: 900 }] }];
    const bfury = aggregateItemPresence(rows, 1.0).rows[0];
    expect(bfury.presenceMatches).toBe(1);
    expect(bfury.events).toBe(2);
  });

  it('treats the same hero in two matches as two presences', () => {
    const rows = [
      { heroId: 1, matchId: 'm1', duration: 1800, events: [{ key: 'bfury', time: 300 }] },
      { heroId: 1, matchId: 'm2', duration: 1800, events: [{ key: 'bfury', time: 300 }] },
    ];
    expect(aggregateItemPresence(rows, 1.0).rows[0].presenceMatches).toBe(2);
  });
});

describe('identifiers are required, not guessed (§2)', () => {
  it('throws a named error for a missing matchId', () => {
    expect(() => aggregateItemPresence([{ heroId: 1, duration: 1800, events: [] }], 0.5))
      .toThrow(/no matchId/);
  });

  it('throws a named error for a missing heroId', () => {
    expect(() => aggregateItemPresence([{ matchId: 'm1', duration: 1800, events: [] }], 0.5))
      .toThrow(/no heroId/);
  });

  it('rejects a non-array', () => {
    expect(() => aggregateItemPresence(null, 0.5)).toThrow(TypeError);
  });

  it('is deterministic — no Math.random, no Date.now (§2)', async () => {
    const raw = await readFile(new URL('./public-temporal-lib.mjs', import.meta.url), 'utf8');
    // Strip comments first: prose about determinism must not fail its own check.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/Math\.random|Date\.now|new Date\(/);
  });

  it('produces identical output for identical input', () => {
    const rows = [
      { heroId: 1, matchId: 'm1', duration: 1800, events: [{ key: 'b', time: 300 }] },
      { heroId: 22, matchId: 'm2', duration: 1800, events: [{ key: 'a', time: 100 }] },
    ];
    expect(JSON.stringify(aggregateItemPresence(rows, 0.5)))
      .toBe(JSON.stringify(aggregateItemPresence(rows, 0.5)));
  });
});

describe('ties are broken deterministically (§6)', () => {
  it('orders equal rates by itemId ascending', () => {
    const rows = [
      { heroId: 1, matchId: 'm1', duration: 1800, events: [{ key: 'zeta', time: 100 }] },
      { heroId: 2, matchId: 'm2', duration: 1800, events: [{ key: 'alpha', time: 100 }] },
      { heroId: 3, matchId: 'm3', duration: 1800, events: [{ key: 'mid', time: 100 }] },
    ];
    expect(aggregateItemPresence(rows, 1.0).rows.map((r) => r.itemId)).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('gives the same top-k whatever order the input arrives in', () => {
    const events = ['boots', 'bfury', 'blink', 'wand', 'tango'];
    const mk = (order) => order.map((k, i) => ({
      heroId: i, matchId: `m${i}`, duration: 1800, events: [{ key: k, time: 100 }],
    }));
    const a = aggregateItemPresence(mk(events), 1.0).rows.map((r) => r.itemId);
    const b = aggregateItemPresence(mk([...events].reverse()), 1.0).rows.map((r) => r.itemId);
    expect(a).toEqual(b);
    expect(a).toEqual([...events].sort());
  });
});

describe('rankedRows is a total order (§1)', () => {
  it('breaks ties by itemId ascending', () => {
    // The §2 fixture: two items share 0.5, one has 0.4.
    const rows = [
      { itemId: 'c', presenceRate: 0.4 },
      { itemId: 'b', presenceRate: 0.5 },
      { itemId: 'a', presenceRate: 0.5 },
    ];
    expect(rankedRows(rows, 'presenceRate').map((r) => r.itemId)).toEqual(['a', 'b', 'c']);
  });

  it('gives the same order whatever order the input arrives in', () => {
    const rows = [
      { itemId: 'a', presenceRate: 0.5 }, { itemId: 'b', presenceRate: 0.5 }, { itemId: 'c', presenceRate: 0.4 },
    ];
    const shuffles = [[...rows], [...rows].reverse(), [rows[1], rows[2], rows[0]]];
    for (const s of shuffles) {
      expect(rankedRows(s, 'presenceRate').map((r) => r.itemId)).toEqual(['a', 'b', 'c']);
    }
  });

  it('handles a fully tied field without dropping or duplicating rows', () => {
    const rows = ['q', 'x', 'm', 'b'].map((itemId) => ({ itemId, presenceRate: 0.5 }));
    expect(rankedRows(rows, 'presenceRate').map((r) => r.itemId)).toEqual(['b', 'm', 'q', 'x']);
  });

  it('treats null as 0 so it never outranks a real value', () => {
    const rows = [{ itemId: 'z', presenceRate: null }, { itemId: 'a', presenceRate: 0.01 }];
    expect(rankedRows(rows, 'presenceRate').map((r) => r.itemId)).toEqual(['a', 'z']);
  });

  it('does not mutate its input', () => {
    const rows = [{ itemId: 'b', presenceRate: 0.5 }, { itemId: 'a', presenceRate: 0.5 }];
    rankedRows(rows, 'presenceRate');
    expect(rows.map((r) => r.itemId)).toEqual(['b', 'a']);
  });

  it('is what aggregateItemPresence already returns, so the two agree', () => {
    const pm = [
      { heroId: 1, matchId: 'm1', duration: 1800, events: [{ key: 'zzz', time: 100 }] },
      { heroId: 2, matchId: 'm2', duration: 1800, events: [{ key: 'aaa', time: 100 }] },
    ];
    const a = aggregateItemPresence(pm, 1.0);
    expect(a.rows.map((r) => r.itemId)).toEqual(rankedRows(a.rows, 'presenceRate').map((r) => r.itemId));
  });
});

describe('topKOverlap is order-independent under ties (§2)', () => {
  it('returns the same result when tied rows arrive in different orders', () => {
    const rows = [
      { itemId: 'a', presenceRate: 0.5 }, { itemId: 'b', presenceRate: 0.5 },
      { itemId: 'c', presenceRate: 0.4 }, { itemId: 'd', presenceRate: 0.4 },
    ];
    const forward = topKOverlap(rows, rows, 2);
    const shuffled = topKOverlap([...rows].reverse(), [...rows].reverse(), 2);
    expect(shuffled.overlap).toBe(forward.overlap);
    expect(shuffled.ratio).toBe(forward.ratio);
  });

  it('picks the same tied winners regardless of input order', () => {
    const mk = (order) => order.map((itemId) => ({ itemId, presenceRate: 0.5 }));
    const a = ['b', 'a', 'c', 'd'];
    const b = ['d', 'c', 'b', 'a'];
    expect(topKOverlap(mk(a), mk(b), 2).overlap).toBe(2);
  });

  it('separates stability from the crawl order that produced the rows', () => {
    // Two crawls, same values, different insertion order. A key-only sort would
    // report movement here; a total order must not.
    const x = [{ itemId: 'b', presenceRate: 0.5 }, { itemId: 'a', presenceRate: 0.5 }];
    const y = [{ itemId: 'a', presenceRate: 0.5 }, { itemId: 'b', presenceRate: 0.5 }];
    expect(topKOverlap(x, y, 1).overlap).toBe(1);
  });
});

describe('median timing only describes events inside the window (§3, §4)', () => {
  const rows = [{
    heroId: 1, matchId: 'm1', duration: 1800,
    events: [{ key: 'x', time: 100 }, { key: 'y', time: 200 }, { key: 'z', time: 1900 }],
  }];

  it('ignores a timestamp past match end', () => {
    const a = aggregateItemPresence(rows, 1.0);
    // median of 100/1800 and 200/1800 only; 1900/1800 = 1.056 must not count.
    expect(a.medianRelativeTime).toBeCloseTo((100 / 1800 + 200 / 1800) / 2, 10);
  });

  it('still counts that event in afterDuration so nothing is hidden', () => {
    expect(aggregateItemPresence(rows, 1.0).afterDuration).toBe(1);
  });

  it('does not create a row for the out-of-range item', () => {
    expect(aggregateItemPresence(rows, 1.0).rows.map((r) => r.itemId)).toEqual(['x', 'y']);
  });

  it('narrows the median as the cutoff tightens', () => {
    const a = aggregateItemPresence(rows, 0.5);
    expect(a.medianRelativeTime).toBeCloseTo((100 / 1800 + 200 / 1800) / 2, 10);
    const b = aggregateItemPresence([{
      heroId: 1, matchId: 'm1', duration: 1800,
      events: [{ key: 'x', time: 100 }, { key: 'y', time: 800 }],
    }], 0.25);
    expect(b.medianRelativeTime).toBeCloseTo(100 / 1800, 10); // only 100s is <= 25%
  });

  it('keeps pre-horn times in the median — they are real observations', () => {
    const a = aggregateItemPresence([{
      heroId: 1, matchId: 'm1', duration: 1800,
      events: [{ key: 'x', time: -59 }, { key: 'y', time: 200 }],
    }], 1.0);
    expect(a.medianRelativeTime).toBeCloseTo((-59 / 1800 + 200 / 1800) / 2, 10);
  });

  it('excludes a non-numeric time from the median and counts it as invalid', () => {
    const a = aggregateItemPresence([{
      heroId: 1, matchId: 'm1', duration: 1800,
      events: [{ key: 'x', time: 'oops' }, { key: 'y', time: 200 }],
    }], 1.0);
    expect(a.invalid).toBe(1);
    expect(a.medianRelativeTime).toBeCloseTo(200 / 1800, 10);
  });

  it('agrees between the aggregate median and the per-item median', () => {
    const a = aggregateItemPresence([{
      heroId: 1, matchId: 'm1', duration: 1800,
      events: [{ key: 'solo', time: 100 }, { key: 'solo', time: 200 }],
    }], 1.0);
    expect(a.rows[0].medianRelativeTime).toBeCloseTo(a.medianRelativeTime, 10);
  });
});

describe('the 100% window loses nothing valid (§5)', () => {
  // The regression this guards: with an out-of-range timestamp present, the
  // full window must still retain 100% of the valid signal. Counting raw event
  // keys as the denominator made presenceRetained read below 100% purely
  // because of a timestamp the report had already declared invalid.
  const withBad = [{
    heroId: 1, matchId: 'm1', duration: 1800,
    events: [{ key: 'X', time: 100 }, { key: 'Y', time: 1900 }],
  }];

  it('counts only the valid item in the full-window total', () => {
    const full = aggregateItemPresence(withBad, 1.0);
    const totalPresence = full.rows.reduce((s, r) => s + r.presenceMatches, 0);
    expect(totalPresence).toBe(1); // X only, not Y
  });

  it('retains 100% of events and presence at cutoff 1.0', () => {
    const full = aggregateItemPresence(withBad, 1.0);
    const totalEvents = full.inWindow;
    const totalPresence = full.rows.reduce((s, r) => s + r.presenceMatches, 0);
    const atFull = aggregateItemPresence(withBad, 1.0);
    expect(atFull.inWindow / totalEvents).toBe(1);
    const kept = atFull.rows.reduce((s, r) => s + r.presenceMatches, 0);
    expect(kept / totalPresence).toBe(1);
  });

  it('reports the excluded event separately instead of dropping it silently', () => {
    const full = aggregateItemPresence(withBad, 1.0);
    const raw = withBad[0].events.length;
    expect(full.inWindow).toBe(1);
    expect(raw - full.inWindow).toBe(1);
    expect(full.afterDuration).toBe(1);
  });

  it('drops the invalid item from the ranking entirely', () => {
    expect(aggregateItemPresence(withBad, 1.0).rows.map((r) => r.itemId)).toEqual(['X']);
  });
});

describe('topKOverlap (§11)', () => {
  // Explicit values: a different ORDER with identical rates is the same ranking,
  // so a fixture that only reorders ids would make every overlap 1.
  const withRates = (pairs) => pairs.map(([itemId, presenceRate]) => ({ itemId, presenceRate }));

  it('is 1 for an identical ordering', () => {
    const a = withRates([['a', 0.9], ['b', 0.5], ['c', 0.2]]);
    const o = topKOverlap(a, a, 3);
    expect(o.overlap).toBe(3);
    expect(o.ratio).toBe(1);
  });

  it('measures real movement as a change of top-k MEMBERSHIP', () => {
    // Overlap compares SETS, not order: re-ranking the same items changes nothing.
    const a = withRates([['a', 0.9], ['b', 0.5], ['c', 0.2]]);
    const b = withRates([['d', 0.9], ['e', 0.5], ['c', 0.2]]);
    const o = topKOverlap(a, b, 3);
    expect(o.overlap).toBe(1);
    expect(o.ratio).toBeCloseTo(1 / 3, 10);
  });

  it('is 1 when only the ordering within top-k moves', () => {
    const a = withRates([['a', 0.9], ['b', 0.5], ['c', 0.2]]);
    const b = withRates([['c', 0.9], ['b', 0.5], ['a', 0.2]]);
    expect(topKOverlap(a, b, 3).ratio).toBe(1);
  });

  it('handles fewer rows than k', () => {
    const o = topKOverlap(withRates([['a', 1]]), withRates([['a', 1], ['b', 0.5]]), 5);
    expect(o.ratio).toBeCloseTo(1, 10);
  });

  it('returns a null ratio for empty input rather than NaN', () => {
    expect(topKOverlap([], [], 5).ratio).toBeNull();
  });
});

describe('rankCorrelation — delegates, never re-implements (§12)', () => {
  it('passes the common pairs to the injected Spearman', () => {
    const spy = vi.fn(() => 0.9);
    const a = [{ itemId: 'x', presenceRate: 0.5 }, { itemId: 'y', presenceRate: 0.4 }, { itemId: 'z', presenceRate: 0.3 }];
    const b = [{ itemId: 'x', presenceRate: 0.6 }, { itemId: 'y', presenceRate: 0.35 }, { itemId: 'z', presenceRate: 0.2 }];
    const r = rankCorrelation(a, b, 'presenceRate', spy);
    expect(r).toBe(0.9);
    expect(spy).toHaveBeenCalledWith([0.5, 0.4, 0.3], [0.6, 0.35, 0.2]);
  });

  it('drops items missing from either side', () => {
    const spy = vi.fn(() => 1);
    const a = [{ itemId: 'x', presenceRate: 1 }, { itemId: 'y', presenceRate: 0.7 }, { itemId: 'z', presenceRate: 0.4 }, { itemId: 'w', presenceRate: 0.1 }];
    const b = [{ itemId: 'x', presenceRate: 1 }, { itemId: 'y', presenceRate: 0.6 }, { itemId: 'z', presenceRate: 0.3 }];
    rankCorrelation(a, b, 'presenceRate', spy);
    expect(spy.mock.calls[0][0]).toEqual([1, 0.7, 0.4]); // 'w' is not in b
  });

  it('returns null below three shared items', () => {
    const spy = vi.fn(() => 1);
    const a = [{ itemId: 'x', presenceRate: 1 }, { itemId: 'y', presenceRate: 0.5 }];
    const b = [{ itemId: 'x', presenceRate: 1 }, { itemId: 'y', presenceRate: 0.4 }];
    expect(rankCorrelation(a, b, 'presenceRate', spy)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('ignores null values rather than ranking them', () => {
    const spy = vi.fn(() => 1);
    const a = [{ itemId: 'x', presenceRate: 1 }, { itemId: 'y', presenceRate: null }, { itemId: 'z', presenceRate: 0.4 }, { itemId: 'w', presenceRate: 0.2 }];
    const b = [{ itemId: 'x', presenceRate: 0.9 }, { itemId: 'y', presenceRate: 0.5 }, { itemId: 'z', presenceRate: 0.3 }, { itemId: 'w', presenceRate: 0.1 }];
    rankCorrelation(a, b, 'presenceRate', spy);
    expect(spy.mock.calls[0][0]).toEqual([1, 0.4, 0.2]); // 'y' excluded
    expect(spy.mock.calls[0][1]).toEqual([0.9, 0.3, 0.1]);
  });
});

describe('pre-registered constants', () => {
  it('uses relative cutoffs, never absolute minutes', () => {
    expect(CUTOFFS.every((c) => c > 0 && c <= 1)).toBe(true);
    expect(CUTOFFS).toContain(1.0);
  });

  it('keeps the support floors and the minimum sample fixed', () => {
    expect(SUPPORT_FLOORS).toEqual([10, 25, 50, 100]);
    expect(MIN_SAMPLE_FOR_CONCLUSION).toBe(30);
  });
});

