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

// ==================================================================== ТЗ §25.1

/**
 * §1 — the job id is NESTED. A successful `POST /request/{id}` answers
 *
 *     { "job": { "jobId": 556030584 } }
 *
 * so reading `body.jobId` finds nothing and every request looks un-accepted.
 * That mistake cost a full experimental run once: 16 successful POSTs were
 * reported as `200 / - / unknown`.
 *
 * `job.jobId` wins over the flat spellings, and anything without a usable id
 * returns null rather than a guess.
 */
export function extractParseJobId(body) {
  if (body == null || typeof body !== 'object') return null;
  const job = body.job;
  if (job != null && typeof job === 'object') {
    if (job.jobId != null) return job.jobId;
    if (job.job_id != null) return job.job_id;
    if (job.id != null) return job.id;
  }
  if (body.jobId != null) return body.jobId;
  if (body.job_id != null) return body.job_id;
  if (body.id != null) return body.id;
  return null;
}

/**
 * §2/§11 — HTTP 200 is NOT acceptance. The payload decides.
 *
 * `200 + err` and `200 + status: failed` are failures; `200` with neither a job
 * nor an error is simply unknown, and collapsing that into `failed` would
 * invent a parser defect that never happened.
 */
export function classifyPostResponse(body, httpStatus) {
  if (typeof httpStatus === 'number' && (httpStatus < 200 || httpStatus >= 300)) {
    return { accepted: false, status: 'failed', reason: `http_${httpStatus}`, jobId: null };
  }
  if (body == null || typeof body !== 'object') {
    return { accepted: false, status: 'unknown', reason: 'no_body', jobId: null };
  }
  if (body.err != null || body.error != null) {
    return { accepted: false, status: 'failed', reason: 'payload_error', jobId: null };
  }
  const s = String(body.status ?? body.state ?? '').toLowerCase();
  if (s === 'failed' || s === 'error') {
    return { accepted: false, status: 'failed', reason: 'status_failed', jobId: null };
  }
  const jobId = extractParseJobId(body);
  if (jobId != null) return { accepted: true, status: 'accepted', reason: 'job_returned', jobId };
  if (s === 'pending' || s === 'queued' || s === 'processing') {
    return { accepted: true, status: 'accepted', reason: 'queued_without_job_id', jobId: null };
  }
  return { accepted: false, status: 'unknown', reason: 'no_job_and_no_error', jobId: null };
}

/** §5/§6 — case-normalised job state, so `pending`/`PENDING` cannot diverge. */
export function normaliseJobState(raw) {
  return classifyJobStatus(raw);
}

export function isTerminalJobState(state) {
  return state === 'completed' || state === 'failed';
}

// ==================================================================== ТЗ §25

/**
 * §13 — a purchase event's TIMING, for enrichment purposes.
 *
 * Negative times are VALID: the OpenDota clock starts at 0 on the horn, so
 * pre-horN starting items (fairy fire, branches, tango at -59s) are ordinary
 * data, not corruption. This deliberately differs from `validPurchaseTimestamp`,
 * which keeps `negative` as its own bucket for the ТЗ §23 report. Neither value
 * is discarded here — the raw counts are aggregated separately.
 */
export function classifyPurchaseEvent(event, durationSeconds) {
  const t = event?.time;
  if (typeof t !== 'number' || !Number.isFinite(t)) return 'invalid_type';
  if (typeof durationSeconds === 'number' && durationSeconds > 0 && t > durationSeconds) return 'after_duration';
  return 'valid';
}

/** §9 — the enrichment cascade is four independent layers, never one verdict. */
export const ENRICHMENT_STAGES = ['post_accepted', 'job_completed', 'has_parsed', 'roster_10', 'purchase_log', 'item_keys', 'timing_valid'];

/**
 * Classify one match through Layers A..D (§9).
 *
 * §25.1 correction: an UNOBSERVABLE job state must not veto an OBSERVABLE
 * parser verdict. `/request/{jobId}` answered `null` for all 16 accepted jobs
 * while 12 of those matches really were parsed and carried a full purchase_log.
 * Gating the cascade on job completion therefore reported "0/16 usable" for a
 * run in which 12 matches were fully enriched — the auxiliary signal was
 * allowed to overwrite the primary one.
 *
 * `jobState` is now reported alongside the stage instead of gating it.
 */
