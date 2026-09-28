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
