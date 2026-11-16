import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BRACKETS, BUCKET_SEC, buildChunkQuery } from './update-data-stratz.mjs';
import { canonicalJsonSha256 } from './stratz-matchup-root-cause-research.mjs';
import {
  EXPECTED_PHYSICAL_SHA256,
  FIX15_FROZEN_ARTIFACT_SHA256,
  captureSourceHashes,
  median,
  scanForCredentials,
  setEscalationStatus,
  verifySourceHashes,
} from './stratz-external-source-research.mjs';
import {
  FIX16_PATHS,
  PROTECTED_SHA256,
  analyzeMonotonicityGroups,
  analyzeRangeTimeOrder,
  analyzeTimeOrder,
  assessBoundaries,
  buildFix16,
  captureProtectedHashes,
  checkRangeContinuity,
  checkTotalsConsistency,
  classifyHeroArrays,
  coverageStatsSql,
  deriveCoverageStatus,
  mergeStats,
  parseStatsRow,
  summarizeHeroArrays,
  verifyProtectedHashes,
} from './stratz-opendota-coverage-validation.mjs';

const ROOT = new URL('../', import.meta.url);
const read = (relative: string) => readFileSync(new URL(relative, ROOT));
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const outputs = buildFix16();
const evidence = JSON.parse(outputs[FIX16_PATHS.evidence]);
const escalationJson = JSON.parse(outputs[FIX16_PATHS.escalationJson]);
const escalationMd: string = outputs[FIX16_PATHS.escalationMd];
const BUCKETS = [2963, 2964, 2965, 2966];
const WS = 2963 * BUCKET_SEC;
const WE = 2967 * BUCKET_SEC;
const rec = (id: number, t: number) => ({ match_id: id, start_time: t });

describe('FIX15 corrections', () => {
  it('1. median of an even count is the mean of the two central values', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([0.4, 0.5])).toBeCloseTo(0.45, 12);
    const c = evidence.medianCorrection;
    expect(c.values % 2).toBe(0);
    expect(c.corrected).toBeCloseTo((c.centralValues[0] + c.centralValues[1]) / 2, 12);
    expect(c.fix15Recorded).toBe(c.centralValues[1]);
  });

  it('2. median of an odd count is the central value; empty input → null', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([7])).toBe(7);
    expect(median([])).toBeNull();
    expect(median([NaN, 2, Infinity, 4, 3])).toBe(3);
  });

  it('3. update-data-stratz.mjs is protected; any change to it is detected', () => {
    const hashes = captureSourceHashes();
    expect(hashes.productionModule.path).toBe('scripts/update-data-stratz.mjs');
    expect(hashes.productionModule.physicalSha256).toBe(sha(read('scripts/update-data-stratz.mjs')));
    expect(EXPECTED_PHYSICAL_SHA256.productionModule).toBe(hashes.productionModule.physicalSha256);
    expect(() => verifySourceHashes({ ...hashes, productionModule: { physicalSha256: sha('changed') } })).toThrow(/productionModule/);
    // The protected module is where BRACKETS, BUCKET_SEC and buildChunkQuery come from.
    expect(BRACKETS).toEqual(['HERALD_GUARDIAN', 'CRUSADER_ARCHON', 'LEGEND_ANCIENT', 'DIVINE_IMMORTAL']);
    expect(BUCKET_SEC).toBe(604800);
    expect(buildChunkQuery([58, 61], BUCKETS)).toContain('bracketBasicIds');
  });
});

