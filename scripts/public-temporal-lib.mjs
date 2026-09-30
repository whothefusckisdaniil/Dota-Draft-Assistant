/**
 * Temporal eligibility research — pure helpers (ТЗ §26).
 *
 * No network, no filesystem. Every number the report prints is computed here so
 * it can be unit-tested; the research script only fetches, slices and prints.
 *
 * Two independent views of the same data are kept deliberately separate
 * throughout, because `purchase_log` is EVENT based:
 *
 *   presence — a (hero, match) pair where the item was bought AT LEAST ONCE
 *   events   — how many purchase events there were
 *
 * An item bought twice in one match is one presence and two events, and the two
 * measures can disagree about stability.
 */

/** Cutoffs as a fraction of match duration (§8). Never absolute minutes. */
export const CUTOFFS = [0.25, 0.33, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0];

/** Pre-registered support floors (§10). Not chosen after seeing results. */
export const SUPPORT_FLOORS = [10, 25, 50, 100];

/** A sample smaller than this is reported but not aggregated into conclusions. */
export const MIN_SAMPLE_FOR_CONCLUSION = 30;

/**
 * §7 — classify one purchase event against a cutoff.
 *
 * Pre-horn (negative) timestamps are VALID and fall inside every positive
 * cutoff: starting items are bought at `t = -59s` and must not be discarded.
 * Only `time > duration` and non-numeric times are excluded from the signal —
 * and they are counted separately rather than dropped silently.
 */
export function classifyPurchaseTiming(event, durationSeconds, cutoff) {
  const t = event?.time;
  if (typeof t !== 'number' || !Number.isFinite(t)) return 'invalid_type';
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    // Without a duration there is no scale to normalise against.
    return t < 0 ? 'pre_horn' : 'no_duration';
  }
  if (t > durationSeconds) return 'after_duration';
  if (t < 0) return 'pre_horn';
  if (t <= cutoff * durationSeconds) return 'in_window';
  return 'after_cutoff';
}

/**
 * §7 — a purchase time expressed as a fraction of match duration.
 * Returns null when the value cannot be placed on that scale, so a caller can
 * count the failure instead of treating it as 0.
 */
export function relativePurchaseTime(t, durationSeconds) {
  if (typeof t !== 'number' || !Number.isFinite(t)) return null;
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  return t / durationSeconds;
}

/** Is this event inside the window? Negative times always are. */
export function isInWindow(event, durationSeconds, cutoff) {
  const c = classifyPurchaseTiming(event, durationSeconds, cutoff);
  return c === 'in_window' || c === 'pre_horn';
}

/**
 * §4 — the ONE definition of a valid purchase observation.
 *
 * Derived from `classifyPurchaseTiming` so that "valid" cannot mean one thing
 * in `aggregateItemPresence` and something else in `lateFraction`:
 *
 *   time < 0              -> valid (pre-horn is real data)
 *   0 <= time <= duration -> valid (time === duration is still in the match)
 *   time > duration       -> invalid, excluded
 *   non-numeric           -> invalid, excluded
 *   no usable duration    -> invalid, excluded
 */
export function isValidPurchaseTime(t, durationSeconds) {
  const c = classifyPurchaseTiming({ time: t }, durationSeconds, 1.0);
  return c === 'pre_horn' || c === 'in_window';
}

/**
 * §15 — cumulative post-cutoff fractions of a set of events.
 *
 * The denominator is VALID events only. A timestamp past match end used to sit
 * in both the numerator and the denominator, so it was reported as "observed
 * late" at every cutoff while `aggregateItemPresence` had already excluded it
 * as invalid — the same event being both inside and outside the signal.
 */
export function lateFraction(events, durationSeconds) {
  const valid = events.filter((e) => isValidPurchaseTime(e?.time, durationSeconds));
  const rel = valid.map((e) => relativePurchaseTime(e?.time, durationSeconds)).filter((x) => x !== null);
  const out = {};
  for (const c of CUTOFFS) {
    if (c === 1) { out[c] = 0; continue; }
    out[c] = rel.length ? rel.filter((r) => r > c).length / rel.length : null;
  }
  // Same denominator rule: an invalid timestamp is not evidence of a late buy.
  out.final120 = valid.length
    ? valid.filter((e) => e.time > durationSeconds - 120).length / valid.length
    : null;
  out.validEvents = valid.length;
  out.excludedEvents = events.length - valid.length;
  return out;
}

