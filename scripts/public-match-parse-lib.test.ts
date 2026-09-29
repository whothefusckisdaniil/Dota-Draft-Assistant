/**
 * Tests for the pure helpers behind ТЗ §23.
 *
 * These exist because previous research rounds shipped unverified maths
 * (ТЗ §21.1 caught an invalid Spearman). This module is free of network and
 * side effects, so the logic can be checked without touching the API.
 */
import { describe, expect, it } from 'vitest';
import {
  baselineGuard,
  classifyJobStatus,
  classifyParseStatus,
  enrichmentDelta,
  fieldCoverage,
  isDefinitiveUnparsed,
  pickSamplePerBucket,
  selectEnqueueable,
  validPurchaseTimestamp,
} from './public-match-parse-lib.mjs';

describe('classifyParseStatus — three-valued, never a guess (§5)', () => {
  it('trusts od_data when the match reports it', () => {
    expect(classifyParseStatus({ odData: { has_parsed: true } })).toBe('already_parsed');
    expect(classifyParseStatus({ odData: { has_parsed: false } })).toBe('not_parsed');
  });

  it('treats a parsed-index HIT as already_parsed', () => {
    expect(classifyParseStatus({ inParsedIndex: true })).toBe('already_parsed');
  });

  it('treats a parsed-index MISS as unknown, not as not_parsed', () => {
    // /parsedMatches returns only the most recent page, so a miss proves nothing.
    expect(classifyParseStatus({ inParsedIndex: false })).toBe('unknown');
  });

  it('reports not_parsed only when the index is declared exhaustive', () => {
    expect(classifyParseStatus({ inParsedIndex: false, indexExhaustive: true })).toBe('not_parsed');
  });

  it('returns unknown when neither signal is available', () => {
    expect(classifyParseStatus({})).toBe('unknown');
    expect(classifyParseStatus()).toBe('unknown');
  });

  it('does not let a missing od_data key masquerade as a verdict', () => {
    // od_data present but has_parsed absent -> no verdict from that source.
    expect(classifyParseStatus({ odData: { has_api: true } })).toBe('unknown');
  });
});

describe('classifyJobStatus — job vocabulary (§7)', () => {
  it('maps every known success synonym', () => {
    for (const s of ['ok', 'success', 'done', 'completed', 'Complete', 'SUCCESS']) {
      expect(classifyJobStatus(s), s).toBe('completed');
    }
  });

  it('maps every known pending synonym', () => {
    for (const s of ['pending', 'processing', 'queued', 'running', 'in_progress']) {
      expect(classifyJobStatus(s), s).toBe('pending');
    }
  });

  it('treats an error payload as failed regardless of the status field', () => {
    expect(classifyJobStatus({ status: 'pending', error: { msg: 'no replay' } })).toBe('failed');
  });

  it('leaves anything unrecognised as unknown rather than guessing', () => {
    expect(classifyJobStatus('weird-new-state')).toBe('unknown');
    expect(classifyJobStatus(null)).toBe('unknown');
    expect(classifyJobStatus({})).toBe('unknown');
  });
});