export function classifyEnrichmentStage({ postOk, jobCompleted, detail }) {
  const jobState = jobCompleted ?? 'unknown';
  if (!postOk) return { stage: 'post_failed', layer: null, jobState };

  // Layer A: the parser's own verdict. This is the authoritative signal.
  if (detail?.od_data?.has_parsed !== true) return { stage: 'parse_not_flagged', layer: 'A', jobState };

  // Layer B: roster.
  const players = detail.players ?? [];
  if (players.length !== 10) return { stage: 'roster_bad', layer: 'B', jobState };

  // Layer C: does the field exist at all? An empty array is NOT an error.
  const withField = players.filter((p) => Array.isArray(p.purchase_log)).length;
  if (withField === 0) return { stage: 'purchase_log_absent', layer: 'C', jobState };

  // Layer D: do the entries carry a resolvable key and a usable time?
  const entries = players.flatMap((p) => p.purchase_log ?? []);
  const keyed = entries.filter((e) => typeof e?.key === 'string' && e.key.length > 0).length;
  if (keyed === 0) return { stage: 'items_unkeyed', layer: 'D', jobState };

  const timed = entries.filter((e) => classifyPurchaseEvent(e, detail.duration) === 'valid').length;
  if (timed === 0) return { stage: 'timing_unusable', layer: 'D', jobState };

  return { stage: 'usable', layer: 'D', jobState, players, withField, entries, keyed, timed };
}

/**
 * §20 — Wilson score interval. A plain binomial interval is meaningless at
 * n=16, and a 12/16 point estimate invites reading it as a rate.
 */
export function wilsonInterval(successes, total, z = 1.96) {
  if (!total || total <= 0) return null;
  const p = successes / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return {
    point: p,
    low: Math.max(0, (centre - margin) / denom),
    high: Math.min(1, (centre + margin) / denom),
    n: total,
  };
}

/** §10/§14 — the funnel, plus the raw counts that back it. */
export function aggregateEnrichment(results, { resolveKey } = {}) {
  const total = results.length;
  const step = (pred) => results.filter(pred).length;
  const parsed = results.filter((r) => r.detail?.od_data?.has_parsed === true);
  const withRoster = parsed.filter((r) => (r.detail.players ?? []).length === 10);
  const withField = withRoster.filter((r) => (r.detail.players ?? []).some((p) => Array.isArray(p.purchase_log)));

  let events = 0, keyed = 0, resolved = 0, unresolvedKeys = new Set();
  let preHorn = 0, valid = 0, after = 0, invalid = 0, lateHalf = 0, lateTwoMin = 0;
  for (const m of withField) {
    const dur = m.detail.duration ?? 0;
    for (const p of m.detail.players) {
      for (const e of p.purchase_log ?? []) {
        events += 1;
        if (typeof e?.key === 'string' && e.key) {
          keyed += 1;
          if (resolveKey && resolveKey(e.key)) resolved += 1;
          else unresolvedKeys.add(e.key);
        }
        const c = classifyPurchaseEvent(e, dur);
        // `valid` here INCLUDES pre-horn (negative) times, so they are counted
        // separately rather than folded into the total.
        if (c === 'valid') { valid += 1; if (typeof e?.time === 'number' && e.time < 0) preHorn += 1; }
        else if (c === 'after_duration') after += 1;
        else if (c === 'invalid_type') invalid += 1;
        if (typeof e?.time === 'number' && typeof dur === 'number' && dur > 0) {
          if (e.time > dur / 2) lateHalf += 1;
          if (e.time > dur - 120) lateTwoMin += 1;
        }
      }
    }
  }
  return {
    total,
    funnel: {
      post_accepted: step((r) => r.postOk),
      job_completed: step((r) => r.jobStatus === 'completed'),
      has_parsed: parsed.length,
      roster_10: withRoster.length,
      purchase_log: withField.length,
      item_keys: keyed > 0 ? withField.length : 0,
      timing_valid: valid > 0 ? withField.length : 0,
    },
    events, keyed, resolved, unresolvedKeys: [...unresolvedKeys],
    timing: { validIncludingPreHorn: valid, preHorn, after_duration: after, invalid_type: invalid },
    postHoc: { afterHalf: lateHalf, afterFinalTwoMin: lateTwoMin },
    ci: {
      // §21 — completion is measured by the PARSER's own verdict, not by the job
      // endpoint. `/request/{jobId}` returned null for every accepted job, so a
      // job-based interval would have described an API gap as a parse failure.
      completion: wilsonInterval(parsed.length, total),
      usable: wilsonInterval(valid > 0 ? withField.length : 0, total),
    },
    jobStates: results.reduce((acc, r) => {
      const k = r.jobStatus ?? 'unknown';
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {}),
  };
}