/**
 * §1/§6/§9 — the two independent views, in one pass.
 *
 * GRAIN is `(heroId, matchId, itemId)`, not `(matchId, itemId)`. Ten players in
 * one match each buying Battle Fury is TEN observations of the Hero x Item
 * signal, not one. Keying presence by match alone made `presenceRate` measure
 * "item across all heroes" while the report labelled it Hero x Item.
 *
 * `playerMatches` are (hero, match) rows; both identifiers are REQUIRED,
 * because presence is meaningless without them and a silent fallback would
 * quietly recreate the collapsed grain.
 */
export function aggregateItemPresence(playerMatches, cutoff) {
  if (!Array.isArray(playerMatches)) throw new TypeError('aggregateItemPresence: playerMatches must be an array');

  const presence = new Map(); // itemId -> { heroMatchKeys:Set, events, rel:[] }
  let inWindow = 0; let afterCutoff = 0; let preHorn = 0; let afterDuration = 0; let invalid = 0;
  let totalEvents = 0;
  const relTimes = [];

  playerMatches.forEach((pm, i) => {
    if (pm?.matchId === undefined || pm?.matchId === null) {
      throw new TypeError(`aggregateItemPresence: playerMatches[${i}] has no matchId; presence is keyed on (heroId, matchId)`);
    }
    if (pm?.heroId === undefined || pm?.heroId === null) {
      throw new TypeError(`aggregateItemPresence: playerMatches[${i}] has no heroId; presence is keyed on (heroId, matchId)`);
    }
    const dur = pm.duration;
    // §2 — deterministic identity. No Math.random, no Date.now: two runs over
    // the same corpus must produce byte-identical output.
    const rowKey = `${pm.heroId}:${pm.matchId}`;

    for (const e of pm.events ?? []) {
      totalEvents += 1;
      const rel = relativePurchaseTime(e?.time, dur);
      const c = classifyPurchaseTiming(e, dur, cutoff);
      if (c === 'pre_horn') preHorn += 1;
      if (c === 'after_duration') afterDuration += 1;
      if (c === 'invalid_type' || c === 'no_duration') invalid += 1;

      if (c !== 'in_window' && c !== 'pre_horn') {
        if (c === 'after_cutoff') afterCutoff += 1;
        continue;
      }
      const key = e?.key;
      // §3/§4 — from here on the event describes the signal. Everything
      // counted below describes exactly the same population: a timed event with
      // no item key contributes no row, so it must not reach `inWindow` or the
      // timing median either.
      if (typeof key !== 'string' || !key) continue;
      inWindow += 1;
      // A timing summary describes only events inside the window: `time >
      // duration` never reaches the median.
      if (rel !== null) relTimes.push(rel);
      const cur = presence.get(key) ?? { heroMatchKeys: new Set(), events: 0, rel: [] };
      cur.events += 1;
      cur.rel.push(rel);
      cur.heroMatchKeys.add(rowKey);
      presence.set(key, cur);
    }
  });

  const heroMatches = playerMatches.length;
  const rows = [...presence.entries()].map(([itemId, v]) => ({
    itemId,
    presenceMatches: v.heroMatchKeys.size,
    presenceRate: heroMatches > 0 ? v.heroMatchKeys.size / heroMatches : null,
    events: v.events,
    eventsPerHeroMatch: heroMatches > 0 ? v.events / heroMatches : null,
    medianRelativeTime: medianOf(v.rel),
  }));
  rows.sort(byPresenceThenEvents);
  return { heroMatches, totalEvents, inWindow, afterCutoff, preHorn, afterDuration, invalid, medianRelativeTime: medianOf(relTimes), rows };
}

/**
 * §1 — the ONE tie-break, used by every ranking in this study.
 *
 * `presenceRate` ties constantly in a small corpus (a ~20-match bucket has long
 * runs of identical rates), and `Array.sort` is stable, so a key-only sort
 * silently inherits Map insertion order — i.e. whichever match the crawl saw
 * first. That turns §23's sample A/B comparison into a measurement of crawl
 * order instead of a measurement of temporal stability.
 */
const byItemId = (x, y) => String(x.itemId).localeCompare(String(y.itemId));

/** §1 — `key` descending, then `itemId` ascending. A total order, always. */
export function rankedRows(rows, key) {
  return rows.slice().sort((x, y) => (y[key] ?? 0) - (x[key] ?? 0) || byItemId(x, y));
}

/**
 * §6 — the default order of an aggregate's rows: presence first, then event
 * rate, then the shared itemId tie-break.
 */
export function byPresenceThenEvents(a, b) {
  return (b.presenceRate ?? 0) - (a.presenceRate ?? 0)
    || (b.eventsPerHeroMatch ?? 0) - (a.eventsPerHeroMatch ?? 0)
    || byItemId(a, b);
}