describe('validPurchaseTimestamp — classified, not dropped (§15)', () => {

describe('fieldCoverage — fixed denominator (§8/§9)', () => {
  const players = [
    { lane_role: 1, purchase_log: [{ key: 1 }], backpack: [] },
    { lane_role: 2, purchase_log: [], backpack: [] },
    { lane_role: null, purchase_log: null, backpack: null },
  ];

  it('counts only genuinely populated values', () => {
    expect(fieldCoverage(players, 'lane_role')).toEqual({ present: 2, total: 3, ratio: 2 / 3 });
  });

  it('treats an empty array as absent', () => {
    expect(fieldCoverage(players, 'purchase_log').present).toBe(1);
    expect(fieldCoverage(players, 'backpack').present).toBe(0);
  });

  it('handles an empty roster without dividing by zero', () => {
    expect(fieldCoverage([], 'lane_role')).toEqual({ present: 0, total: 0, ratio: 0 });
  });

  it('counts numeric zero as absent (OpenDota uses 0 for "no item")', () => {
    expect(fieldCoverage([{ item_0: 0 }, { item_0: 145 }], 'item_0').present).toBe(1);
  });
});

describe('enrichmentDelta — before vs after (§9)', () => {
  it('reports the exact movement', () => {
    expect(enrichmentDelta({ present: 0, total: 10 }, { present: 10, total: 10 }))
      .toEqual({ before: '0/10', after: '10/10', delta: 10, changed: true });
  });

  it('reports no change honestly', () => {
    expect(enrichmentDelta({ present: 0, total: 10 }, { present: 0, total: 10 }).changed).toBe(false);
  });

  it('can report a REGRESSION, not only growth', () => {
    const d = enrichmentDelta({ present: 4, total: 10 }, { present: 1, total: 10 });
    expect(d.delta).toBe(-3);
    expect(d.changed).toBe(true);
  });
});

describe('isDefinitiveUnparsed — the baseline gate (ТЗ §23.1 §3-§4)', () => {
  it('accepts an explicit has_parsed === false', () => {
    expect(isDefinitiveUnparsed({ od_data: { has_parsed: false } })).toBe(true);
  });

  it('rejects has_parsed === undefined — it must never become not_parsed', () => {
    expect(isDefinitiveUnparsed({ od_data: { has_parsed: undefined } })).toBe(false);
    expect(isDefinitiveUnparsed({ od_data: {} })).toBe(false);
    expect(isDefinitiveUnparsed({ od_data: { has_api: true } })).toBe(false);
  });

  it('rejects a missing od_data entirely', () => {
    expect(isDefinitiveUnparsed({})).toBe(false);
    expect(isDefinitiveUnparsed({ od_data: null })).toBe(false);
    expect(isDefinitiveUnparsed(undefined)).toBe(false);
  });

  it('rejects a parsed match', () => {
    expect(isDefinitiveUnparsed({ od_data: { has_parsed: true } })).toBe(false);
  });

  it('does not treat a truthy-but-wrong value as false', () => {
    // e.g. has_parsed: 0 or "" must not sneak through as a false value.
    expect(isDefinitiveUnparsed({ od_data: { has_parsed: 0 } })).toBe(false);
    expect(isDefinitiveUnparsed({ od_data: { has_parsed: '' } })).toBe(false);
  });
});

describe('selectEnqueueable — budget, public, bucket (ТЗ §23.1 §1)', () => {
  const buckets = [
    { key: 'herald_guardian', min: 10, max: 15 },
    { key: 'divine_immortal', min: 40, max: 45 },
  ];
  const row = (id, tier, over = {}) => ({
    listing: { match_id: id, avg_rank_tier: tier },
    detail: { od_data: { has_parsed: false }, leagueid: 0, ...over },
    bucketDef: buckets.find((b) => tier >= b.min && tier <= b.max) ?? buckets[0],
    bucket: `t${tier}`,
  });

  it('never exceeds the budget', () => {
    const rows = [row(1, 12), row(2, 13), row(3, 42), row(4, 43), row(5, 44)];
    expect(selectEnqueueable(rows, buckets, 4).length).toBeLessThanOrEqual(4);
  });

  it('spreads the budget across buckets instead of spending it on one', () => {
    const rows = [row(1, 12), row(2, 13), row(3, 14), row(4, 42), row(5, 43)];
    const picked = selectEnqueueable(rows, buckets, 2);
    expect(new Set(picked.map((r) => r.bucketDef.key)).size).toBe(2);
  });

  it('excludes anything not definitively unparsed', () => {
    const rows = [row(1, 12), row(2, 42, { od_data: { has_parsed: undefined } }), row(3, 43, { od_data: { has_parsed: true } })];
    expect(selectEnqueueable(rows, buckets, 4).map((r) => r.listing.match_id)).toEqual([1]);
  });

  it('excludes league/pro matches', () => {
    const rows = [row(1, 12), row(2, 42, { leagueid: 999 })];
    expect(selectEnqueueable(rows, buckets, 4).map((r) => r.listing.match_id)).toEqual([1]);
  });

  it('excludes matches whose tier is outside every bucket', () => {
    expect(selectEnqueueable([row(1, 25)], buckets, 4)).toEqual([]);
  });
});

describe('baselineGuard — a thin sample is reported, not faked (ТЗ §23.1 §5)', () => {
  it('passes when the baseline meets the requirement', () => {
    const g = baselineGuard(5, 5);
    expect(g.usable).toBe(true);
    expect(g.text).toBe('5/5 definitive unparsed');
  });

  it('refuses to pass below the requirement', () => {
    const g = baselineGuard(3, 5);
    expect(g.usable).toBe(false);
    expect(g.text).toContain('unavailable');
    expect(g.text).toContain('3');
  });

  it('never invents a denominator of zero into a pass', () => {
    expect(baselineGuard(0, 5).usable).toBe(false);
  });
});

describe('pickSamplePerBucket — 2 per bucket, public first (§3)', () => {
  const buckets = [
    { key: 'herald_guardian', min: 10, max: 15 },
    { key: 'divine_immortal', min: 40, max: 45 },
  ];
  const listing = [
    { match_id: 1, avg_rank_tier: 12, leagueid: 0, start_time: 100 },
    { match_id: 2, avg_rank_tier: 13, leagueid: 77, start_time: 300 },
    { match_id: 3, avg_rank_tier: 14, leagueid: 0, start_time: 200 },
    { match_id: 4, avg_rank_tier: 14, leagueid: 0, start_time: 250 },
    { match_id: 5, avg_rank_tier: 42, leagueid: 0, start_time: 400 },
    { match_id: 6, avg_rank_tier: 44, leagueid: 0, start_time: 500 },
    { match_id: 7, avg_rank_tier: 44, leagueid: 0, start_time: 600 },
    { match_id: 8, avg_rank_tier: 44, leagueid: 0, start_time: 700 },
  ];

  it('never exceeds the per-bucket cap', () => {
    expect(pickSamplePerBucket(listing, buckets, 2)).toHaveLength(4);
  });

  it('keeps league/pro rows out ahead of public ones', () => {
    const hg = pickSamplePerBucket(listing, buckets, 2).filter((m) => m.bucket === 'herald_guardian');
    expect(hg.every((m) => (m.leagueid ?? 0) === 0)).toBe(true);
  });

  it('orders by newest within the same league', () => {
    const di = pickSamplePerBucket(listing, buckets, 2).filter((m) => m.bucket === 'divine_immortal');
    expect(di.map((m) => m.start_time)).toEqual([700, 600]);
  });

  it('ignores matches outside every requested bucket', () => {
    expect(pickSamplePerBucket([{ match_id: 9, avg_rank_tier: 25, start_time: 1 }], buckets, 2)).toEqual([]);
  });
});

  it('accepts a timestamp inside the match', () => {
    expect(validPurchaseTimestamp(0, 1800)).toBe('valid');
    expect(validPurchaseTimestamp(1799, 1800)).toBe('valid');
  });

  it('rejects negative and non-numeric values, and says which', () => {
    expect(validPurchaseTimestamp(-1, 1800)).toBe('negative');
    expect(validPurchaseTimestamp('12', 1800)).toBe('invalid_type');
    expect(validPurchaseTimestamp(NaN, 1800)).toBe('invalid_type');
    expect(validPurchaseTimestamp(undefined, 1800)).toBe('invalid_type');
  });

  it('rejects a purchase after the match ended', () => {
    expect(validPurchaseTimestamp(2000, 1800)).toBe('after_duration');
  });

  it('does not invent a duration when none is known', () => {
    expect(validPurchaseTimestamp(9999, 0)).toBe('valid');
  });
});
