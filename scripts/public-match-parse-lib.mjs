/**
 * Pure helpers for ТЗ §23, kept in a separate module so they can be unit-tested
 * without importing the script (which performs network I/O at import time).
 * No side effects, no network, no filesystem.
 */

/**
 * §5 — is this match already parsed? Three-valued, never a boolean guess.
 *
 * Absence from `/parsedMatches` is NOT proof of "not parsed": that endpoint
 * returns only the most recent page of ids, so a miss is `unknown` unless the
 * caller declares the index exhaustive. Assuming the optimistic direction would
 * mean re-enqueueing matches that are already parsed.
 */
export function classifyParseStatus({ inParsedIndex = false, indexExhaustive = false, odData = null } = {}) {
  if (odData && typeof odData.has_parsed === 'boolean') {
    return odData.has_parsed ? 'already_parsed' : 'not_parsed';
  }
  if (inParsedIndex) return 'already_parsed';
  if (indexExhaustive) return 'not_parsed';
  return 'unknown';
}

/** §7 — job status vocabulary, with anything unrecognised left as `unknown`. */
export function classifyJobStatus(raw) {
  if (raw == null) return 'unknown';
  if (raw.error) return 'failed';
  const s = typeof raw === 'object' ? (raw.status ?? raw.state) : raw;
  const v = String(s ?? '').toLowerCase();
  if (['ok', 'success', 'done', 'completed', 'complete'].includes(v)) return 'completed';
  if (['pending', 'processing', 'queued', 'running', 'in_progress'].includes(v)) return 'pending';
  if (['fail', 'failed', 'error'].includes(v)) return 'failed';
  return 'unknown';
}

/**
 * §15 — a purchase timestamp is usable only inside the match.
 * Returns a classified result rather than a boolean, so invalid values are
 * counted separately instead of being silently dropped.
 */
export function validPurchaseTimestamp(t, durationSeconds) {
  if (typeof t !== 'number' || !Number.isFinite(t)) return 'invalid_type';
  if (t < 0) return 'negative';
  if (typeof durationSeconds === 'number' && durationSeconds > 0 && t > durationSeconds) return 'after_duration';
  return 'valid';
}

/** §8/§9 — how many player rows carry a field, over a fixed denominator. */
export function fieldCoverage(players, field) {
  const rows = players ?? [];
  let present = 0;
  for (const p of rows) {
    const v = p?.[field];
    if (v == null) continue;
    if (Array.isArray(v) ? v.length > 0 : v !== 0 && v !== '') present += 1;
  }
  return { present, total: rows.length, ratio: rows.length ? present / rows.length : 0 };
}

/** §9 — before/after comparison for a single field. */
export function enrichmentDelta(before, after) {
  const delta = after.present - before.present;
  return {
    before: `${before.present}/${before.total}`,
    after: `${after.present}/${after.total}`,
    delta,
    changed: delta !== 0,
  };
}

/** §3 — pick at most `n` rows per rank bucket, preferring league 0 and newest. */
export function pickSamplePerBucket(listing, buckets, n = 2) {
  const picked = [];
  for (const b of buckets) {
    const inBucket = listing
      .filter((m) => m.avg_rank_tier >= b.min && m.avg_rank_tier <= b.max)
      // league 0 first (public, not pro), then newest first
      .sort((x, y) => (x.leagueid ?? 0) - (y.leagueid ?? 0) || y.start_time - x.start_time);
    picked.push(...inBucket.slice(0, n).map((m) => ({ ...m, bucket: b.key })));
  }
  return picked;
}

/**
 * ТЗ §23.1 §3-§4 — is this match DEFINITIVELY unparsed?
 *
 * Only an explicit `od_data.has_parsed === false` counts. A missing `od_data`,
 * a missing `has_parsed` key, or absence from the (recent-page-only) parsed
 * index are all `unknown` and must never become a baseline row: that is the
 * same "absence read as assertion" mistake this project has now made three
 * times.
 */
export function isDefinitiveUnparsed(detail) {
  return detail?.od_data?.has_parsed === false;
}

/** §23.1 §1 — the enqueueable set: explicit not_parsed, public, in a bucket. */
export function selectEnqueueable(rows, buckets, maxTotal = 4) {
  const eligible = rows.filter((r) =>
    isDefinitiveUnparsed(r.detail) &&
    (r.detail.leagueid ?? 0) === 0 &&
    r.listing.avg_rank_tier >= r.bucketDef.min &&
    r.listing.avg_rank_tier <= r.bucketDef.max);
  // One per bucket first, then fill from whatever is left, so the request is
  // spread across the rank range instead of spending the whole budget on one.
  const perBucket = new Map();
  for (const b of buckets) perBucket.set(b.key, []);
  for (const r of eligible) perBucket.get(r.bucketDef.key)?.push(r);
  const picked = [];
  for (const b of buckets) {
    if (picked.length >= maxTotal) break;
    const rows = perBucket.get(b.key) ?? [];
    if (rows.length) picked.push(rows[0]);
  }
  return picked.slice(0, maxTotal);
}

/** §23.1 §5 — a baseline smaller than `required` must be reported, not faked. */
export function baselineGuard(found, required = 5) {
  return found >= required
    ? { usable: true, found, required, text: `${found}/${required} definitive unparsed` }
    : { usable: false, found, required, text: `unavailable — only ${found} definitive unparsed match(es)` };
}