/** §1 — canonical grouping: heroId -> that hero's (match) rows. */
export function groupRowsByHero(rows) {
  const byHero = new Map();
  for (const r of rows ?? []) {
    if (r?.heroId === undefined || r?.heroId === null) continue;
    const list = byHero.get(r.heroId);
    if (list) list.push(r);
    else byHero.set(r.heroId, [r]);
  }
  return byHero;
}

/**
 * §7 — support counted on `(heroId, itemId)` cells, not on pooled items.
 *
 * `aggregateItemPresence` answers "how often is this item seen across the
 * corpus". That is a pooled item diagnostic, and pooling hides the fact that
 * three heroes each seen five times is NOT one well-supported cell — it is three
 * cells that are all under any sane floor. A support floor applied to pooled
 * rows therefore reports "supported" for a relation no single hero supports.
 *
 * This reuses `aggregateItemPresence` per hero rather than inventing a second
 * aggregation, and emits one row per hero × item.
 */
export function heroItemCells(playerMatches, cutoff) {
  const cells = [];
  for (const [heroId, heroRows] of groupRowsByHero(playerMatches)) {
    const a = aggregateItemPresence(heroRows, cutoff);
    for (const r of a.rows) {
      cells.push({
        heroId,
        itemId: r.itemId,
        presenceMatches: r.presenceMatches,
        heroMatches: a.heroMatches,
        presenceRate: r.presenceRate,
        events: r.events,
        eventsPerHeroMatch: r.eventsPerHeroMatch,
        medianRelativeTime: r.medianRelativeTime,
      });
    }
  }
  return cells;
}

/** §7 — how many hero × item cells clear each pre-registered floor. */
export function supportByHeroItem(playerMatches, cutoff, floors = SUPPORT_FLOORS) {
  const cells = heroItemCells(playerMatches, cutoff);
  return floors.map((floor) => {
    const kept = cells.filter((c) => c.presenceMatches >= floor);
    return { floor, cellsKept: kept.length, cellsDropped: cells.length - kept.length, totalCells: cells.length };
  });
}

/**
 * §11 — exhaustive hydration outcome taxonomy.
 *
 * "Not parsed" and "our GET failed" used to be the same `null`, so a rate
 * limit was silently counted as evidence that OpenDota had not parsed a match.
 * These names keep the two apart in the report.
 */
export const HYDRATION = {
  OK: 'hydrate_ok',
  CACHED: 'hydrate_cached',
  RATE_LIMITED: 'hydrate_429',
  HTTP_ERROR: 'hydrate_http_error',
  TIMEOUT: 'hydrate_timeout',
  INVALID_PAYLOAD: 'hydrate_invalid_payload',
  NOT_PARSEABLE: 'not_parsed',
  FAILED: 'request_failed',
};

function medianOf(values) {
  const s = values.filter((v) => v !== null).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * §11 — how much of a top-k list survives when the cutoff moves.
 *
 * This compares top-k MEMBERSHIP, not order: re-ranking the same items scores
 * 1.0, and only items entering or leaving the list move the number. Ranking
 * DEPTH is measured separately by `rankCorrelation`.
 *
 * Both sides go through `rankedRows`, so tied values resolve by `itemId` on
 * each side independently and the result cannot depend on input order.
 */
export function topKOverlap(rowsA, rowsB, k, key = 'presenceRate') {
  const a = rankedRows(rowsA, key).slice(0, k).map((r) => r.itemId);
  const b = rankedRows(rowsB, key).slice(0, k).map((r) => r.itemId);
  const inter = a.filter((x) => b.includes(x)).length;
  return { k, a: a.length, b: b.length, overlap: inter, ratio: a.length ? inter / a.length : null };
}

/**
 * §12 — rank correlation between two cutoffs, over their COMMON items only.
 *
 * `spearmanRho` is passed IN. Re-implementing Spearman inside research code is
 * how an invalid tie-handling bug reached a published number in ТЗ §21.1.
 */
export function rankCorrelation(rowsA, rowsB, key, spearmanRho) {
  const bById = new Map(rowsB.map((r) => [r.itemId, r[key]]));
  const xs = [];
  const ys = [];
  for (const r of rowsA) {
    const y = bById.get(r.itemId);
    if (y === undefined || y === null || r[key] === null) continue;
    xs.push(r[key]);
    ys.push(y);
  }
  if (xs.length < 3) return null;
  return spearmanRho(xs, ys);
}