describe('match_id range enumeration', () => {
  it('4. contiguous ranges are accepted; the FIX15 enumeration is contiguous', () => {
    const result = checkRangeContinuity([{ fromId: 0, toId: 10 }, { fromId: 10, toId: 25 }, { fromId: 25, toId: 30 }], { fromId: 0, toId: 30 });
    expect(result).toMatchObject({ status: 'CONTIGUOUS', gaps: [], overlaps: [], summedRangeIds: 30, idSpan: 30 });
    const fix15 = evidence.rangeContinuity.fix15Enumeration;
    expect(fix15).toMatchObject({ status: 'CONTIGUOUS', rangeCount: 152, gaps: [], overlaps: [], invalidRanges: [] });
    expect(fix15.summedRangeIds).toBe(fix15.idSpan);
  });

  it('5. gaps are detected, including leading/trailing gaps against the expected span', () => {
    const result = checkRangeContinuity([{ fromId: 5, toId: 10 }, { fromId: 12, toId: 20 }], { fromId: 0, toId: 25 });
    expect(result.status).toBe('NOT_CONTIGUOUS');
    expect(result.gaps).toEqual([
      { fromId: 0, toId: 5, ids: 5, edge: 'LEADING' },
      { fromId: 10, toId: 12, ids: 2 },
      { fromId: 20, toId: 25, ids: 5, edge: 'TRAILING' },
    ]);
  });

  it('6. overlaps and invalid ranges are detected', () => {
    const result = checkRangeContinuity([{ fromId: 0, toId: 10 }, { fromId: 8, toId: 20 }, { fromId: 20, toId: 20 }]);
    expect(result.status).toBe('NOT_CONTIGUOUS');
    expect(result.overlaps).toEqual([{ fromId: 8, toId: 10, ids: 2 }]);
    expect(result.invalidRanges).toEqual([[20, 20]]);
  });

  it('7. match_id → start_time monotonicity is tested, not assumed', () => {
    const strict = analyzeTimeOrder([rec(1, 10), rec(2, 11), rec(3, 12)]);
    expect(strict.status).toBe('STRICTLY_INCREASING');
    expect(analyzeTimeOrder([rec(1, 10), rec(2, 10)]).status).toBe('NON_DECREASING');
    const noisy = analyzeTimeOrder([rec(1, 100), rec(2, 500), rec(3, 200), rec(4, 300), rec(5, 6000)], { largeJumpSec: 3600 });
    expect(noisy).toMatchObject({ status: 'NOT_MONOTONIC', backwardSteps: 1, maxBackwardStepSec: 300, recordsBelowRunningMax: 2, maxDropBelowRunningMaxSec: 300, largeJumpCount: 1 });
    const ranges = analyzeRangeTimeOrder([{ fromId: 0, minStart: 0, maxStart: 100 }, { fromId: 10, minStart: 90, maxStart: 200 }, { fromId: 20, minStart: 50, maxStart: 300 }]);
    expect(ranges).toMatchObject({ adjacentOverlaps: 2, maxAdjacentOverlapSec: 150, minStartDecreases: 1, maxCrossRangeDropSec: 150 });
    // Real data: strict monotonicity is refuted; the deviation is measured.
    const m = evidence.timestampMonotonicity;
    expect(m.result).toBe('REFUTED_STRICT_MONOTONICITY');
    expect(m.allRowsWithinMainRanges.backwardSteps).toBeGreaterThan(0);
    expect(m.maxObservedDropSec).toBe(Math.max(...Object.values(m.maxDropByGroupSec) as number[], m.fix15RangeAggregates.maxCrossRangeDropSec));
    expect(m.groups).toMatchObject({ contiguousChain: true, failedOrUnmeasuredRanges: [] });
    expect(Object.keys(m.groups.withinRanges).sort()).toEqual(['extension-above', 'extension-below', 'main']);
    expect(m.groups.withinRanges.main.ranges).toBe(152);
  });

  it('7b. per-group drops include split sub-range borders and extensions; the global drop is exact', () => {
    const order = (drop: number, back = drop ? 1 : 0) => ({ backwardSteps: back, equalSteps: 0, forwardSteps: 1, largeJumps: 0, maxBackwardStepSec: drop, maxDropBelowRunningMaxSec: drop });
    const r = (role: string, side: string | null, fromId: number, toId: number, minStart: number, maxStart: number, drop = 0) =>
      ({ role, side, fromId, toId, status: 'OK', stats: { rows: 2, minStart, maxStart, order: order(drop) } });
    const ranges = [
      r('extension', 'below', 0, 10, 0, 100),
      r('fix15-range', null, 10, 15, 90, 200, 5), // FIX15 chunk [10,20) split at 15
      r('fix15-range', null, 15, 20, 150, 300), // split border: running max 200 → drop 50
      r('fix15-range', null, 20, 30, 280, 400), // chunk border: drop 20
      r('extension', 'above', 30, 40, 330, 500), // main → extension: drop 70
    ];
    const g = analyzeMonotonicityGroups(ranges, [[10, 20], [20, 30]]);
    expect(g.acrossBorders['extension-below->main'].maxDropBelowRunningMaxSec).toBe(10);
    expect(g.acrossBorders['main-split-subrange-border'].maxDropBelowRunningMaxSec).toBe(50);
    expect(g.acrossBorders['main-fix15-chunk-border'].maxDropBelowRunningMaxSec).toBe(20);
    expect(g.acrossBorders['main->extension-above'].maxDropBelowRunningMaxSec).toBe(70);
    expect(g.withinRanges.main).toMatchObject({ ranges: 3, maxDropBelowRunningMaxSec: 5, worstRange: [10, 15] });
    expect(g.globalMaxDropBelowRunningMaxSec).toBe(70);
    expect(g.contiguousChain).toBe(true);
    const broken = analyzeMonotonicityGroups([ranges[0], { ...ranges[1], status: 'FAILED', stats: null }, ranges[2]]);
    expect(broken.contiguousChain).toBe(false);
    expect(broken.failedOrUnmeasuredRanges).toEqual([[10, 15]]);
  });

  it('range status: no FAILED or INCOMPLETE ranges', () => {
    expect(evidence.rangeStatus).toMatchObject({ failed: 0, fix15RangesFullyRemeasured: 152, fix15RangesIncomplete: [], fix15ChunkStatus: { ok: 152, failed: 0 } });
    expect(evidence.rangeStatus.byRole.extension).toBeGreaterThanOrEqual(3);
  });
});

