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
const DAY_SEC = 86400;

/**
 * Rolling "last N days" window over STRATZ weekly buckets.
 *
 * STRATZ only publishes matchup / position statistics per weekly bucket (the
 * `week` argument is floored to the bucket; verified against the live API), so
 * a day-exact window is approximated:
 *   - window = [today 00:00 UTC − N days, now)
 *   - the current, still running bucket is taken as-is (weight 1): STRATZ fills
 *     it live, so it already holds exactly the days elapsed so far;
 *   - complete buckets fully inside the window have weight 1;
 *   - the oldest bucket only partly inside the window is scaled by the share of
 *     its 7 days that are still inside (assumes games are spread evenly over
 *     that week). Every day its weight drops by 1/7 until it leaves the window.
 *
 * @param {Date} [referenceDate=new Date()]
 * @param {number} [days=ROLLING_DAYS]
 */
export function getRollingWindow(referenceDate = new Date(), days = ROLLING_DAYS) {
  if (!Number.isInteger(days) || days < 8) throw new Error(`days must be an integer >= 8, got ${days}`);
  const nowSec = Math.floor(referenceDate.getTime() / 1000);
  const todayStartSec = Math.floor(nowSec / DAY_SEC) * DAY_SEC;
  const startSec = todayStartSec - days * DAY_SEC;
  const currentBucket = Math.floor(nowSec / BUCKET_SEC);
  const firstBucket = Math.floor(startSec / BUCKET_SEC);

  const buckets = [];
  const weights = {};
  for (let b = firstBucket; b <= currentBucket; b += 1) {
    const bucketStart = b * BUCKET_SEC;
    const inside = bucketStart + BUCKET_SEC - Math.max(bucketStart, startSec);
    if (inside <= 0) continue;
    buckets.push(b);
    weights[b] = b === currentBucket ? 1 : Number((Math.min(inside, BUCKET_SEC) / BUCKET_SEC).toFixed(6));
  }

  return {
    days,
    currentBucket,
    buckets,
    weights,
    windowStartUtc: new Date(startSec * 1000).toISOString().slice(0, 10) + 'T00:00:00Z',
    windowEndUtc: referenceDate.toISOString(),
  };
}
