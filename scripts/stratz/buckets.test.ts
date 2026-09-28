import { describe, expect, it } from 'vitest';
import { BUCKET_SEC, getCompleteWeeklyBuckets } from './buckets.mjs';

describe('getCompleteWeeklyBuckets helper', () => {
  it('correctly calculates buckets for the research date 2026-09-25', () => {
    // On 2026-09-25 (Friday), current bucket was 2960 (started Thursday 2026-09-24 00:00:00 UTC).
    // Note: in early research on 2026-09-21, bucket was 2959. By 2026-09-25 it transitioned to 2960.
    const refDate = new Date('2026-09-25T12:00:00Z');
    const res = getCompleteWeeklyBuckets(refDate, 4);

    expect(res.currentBucket).toBe(2960);
    expect(res.latestCompleteWeek).toBe(2959);
    expect(res.buckets).toEqual([2956, 2957, 2958, 2959]);
    expect(res.windowStartUtc).toBe('2026-08-27T00:00:00Z');
    expect(res.windowEndUtcExclusive).toBe('2026-09-24T00:00:00Z');
  });

  it('correctly calculates buckets during bucket 2959 (e.g. 2026-09-21)', () => {
    // On Monday 2026-09-21, current bucket was 2959.
    // The latest complete week was 2958, and the 4-week window was 2955..2958.
    const refDate = new Date('2026-09-21T12:00:00Z');
    const res = getCompleteWeeklyBuckets(refDate, 4);

    expect(res.currentBucket).toBe(2959);
    expect(res.latestCompleteWeek).toBe(2958);
    expect(res.buckets).toEqual([2955, 2956, 2957, 2958]);
    expect(res.windowStartUtc).toBe('2026-08-20T00:00:00Z');
    expect(res.windowEndUtcExclusive).toBe('2026-09-17T00:00:00Z');
  });

  it('handles custom count parameter and ensures strictly increasing sequence', () => {
    const refDate = new Date('2026-09-28T05:00:00Z');
    const res = getCompleteWeeklyBuckets(refDate, 6);

    expect(res.buckets).toHaveLength(6);
    expect(res.currentBucket).toBe(2960);
    expect(res.latestCompleteWeek).toBe(2959);
    expect(res.buckets).toEqual([2954, 2955, 2956, 2957, 2958, 2959]);

    for (let i = 1; i < res.buckets.length; i += 1) {
      expect(res.buckets[i]).toBe(res.buckets[i - 1] + 1);
    }
  });

  it('matches Thursday 00:00:00 boundary exactly', () => {
    // 2960 starts exactly at 2960 * 604800 = 1790294400 (2026-09-24T00:00:00.000Z)
    const exactThursdayStart = new Date(2960 * BUCKET_SEC * 1000);
    const res = getCompleteWeeklyBuckets(exactThursdayStart, 4);
    expect(res.currentBucket).toBe(2960);
    expect(res.latestCompleteWeek).toBe(2959);

    // 1 millisecond before boundary (still bucket 2959)
    const justBefore = new Date(2960 * BUCKET_SEC * 1000 - 1);
    const resBefore = getCompleteWeeklyBuckets(justBefore, 4);
    expect(resBefore.currentBucket).toBe(2959);
    expect(resBefore.latestCompleteWeek).toBe(2958);
  });
});