describe('hero arrays', () => {
  it('8. null arrays are NULL_ARRAY, never zeroed', () => {
    const result = classifyHeroArrays({ radiant_team: null, dire_team: [1, 2, 3, 4, 5] });
    expect(result).toMatchObject({ primary: 'NULL_ARRAY', classifiable: false, flags: { nullArray: true, zeroed: false } });
    expect(classifyHeroArrays({ dire_team: [1, 2, 3, 4, 5] }).primary).toBe('NULL_ARRAY');
    expect(classifyHeroArrays({ radiant_team: [1, null, 3, 4, 5], dire_team: [6, 7, 8, 9, 10] }).primary).toBe('NULL_ELEMENT');
    expect(coverageStatsSql(0, 1, BUCKETS)).toMatch(/radiant_team IS NULL OR dire_team IS NULL THEN 'NULL_ARRAY'/);
  });

  it('9. zeroed hero ids are ZEROED_HERO and counted separately from null', () => {
    const summary = summarizeHeroArrays([
      { radiant_team: [0, 0, 0, 0, 0], dire_team: [0, 0, 0, 0, 0] },
      { radiant_team: null, dire_team: null },
      { radiant_team: [1, 2, 3, 4, 5], dire_team: [6, 7, 8, 9, 10] },
    ]);
    expect(summary.byClass).toMatchObject({ ZEROED_HERO: 1, NULL_ARRAY: 1, COMPLETE: 1 });
    expect(summary.flags).toMatchObject({ zeroed: 1, nullArray: 1 });
    expect(summary.unclassifiable).toBe(2);
    const h = evidence.heroArrays.inWindow;
    expect(Object.values(h.byClass).reduce((a: number, b: any) => a + b, 0)).toBe(h.rows);
    expect(h.unclassifiable).toBe(h.rows - h.byClass.COMPLETE);
  });

  it('10. incomplete team arrays are INCOMPLETE_ARRAY (flags stay non-exclusive)', () => {
    const result = classifyHeroArrays({ radiant_team: [1, 2, 3, 0], dire_team: [6, 7, 8, 9, 10] });
    expect(result.primary).toBe('INCOMPLETE_ARRAY');
    expect(result.flags).toMatchObject({ incomplete: true, zeroed: true, nullArray: false });
    expect(classifyHeroArrays({ radiant_team: [1, 2, 3, 4, 5, 6], dire_team: [6, 7, 8, 9, 10] }).primary).toBe('INCOMPLETE_ARRAY');
    const l = evidence.externalCoverageLimitations.nullOrIncompleteHeroArrays;
    expect(l).toEqual({ nullArray: evidence.heroArrays.inWindow.byClass.NULL_ARRAY, incompleteArray: evidence.heroArrays.inWindow.byClass.INCOMPLETE_ARRAY, nullElement: evidence.heroArrays.inWindow.byClass.NULL_ELEMENT });
  });
});

