/**
 * Dynamic calculation of complete weekly buckets for STRATZ.
 *
 * STRATZ bucket semantics:
 *   bucketIndex = Math.floor(unixTimestamp / 604800)
 * Each bucket starts on Thursday at 00:00:00 UTC and lasts 7 days (604,800 seconds).
 *
 * The current bucket (containing `referenceDate`) is in-progress and INCOMPLETE.
 * To avoid partial-week sample variance, we take the last N *fully completed* buckets:
 *   latestCompleteWeek = currentBucket - 1
 *   buckets = [latestCompleteWeek - (count - 1), ..., latestCompleteWeek]
 */

export const BUCKET_SEC = 604800;

/**
 * @typedef {Object} CompleteWeeklyBuckets
 * @property {number} currentBucket
 * @property {number} latestCompleteWeek
 * @property {number[]} buckets
 * @property {string} windowStartUtc
 * @property {string} windowEndUtcExclusive
 */

/**
 * @param {Date} [referenceDate=new Date()]
 * @param {number} [count=4]
 * @returns {CompleteWeeklyBuckets}
 */
export function getCompleteWeeklyBuckets(referenceDate = new Date(), count = 4) {
  if (count <= 0) throw new Error(`count must be positive, got ${count}`);
  const unixSec = Math.floor(referenceDate.getTime() / 1000);
  const currentBucket = Math.floor(unixSec / BUCKET_SEC);
  const latestCompleteWeek = currentBucket - 1;

  const buckets = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    buckets.push(latestCompleteWeek - i);
  }

  const windowStartUtc = new Date(buckets[0] * BUCKET_SEC * 1000).toISOString().slice(0, 10) + 'T00:00:00Z';
  const windowEndUtcExclusive = new Date((latestCompleteWeek + 1) * BUCKET_SEC * 1000).toISOString().slice(0, 10) + 'T00:00:00Z';

  return {
    currentBucket,
    latestCompleteWeek,
    buckets,
    windowStartUtc,
    windowEndUtcExclusive,
  };
}

/** Production matchup window: the last N days, recomputed every day. */
export const ROLLING_DAYS = 30;
/** Right after a patch the window is never shorter than this (thin samples otherwise). */
export const MIN_WINDOW_DAYS = 7;
/** Weight of pre-patch days used only to fill a young patch up to MIN_WINDOW_DAYS. */
export const PRE_PATCH_WEIGHT = 0.25;
const DAY_SEC = 86400;
const iso = (sec) => new Date(sec * 1000).toISOString();

/**
 * Rolling "last N days of the current patch" window over STRATZ weekly buckets.
 *
 * Time segments (each with a weight):
 *   - no patch inside the last N days: [today 00:00 UTC − N days, now), weight 1;
 *   - patch released inside the window and at least MIN_WINDOW_DAYS ago:
 *     [patch release, now), weight 1 — the previous patch is cut off entirely;
 *   - patch younger than MIN_WINDOW_DAYS: [patch release, now) weight 1 plus
 *     [today − MIN_WINDOW_DAYS, patch release) at PRE_PATCH_WEIGHT, so the
 *     first days of a new patch still have a usable sample but the new meta
 *     dominates.
 *
 * STRATZ only publishes matchup / position statistics per weekly bucket (the
 * `week` argument is floored to the bucket; verified against the live API), so
 * each bucket gets the weighted share of the time it covers (its 7 days, or
 * bucket start → now for the live current week) that falls inside the
 * segments. This assumes games are spread evenly inside a week. The oldest
 * bucket therefore loses 1/7 per day until it leaves the window.
 *
 * @param {Date} [referenceDate=new Date()]
 * @param {number} [days=ROLLING_DAYS]
 * @param {{ patchName?: string|null, patchReleasedUtc?: string|null }} [patch]
 */
export function getRollingWindow(referenceDate = new Date(), days = ROLLING_DAYS, patch = {}) {
  if (!Number.isInteger(days) || days < MIN_WINDOW_DAYS + 1) {
    throw new Error(`days must be an integer > ${MIN_WINDOW_DAYS}, got ${days}`);
  }
  const nowSec = Math.floor(referenceDate.getTime() / 1000);
  const todayStartSec = Math.floor(nowSec / DAY_SEC) * DAY_SEC;
  const fullStartSec = todayStartSec - days * DAY_SEC;
  const minStartSec = todayStartSec - MIN_WINDOW_DAYS * DAY_SEC;

  const released = patch.patchReleasedUtc ? Date.parse(patch.patchReleasedUtc) : NaN;
  const patchSec = Number.isFinite(released) ? Math.floor(released / 1000) : null;
  if (patchSec !== null && patchSec > nowSec) {
    throw new Error(`patch release ${patch.patchReleasedUtc} is in the future`);
  }

  let segments;
  let mode;
  if (patchSec === null || patchSec <= fullStartSec) {
    segments = [{ from: fullStartSec, to: nowSec, weight: 1 }];
    mode = patchSec === null ? 'NO_PATCH_DATE' : 'FULL_WINDOW_SAME_PATCH';
  } else if (patchSec <= minStartSec) {
    segments = [{ from: patchSec, to: nowSec, weight: 1 }];
    mode = 'CUT_AT_PATCH';
  } else {
    segments = [
      { from: minStartSec, to: patchSec, weight: PRE_PATCH_WEIGHT },
      { from: patchSec, to: nowSec, weight: 1 },
    ];
    mode = 'YOUNG_PATCH_FILLED';
  }
  const startSec = segments[0].from;

  const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const currentBucket = Math.floor(nowSec / BUCKET_SEC);
  const buckets = [];
  const weights = {};
  for (let b = Math.floor(startSec / BUCKET_SEC); b <= currentBucket; b += 1) {
    const coverFrom = b * BUCKET_SEC;
    const coverTo = Math.min(coverFrom + BUCKET_SEC, nowSec); // the live week only covers up to now
    if (coverTo <= coverFrom) continue;
    const weighted = segments.reduce((sum, seg) => sum + seg.weight * overlap(coverFrom, coverTo, seg.from, seg.to), 0);
    if (weighted <= 0) continue;
    buckets.push(b);
    weights[b] = Number((weighted / (coverTo - coverFrom)).toFixed(6));
  }

  const effectiveDays = segments.reduce((sum, seg) => sum + seg.weight * (seg.to - seg.from), 0) / DAY_SEC;
  return {
    days,
    currentBucket,
    buckets,
    weights,
    windowStartUtc: iso(startSec),
    windowEndUtc: referenceDate.toISOString(),
    effectiveDays: Number(effectiveDays.toFixed(3)),
    patch: {
      name: patch.patchName ?? null,
      releasedUtc: patchSec === null ? null : iso(patchSec),
      mode,
      prePatchWeight: mode === 'YOUNG_PATCH_FILLED' ? PRE_PATCH_WEIGHT : null,
    },
  };
}
