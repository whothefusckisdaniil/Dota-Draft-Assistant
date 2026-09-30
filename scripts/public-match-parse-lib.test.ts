/**
 * Tests for the pure helpers behind ТЗ §23.
 *
 * These exist because previous research rounds shipped unverified maths
 * (ТЗ §21.1 caught an invalid Spearman). This module is free of network and
 * side effects, so the logic can be checked without touching the API.
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateEnrichment,
  baselineGuard,
  classifyEnrichmentStage,
  classifyJobStatus,
  classifyParseStatus,
  classifyPostResponse,
  classifyPurchaseEvent,
  enrichmentDelta,
  extractParseJobId,
  fieldCoverage,
  isDefinitiveUnparsed,
  isTerminalJobState,
  normaliseJobState,
  pickSamplePerBucket,
  selectEnqueueable,
  validPurchaseTimestamp,
  wilsonInterval,
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

describe('wilsonInterval — a point estimate is not a rate (§20)', () => {
  it('returns null for 0/0 rather than a fake interval', () => {
    expect(wilsonInterval(0, 0)).toBeNull();
  });

  it('brackets the point estimate', () => {
    const ci = wilsonInterval(12, 16);
    expect(ci.point).toBeCloseTo(0.75, 10);
    expect(ci.low).toBeLessThan(0.75);
    expect(ci.high).toBeGreaterThan(0.75);
    expect(ci.n).toBe(16);
  });

  it('stays inside [0,1] at the extremes', () => {
    for (const [s, n] of [[0, 16], [16, 16], [1, 1], [0, 1]]) {
      const ci = wilsonInterval(s, n);
      expect(ci.low).toBeGreaterThanOrEqual(0);
      expect(ci.high).toBeLessThanOrEqual(1);
    }
  });

  it('is wider for small n than for large n', () => {
    const small = wilsonInterval(6, 16);
    const large = wilsonInterval(600, 1600);
    expect(small.high - small.low).toBeGreaterThan(large.high - large.low);
  });
});

describe('classifyPurchaseEvent — negative times are VALID (§13)', () => {
  it('treats pre-horn purchases as valid, not as errors', () => {
    // ТЗ §23 observed fairy_fire@-59, branches@-59, tango@-47.
    expect(classifyPurchaseEvent({ time: -59 }, 1800)).toBe('valid');
    expect(classifyPurchaseEvent({ time: -47 }, 1800)).toBe('valid');
  });

  it('accepts times inside the match', () => {
    expect(classifyPurchaseEvent({ time: 0 }, 1800)).toBe('valid');
    expect(classifyPurchaseEvent({ time: 1800 }, 1800)).toBe('valid');
  });

  it('flags only a purchase after the match ended', () => {
    expect(classifyPurchaseEvent({ time: 1801 }, 1800)).toBe('after_duration');
  });

  it('flags non-numeric times', () => {
    expect(classifyPurchaseEvent({ time: '12' }, 1800)).toBe('invalid_type');
    expect(classifyPurchaseEvent({}, 1800)).toBe('invalid_type');
    expect(classifyPurchaseEvent(null, 1800)).toBe('invalid_type');
  });

  it('does not invent a duration', () => {
    expect(classifyPurchaseEvent({ time: 9999 }, 0)).toBe('valid');
  });

  it('never disagrees with validPurchaseTimestamp about out-of-range', () => {
    for (const t of [-59, 0, 500, 1801]) {
      expect(classifyPurchaseEvent({ time: t }, 1800) === 'after_duration')
        .toBe(validPurchaseTimestamp(t, 1800) === 'after_duration');
    }
  });
});

describe('pickSamplePerBucket — per-bucket cap, public first (§3)', () => {
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

describe('classifyEnrichmentStage — four layers, never one verdict (§9)', () => {
  const detail = (over = {}) => ({
    od_data: { has_parsed: true },
    duration: 1800,
    players: Array.from({ length: 10 }, () => ({ purchase_log: [{ key: 'boots', time: 300 }] })),
    ...over,
  });

  it('reports usable when every layer passes', () => {
    const r = classifyEnrichmentStage({ postOk: true, jobCompleted: 'completed', detail: detail() });
    expect(r.stage).toBe('usable');
    expect(r.layer).toBe('D');
  });

  it('reports post_failed before anything else is consulted', () => {
    expect(classifyEnrichmentStage({ postOk: false, jobCompleted: 'completed', detail: detail() }).stage)
      .toBe('post_failed');
  });

  it('keeps timeout, unknown and pending distinct in jobState, not in the stage (§8)', () => {
    // These are auxiliary observations, not verdicts: the parse either happened
    // or it did not, and `has_parsed` decides that. Gating on the job state was
    // the bug this run exposed (12/16 parsed, reported as 0/16 usable).
    for (const s of ['TIMEOUT', 'UNKNOWN', 'PENDING', 'failed']) {
      const r = classifyEnrichmentStage({ postOk: true, jobCompleted: s, detail: detail() });
      expect(r.jobState, s).toBe(s);
      expect(r.stage, s).toBe('usable');
    }
  });

  it('detects a roster that is not ten players', () => {
    const d = detail({ players: Array.from({ length: 9 }, () => ({ purchase_log: [] })) });
    const r = classifyEnrichmentStage({ postOk: true, jobCompleted: 'completed', detail: d });
    expect(r.stage).toBe('roster_bad');
    expect(r.layer).toBe('B');
  });

  it('treats an EMPTY purchase_log as present, not as an error (§11)', () => {
    const d = detail({ players: Array.from({ length: 10 }, () => ({ purchase_log: [] })) });
    expect(classifyEnrichmentStage({ postOk: true, jobCompleted: 'completed', detail: d }).layer).toBe('D');
  });

  it('detects a missing purchase_log field', () => {
    const d = detail({ players: Array.from({ length: 10 }, () => ({})) });
    const r = classifyEnrichmentStage({ postOk: true, jobCompleted: 'completed', detail: d });
    expect(r.stage).toBe('purchase_log_absent');
    expect(r.layer).toBe('C');
  });

  it('detects entries with no key at all', () => {
    const d = detail({ players: Array.from({ length: 10 }, () => ({ purchase_log: [{ time: 5 }] })) });
    expect(classifyEnrichmentStage({ postOk: true, jobCompleted: 'completed', detail: d }).stage)
      .toBe('items_unkeyed');
  });
});

describe('aggregateEnrichment — the funnel and its raw counts (§10/§14)', () => {
  const mk = (id, over = {}) => ({
    matchId: id, postOk: true, jobStatus: 'completed',
    detail: {
      od_data: { has_parsed: true }, duration: 1000,
      // Ten players: Layer B requires exactly 10, so a short roster would make
      // the whole funnel vacuously empty and hide what these tests measure.
      players: [
        { purchase_log: [{ key: 'boots', time: 300 }, { key: 'tango', time: -59 }] },
        { purchase_log: [{ key: 'mystery_item', time: 900 }] },
        ...Array.from({ length: 8 }, () => ({ purchase_log: [] })),
      ],
      ...over,
    },
  });

  it('produces a non-increasing funnel', () => {
    const f = aggregateEnrichment([mk(1), mk(2)]).funnel;
    const vals = [f.post_accepted, f.job_completed, f.has_parsed, f.roster_10, f.purchase_log];
    for (let i = 1; i < vals.length; i += 1) expect(vals[i]).toBeLessThanOrEqual(vals[i - 1]);
  });

  it('counts pre-horn separately from other valid times', () => {
    const a = aggregateEnrichment([mk(1)]);
    expect(a.events).toBe(3);
    // -59 is pre-horn and still VALID; 300 and 900 are inside the 1000s match.
    expect(a.timing.preHorn).toBe(1);
    expect(a.timing.validIncludingPreHorn).toBe(3);
    expect(a.timing.after_duration).toBe(0);
  });

  it('resolves keys through the injected resolver and lists failures', () => {
    const a = aggregateEnrichment([mk(1)], { resolveKey: (k) => (k === 'mystery_item' ? null : 1) });
    expect(a.resolved).toBe(2);
    expect(a.unresolvedKeys).toEqual(['mystery_item']);
  });

  it('does not crash without a resolver', () => {
    expect(aggregateEnrichment([mk(1)]).resolved).toBe(0);
  });

  it('reports the post-hoc purchase share', () => {
    expect(aggregateEnrichment([mk(1)]).postHoc.afterHalf).toBeGreaterThan(0);
  });

  it('reports 0/0 as null intervals, not 0%', () => {
    const a = aggregateEnrichment([]);
    expect(a.total).toBe(0);
    expect(a.ci.completion).toBeNull();
    expect(a.ci.usable).toBeNull();
  });

  it('handles an all-failed sample without inventing coverage', () => {
    const a = aggregateEnrichment([{ postOk: false, jobStatus: null, detail: null }]);
    expect(a.funnel.has_parsed).toBe(0);
    expect(a.events).toBe(0);
    expect(a.ci.usable.point).toBe(0);
  });
});

describe('extractParseJobId — the id is NESTED (§25.1 §1)', () => {
  it('reads the real OpenDota shape job.jobId', () => {
    expect(extractParseJobId({ job: { jobId: 556030584 } })).toBe(556030584);
  });

  it('accepts the alternative spellings', () => {
    expect(extractParseJobId({ job: { job_id: '124' } })).toBe('124');
    expect(extractParseJobId({ jobId: '125' })).toBe('125');
    expect(extractParseJobId({ job_id: '126' })).toBe('126');
  });

  it('prefers the nested id over a flat one', () => {
    expect(extractParseJobId({ job: { jobId: 1 }, jobId: 2 })).toBe(1);
  });

  it('returns null rather than guessing', () => {
    for (const b of [{}, null, undefined, 'string', { job: null }, { err: 'x' }]) {
      expect(extractParseJobId(b), JSON.stringify(b)).toBeNull();
    }
  });

  it('does not treat a zero id as absent', () => {
    expect(extractParseJobId({ job: { jobId: 0 } })).toBe(0);
  });
});

describe('classifyPostResponse — HTTP 200 is NOT acceptance (§25.1 §2/§11)', () => {
  it('200 with a job payload is accepted', () => {
    const r = classifyPostResponse({ job: { jobId: 123 } }, 200);
    expect(r.accepted).toBe(true);
    expect(r.status).toBe('accepted');
    expect(r.jobId).toBe(123);
  });

  it('200 with an err payload is FAILED, not accepted', () => {
    expect(classifyPostResponse({ err: { msg: 'no replay' } }, 200).status).toBe('failed');
  });

  it('200 with status failed is FAILED', () => {
    expect(classifyPostResponse({ status: 'failed' }, 200).status).toBe('failed');
  });

  it('a non-2xx status is FAILED regardless of payload', () => {
    expect(classifyPostResponse({ job: { jobId: 1 } }, 400).status).toBe('failed');
    expect(classifyPostResponse({ job: { jobId: 1 } }, 500).reason).toBe('http_500');
  });

  it('200 with neither job nor error is UNKNOWN, never failed', () => {
    const r = classifyPostResponse({}, 200);
    expect(r.status).toBe('unknown');
    expect(r.accepted).toBe(false);
  });

  it('a queued status without a job id still counts as accepted', () => {
    const r = classifyPostResponse({ status: 'pending' }, 200);
    expect(r.accepted).toBe(true);
    expect(r.jobId).toBeNull();
  });
});

describe('job state normalisation (§25.1 §5/§6)', () => {
  it('maps every case to one of the four states', () => {
    expect(normaliseJobState('pending')).toBe('pending');
    expect(normaliseJobState('PENDING')).toBe('pending');
    expect(normaliseJobState('completed')).toBe('completed');
    expect(normaliseJobState('failed')).toBe('failed');
    expect(normaliseJobState('weird')).toBe('unknown');
    expect(normaliseJobState(null)).toBe('unknown');
  });

  it('keeps unknown and failed as different answers', () => {
    expect(normaliseJobState('weird')).not.toBe('failed');
    expect(normaliseJobState(null)).not.toBe('failed');
  });

  it('treats only completed and failed as terminal', () => {
    expect(isTerminalJobState('completed')).toBe(true);
    expect(isTerminalJobState('failed')).toBe(true);
    expect(isTerminalJobState('pending')).toBe(false);
    expect(isTerminalJobState('timeout')).toBe(false);
    expect(isTerminalJobState('unknown')).toBe(false);
  });
});