describe('boundaries, out-of-window, coverage', () => {
  const enumerated = { fromId: 100, toId: 200, firstStart: WS - 2 * 86400, lastStart: WE + 86400, firstInWindowMatchId: 120, lastInWindowMatchId: 180 };
  const ext = (side: string, inWindow: number) => ({ side, fromId: 0, toId: 1, stats: { rows: 10, inWindow, minStart: 0, maxStart: 1 } });

  it('11. boundary margin: supported only with positive margins, empty extensions and small drift', () => {
    const ok = assessBoundaries({ windowStart: WS, windowEnd: WE, enumerated, extensions: [ext('below', 0), ext('above', 0)], maxObservedDropSec: 700 });
    expect(ok).toMatchObject({ status: 'BOUNDARIES_EMPIRICALLY_SUPPORTED', proof: 'NOT_A_PROOF', lowerMarginSec: 2 * 86400, upperMarginSec: 86400 });
    expect(assessBoundaries({ windowStart: WS, windowEnd: WE, enumerated, extensions: [ext('below', 3)], maxObservedDropSec: 700 }).status).toBe('BOUNDARIES_NOT_SUPPORTED');
    expect(assessBoundaries({ windowStart: WS, windowEnd: WE, enumerated, extensions: [], maxObservedDropSec: 2 * 86400 }).status).toBe('BOUNDARIES_NOT_SUPPORTED');
    expect(assessBoundaries({ windowStart: WS, windowEnd: WE, enumerated, extensions: [{ side: 'above', fromId: 0, toId: 1, stats: null }], maxObservedDropSec: 1 }).status).toBe('BOUNDARIES_NOT_SUPPORTED');
    expect(evidence.boundaries.lowerMarginSec).toBeGreaterThan(0);
    expect(evidence.boundaries.upperMarginSec).toBeGreaterThan(0);
    expect(evidence.externalCoverageLimitations.boundaryMargins.status).toBe(evidence.boundaries.status);
  });

  it('12. out-of-window records are counted and kept apart from in-window totals', () => {
    const o = evidence.externalCoverageLimitations.outOfWindowRecords;
    const b = evidence.boundaries.records;
    expect(o.pairRecords).toBe(b.pairRecordsBeforeWindow + b.pairRecordsAfterWindow);
    expect(o.pairRecords).toBeGreaterThan(0);
    const totals = evidence.totalsConsistency;
    expect(totals.fix16RangeRowsTotal - o.rowsBeforeWindow - o.rowsAfterWindow).toBe(evidence.externalCoverageLimitations.totalSqlRowCounts.inWindowRows);
    expect(totals.pairRecordsOutsideTheirRange).toBe(0);
    // Range totals: a FIX15 range whose rows changed is reported, not hidden.
    const chunk = { fromId: 0, toId: 10, rangeRows: 5, rangeMinStart: 1, rangeMaxStart: 9, rows: [[3, 5]], totals: { b2963: { matches: 5, ranked: 1, zeroHero: 0 } } };
    const stats = { rows: 6, buckets: { b2963: { matches: 6, ranked: 1, zeroHero: 0 } } };
    const drift = checkTotalsConsistency([chunk], new Map([['0:10', stats]]), [2963]);
    expect(drift.status).toBe('CONSISTENT_WITH_DRIFT');
    expect(drift.rangesWithBucketDrift[0].diffs).toEqual([{ bucket: 2963, field: 'matches', fix15: 5, fix16: 6 }]);
    expect(checkTotalsConsistency([{ ...chunk, rows: [[11, 5]] }], new Map(), [2963]).status).toBe('INCONSISTENT');
  });

  it('13. source coverage never becomes COMPLETE automatically', () => {
    const perfect = deriveCoverageStatus({
      continuity: { status: 'CONTIGUOUS' },
      consistency: { status: 'CONSISTENT', internalChecks: 'PASS' },
      boundaries: { status: 'BOUNDARIES_EMPIRICALLY_SUPPORTED' },
      heroArrays: { unclassifiable: 0 },
    });
    expect(perfect).toMatchObject({ status: 'PARTIAL', classification: 'PARTIAL_MATCH_COVERAGE', enumerationIntegrity: 'PASS' });
    expect(evidence.sourceCoverage.status).toBe('PARTIAL');
    expect(evidence.sourceCoverage.classification).toBe('PARTIAL_MATCH_COVERAGE');
    expect(evidence.productionThresholdApplied).toBe(false);
    expect(evidence.rootCause).toMatchObject({ status: 'UNRESOLVED', productionPublishAllowed: false });
    expect(evidence.rootCause.categories.filter((c: any) => c.applies && c.category.endsWith('CONFIRMED'))).toEqual([]);
  });

  it('merged sub-range statistics add counts and keep maxima', () => {
    const row = (rows: number, drop: number) => parseStatsRow({ rows, min_t: 1, max_t: 2, iw: rows, b2963_matches: rows, max_drop_below_running_max: drop, backward_steps: 1 }, [2963]);
    const merged = mergeStats([row(3, 10), row(4, 50)]);
    expect(merged).toMatchObject({ rows: 7, inWindow: 7, buckets: { b2963: { matches: 7 } }, order: { backwardSteps: 2, maxDropBelowRunningMaxSec: 50 } });
  });
});

