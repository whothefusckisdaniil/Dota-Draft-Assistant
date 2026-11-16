import { describe, expect, it } from 'vitest';
import { BUCKET_SEC, getCompleteWeeklyBuckets, getRollingWindow } from './buckets.mjs';

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

describe('getRollingWindow (last 30 days)', () => {
  it('2026-11-16: oldest week partly inside, current week taken live', () => {
    const w = getRollingWindow(new Date('2026-11-16T03:17:00Z'));
    // window starts 2026-10-17 00:00; bucket 2963 = Oct 15–22 → 5 of 7 days inside
    expect(w.windowStartUtc).toBe('2026-10-17T00:00:00.000Z');
    expect(w.windowEndUtc).toBe('2026-11-16T03:17:00.000Z');
    expect(w.buckets).toEqual([2963, 2964, 2965, 2966, 2967]);
    expect(w.currentBucket).toBe(2967);
    expect(w.weights[2963]).toBeCloseTo(5 / 7, 6);
    for (const b of [2964, 2965, 2966, 2967]) expect(w.weights[b]).toBe(1);
  });

  it('slides by one day: the oldest week loses 1/7 per day, then drops out', () => {
    const at = (iso: string) => getRollingWindow(new Date(iso));
    expect(at('2026-11-17T03:17:00Z').weights[2963]).toBeCloseTo(4 / 7, 6);
    expect(at('2026-11-20T03:17:00Z').weights[2963]).toBeCloseTo(1 / 7, 6);
    const d = at('2026-11-21T03:17:00Z'); // start Oct 22 = start of 2964
    expect(d.buckets[0]).toBe(2964);
    expect(d.weights[2964]).toBe(1);
  });

  it('covers 30 days of weight: complete weeks + partial oldest + elapsed current days', () => {
    for (const iso of ['2026-11-16T03:17:00Z', '2026-11-12T03:17:00Z', '2026-11-19T23:00:00Z']) {
      const now = new Date(iso);
      const w = getRollingWindow(now);
      const current = w.buckets.at(-1)!;
      const elapsedCurrentDays = (Math.floor(now.getTime() / 86_400_000) * 86_400 - current * BUCKET_SEC) / 86_400;
      const days = w.buckets.slice(0, -1).reduce((s, b) => s + 7 * w.weights[b], 0) + elapsedCurrentDays;
      expect(days, iso).toBeCloseTo(30, 4);
    }
  });
});

describe('getRollingWindow — cut at the current patch', () => {
  const NOW = new Date('2026-11-16T03:17:00Z'); // current bucket 2967 started 2026-11-12
  const at = (patchReleasedUtc: string | null, now = NOW) => getRollingWindow(now, 30, { patchName: '7.42', patchReleasedUtc });

  it('a patch older than 30 days changes nothing', () => {
    const w = at('2026-03-24T00:50:59.580Z');
    expect(w.patch.mode).toBe('FULL_WINDOW_SAME_PATCH');
    expect(w).toMatchObject({ buckets: [2963, 2964, 2965, 2966, 2967], windowStartUtc: '2026-10-17T00:00:00.000Z' });
    expect(w.effectiveDays).toBeCloseTo(30 + 3.2 / 24, 2);
  });

  it('no patch date → plain 30 days (logged as NO_PATCH_DATE)', () => {
    expect(at(null).patch.mode).toBe('NO_PATCH_DATE');
    expect(at(null).windowStartUtc).toBe('2026-10-17T00:00:00.000Z');
  });

  it('a patch 12 days ago cuts the previous patch off entirely', () => {
    // released Wed 2026-11-04 00:00 → bucket 2965 (Oct 29–Nov 5) keeps 1 of 7 days
    const w = at('2026-11-04T00:00:00Z');
    expect(w.patch.mode).toBe('CUT_AT_PATCH');
    expect(w.windowStartUtc).toBe('2026-11-04T00:00:00.000Z');
    expect(w.buckets).toEqual([2965, 2966, 2967]);
    expect(w.weights[2965]).toBeCloseTo(1 / 7, 6);
    expect(w.weights[2966]).toBe(1);
    expect(w.weights[2967]).toBe(1);
    expect(w.patch.prePatchWeight).toBeNull();
  });

  it('a patch 2 days ago: filled up to 7 days, pre-patch days at weight 0.25', () => {
    // released Sat 2026-11-14 00:00; minimum window starts Mon 2026-11-09 00:00
    const w = at('2026-11-14T00:00:00Z');
    expect(w.patch).toMatchObject({ mode: 'YOUNG_PATCH_FILLED', prePatchWeight: 0.25 });
    expect(w.windowStartUtc).toBe('2026-11-09T00:00:00.000Z');
    expect(w.buckets).toEqual([2966, 2967]);
    // 2966 = Nov 5–12: Nov 9–12 (3 days) pre-patch at 0.25 → 0.75/7
    expect(w.weights[2966]).toBeCloseTo(0.75 / 7, 6);
    // 2967 live = Nov 12 00:00 → Nov 16 03:17: 2 days pre-patch at 0.25 + 2d 3h17m post-patch
    const covered = 4 + 3.2833 / 24;
    expect(w.weights[2967]).toBeCloseTo((2 * 0.25 + (covered - 2)) / covered, 3);
    expect(w.effectiveDays).toBeCloseTo(5 * 0.25 + (2 + 3.2833 / 24), 2);
  });

  it('the new patch dominates the old one in a young window', () => {
    const w = at('2026-11-14T00:00:00Z');
    const newDays = 2 + 3.2833 / 24;
    expect(newDays / w.effectiveDays).toBeGreaterThan(0.6);
  });

  it('rejects a release date in the future', () => {
    expect(() => at('2026-11-20T00:00:00Z')).toThrow(/in the future/);
  });
});