describe('STRATZ support escalation v2', () => {
  it('14. contains the Independent OpenDota reference with the required numbers', () => {
    expect(escalationMd).toContain('## Independent OpenDota reference');
    expect(escalationMd).toMatch(/Enchantress \(58\) \/ Broodmother \(61\), week 2963/);
    expect(escalationMd).toContain('301 (A→B) / 318 (B→A)');
    expect(escalationMd).toContain('907 matches');
    expect(escalationMd).toMatch(/ranged from 0\.33 to 0\.55/);
    expect(escalationJson.independentReference.example).toMatchObject({ stratzMatchCountAtoB: 301, stratzMatchCountBtoA: 318, externalMatches: 907, bucket: 2963 });
    expect(escalationMd.indexOf('## Independent OpenDota reference')).toBeLessThan(escalationMd.indexOf('## Questions'));
  });

  it('15. keeps the caveats and never claims STRATZ lost matches', () => {
    for (const text of ['Partial source coverage', 'match-average', 'Lobby type and game mode', 'no direct link between the external match IDs and STRATZ rows']) {
      expect(escalationMd).toContain(text);
    }
    expect(escalationJson.independentReference.caveats.map((c: any) => c.id)).toEqual(['partial-source-coverage', 'match-average-rank', 'lobby-game-mode', 'no-direct-link']);
    expect(escalationMd).not.toMatch(/\blost\b|45\s*[–-]\s*67\s*%|missing \d+\s*%|drops? \d+\s*%/i);
    expect(escalationMd).toContain('We do not read this as STRATZ missing matches');
    expect(escalationMd).not.toContain('dryad');
  });

  it('16. contains no credentials', () => {
    const findings = scanForCredentials(`${escalationMd}\n${outputs[FIX16_PATHS.escalationJson]}\n${read(FIX16_PATHS.raw).toString('utf8')}`, [process.env.STRATZ_API_TOKEN?.trim() ?? '']);
    expect(findings).toEqual([]);
    expect(escalationJson.credentialScan.status).toBe('CLEAN');
    expect(scanForCredentials('Authorization: Bearer abcdefghijklmnop')).not.toEqual([]);
    expect(read(FIX16_PATHS.raw).toString('utf8')).not.toMatch(/x-ip-address|"ip"/i);
  });

  it('17. status stays DRAFTED; advancing requires a human confirmation', () => {
    expect(escalationJson.status).toBe('DRAFTED');
    expect(escalationJson.statusHistory.map((s: any) => s.status)).toEqual(['DRAFTED']);
    expect(evidence.escalation.status).toBe('DRAFTED');
    expect(escalationMd).toContain('Status: **DRAFTED**');
    expect(() => setEscalationStatus(escalationJson, 'SENT', {})).toThrow(/confirmation/);
    expect(() => setEscalationStatus(escalationJson, 'ANSWERED', { confirmedBy: 'x' })).toThrow(/confirmation/);
  });
});

describe('protection and determinism', () => {
  it('18. FIX9–FIX15 artifacts are unchanged', () => {
    const hashes = captureProtectedHashes();
    expect(verifyProtectedHashes(hashes)).toBe(true);
    for (const [relative, expected] of Object.entries(FIX15_FROZEN_ARTIFACT_SHA256)) expect(sha(read(relative))).toBe(expected);
    for (const name of ['fix9Input', 'fix10Repeatability', 'fix10Report', 'fix11Evidence', 'fix11Raw', 'fix12Evidence', 'fix12Raw', 'fix13Evidence', 'fix14Evidence', 'fix14Raw']) {
      expect(hashes[name].physicalSha256).toBe(PROTECTED_SHA256[name]);
    }
    expect(() => verifyProtectedHashes({ ...hashes, 'fix15:stratz-external-match-level-raw-responses.json': { physicalSha256: 'x' } })).toThrow(/fix15/);
  });

  it('19. production data and the production module are unchanged', () => {
    for (const [name, relative] of [['productionHeroes', 'public/data/heroes.json'], ['productionMatchups', 'public/data/matchups.json'], ['productionMeta', 'public/data/meta.json'],
      ['productionPositions', 'public/data/positions.json'],
      ['productionModule', 'scripts/update-data-stratz.mjs']]) {
      expect(sha(read(relative))).toBe(PROTECTED_SHA256[name]);
    }
  });

  it('20. generation is deterministic and offline', () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const again = buildFix16();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(again).toEqual(outputs);
    expect(canonicalJsonSha256(evidence, 'evidenceSha256')).toBe(evidence.evidenceSha256);
    expect(canonicalJsonSha256(escalationJson, 'evidenceSha256')).toBe(escalationJson.evidenceSha256);
  });
});
