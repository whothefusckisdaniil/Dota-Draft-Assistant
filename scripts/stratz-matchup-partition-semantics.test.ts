import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { BRACKETS } from './update-data-stratz.mjs';
import { canonicalJsonSha256 } from './stratz-matchup-root-cause-research.mjs';
import {
  EXPECTED_PHYSICAL_SHA256,
  FIX13_FOCUS_PAIRS,
  PRODUCTION_BRACKETS,
  buildPartitionSemanticsEvidence,
  captureSourceHashes,
  compareWinsAverage,
  decimalPlaces,
  rankContributionForPairWeek,
  rateConstancyByHero,
  rateFieldAlignment,
  runFix13,
  summarizeDirectionConsistency,
  summarizePartition,
  summarizeWinsAverage,
  verifyPairWeekPartition,
  verifySourceHashes,
} from './stratz-matchup-partition-semantics.mjs';

const dir = (matchCount: number, winCount: number) => ({ matchCount, winCount });
const both = (a: [number, number], b: [number, number]) => ({ AtoB: dir(...a), BtoA: dir(...b) });

// 58:61 bucket 2963 rank decomposition from FIX12 (games A→B vs B→A; wins as recorded).
const PAIR = { canonicalPairId: '58:61', heroAId: 58, heroBId: 61, anomalyBuckets: [2963] };
const GROUPS_58_61 = {
  HERALD_GUARDIAN: both([95, 42], [96, 60]),
  CRUSADER_ARCHON: both([100, 46], [105, 59]),
  LEGEND_ANCIENT: both([73, 33], [82, 43]),
  DIVINE_IMMORTAL: both([33, 16], [35, 17]),
};
const PROD_58_61 = both([301, 137], [318, 179]);

describe('FIX13 offline guard', () => {
  it('never opens a network connection', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const source = readFileSync(new URL('./stratz-matchup-partition-semantics.mjs', import.meta.url), 'utf8');
    expect(source).not.toMatch(/StratzTransport|loadToken|fetch\(/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('production bracket partition', () => {
  it('10. takes production brackets from production configuration', () => {
    expect(PRODUCTION_BRACKETS).toEqual(BRACKETS);
    const source = readFileSync(new URL('./stratz-matchup-partition-semantics.mjs', import.meta.url), 'utf8');
    expect(source).toMatch(/import \{ BRACKETS \} from '\.\/update-data-stratz\.mjs'/);
    expect(source).not.toMatch(/'HERALD_GUARDIAN'|'DIVINE_IMMORTAL'/);
  });

  it('2. requires all four groups and passes when present', () => {
    const result = verifyPairWeekPartition(PROD_58_61, GROUPS_58_61);
    expect(result.status).toBe('PASS');
    expect(result.missing).toEqual([]);
    for (const field of Object.values(result.fields) as any[]) {
      expect(field.groups.map((g: any) => g.bracket)).toEqual([...BRACKETS]);
    }
  });

  it('3–6. sums matchCount and winCount in both directions separately', () => {
    const { fields } = verifyPairWeekPartition(PROD_58_61, GROUPS_58_61) as any;
    expect(fields.matchCountAtoB).toMatchObject({ production: 301, groupSum: 301, status: 'PASS' });
    expect(fields.matchCountBtoA).toMatchObject({ production: 318, groupSum: 318, status: 'PASS' });
    expect(fields.winCountAtoB).toMatchObject({ production: 137, groupSum: 137, status: 'PASS' });
    expect(fields.winCountBtoA).toMatchObject({ production: 179, groupSum: 179, status: 'PASS' });
  });

  it('detects a single-field failure without masking other fields', () => {
    const groups = { ...GROUPS_58_61, DIVINE_IMMORTAL: both([33, 16], [35, 18]) };
    const result = verifyPairWeekPartition(PROD_58_61, groups) as any;
    expect(result.status).toBe('FAILED');
    expect(result.fields.winCountBtoA).toMatchObject({ status: 'FAILED', difference: 1 });
    expect(result.fields.matchCountBtoA.status).toBe('PASS');
  });

  it('7. a missing group is never converted to zero', () => {
    // If missing were zero, 95+100+73+0 would not hide a mismatch — use a production
    // total that would coincidentally PASS with zero substitution.
    const groups = { ...GROUPS_58_61, DIVINE_IMMORTAL: null };
    const production = both([268, 121], [283, 162]);
    const result = verifyPairWeekPartition(production, groups) as any;
    expect(result.fields.matchCountAtoB.groupSum).toBeNull();
    expect(result.fields.matchCountAtoB.status).toBe('INCOMPLETE');
    expect(result.missing).toContainEqual({ source: 'DIVINE_IMMORTAL', field: 'matchCountAtoB' });
  });

  it('8. an incomplete pair-week never receives PASS', () => {
    const groups = { ...GROUPS_58_61, LEGEND_ANCIENT: { AtoB: dir(73, 33), BtoA: null } };
    const row = verifyPairWeekPartition(PROD_58_61, groups);
    expect(row.status).toBe('INCOMPLETE');
    const summary = summarizePartition([{ canonicalPairId: '58:61', bucket: 2963, ...row }]);
    expect(summary.status).toBe('INCOMPLETE');
    expect(summarizePartition([]).status).toBe('UNVERIFIED');
    expect(verifyPairWeekPartition(null, GROUPS_58_61).status).toBe('INCOMPLETE');
  });
});

describe('winsAverage vs winCount / matchCount', () => {
  it('11. exact ratio', () => {
    expect(compareWinsAverage({ matchCount: 4, winCount: 1, winsAverage: 0.25 }))
      .toMatchObject({ validity: 'VALID', matches: true, absoluteDifference: 0, decimalPlaces: 2 });
  });

  it('12. rounded to 3 decimals (42/95 → 0.442)', () => {
    const row = compareWinsAverage({ matchCount: 95, winCount: 42, winsAverage: 0.442 });
    expect(row).toMatchObject({ matches: true, decimalPlaces: 3, roundingTolerance: 0.0005 });
    expect(row.computedWinRatio).toBeCloseTo(0.44210526, 8);
  });

  it('13. rounded to 2 decimals and 4 decimals use their own precision', () => {
    expect(compareWinsAverage({ matchCount: 95, winCount: 42, winsAverage: 0.44 }))
      .toMatchObject({ matches: true, decimalPlaces: 2, roundingTolerance: 0.005 });
    expect(compareWinsAverage({ matchCount: 95, winCount: 42, winsAverage: 0.4421 }))
      .toMatchObject({ matches: true, decimalPlaces: 4 });
    // 4-decimal value that is off in the 4th decimal must not pass.
    expect(compareWinsAverage({ matchCount: 95, winCount: 42, winsAverage: 0.4425 }).matches).toBe(false);
  });

  it('14. accepts 0–100 scale with scaled tolerance', () => {
    expect(compareWinsAverage({ matchCount: 95, winCount: 42, winsAverage: 44.2 }))
      .toMatchObject({ scale: '0-100', matches: true });
    expect(compareWinsAverage({ matchCount: 95, winCount: 42, winsAverage: 45.2 }).matches).toBe(false);
    expect(compareWinsAverage({ matchCount: 95, winCount: 42, winsAverage: 144 }).validity).toBe('OUT_OF_RANGE');
  });

  it('15. zero matchCount is invalid, not a match', () => {
    expect(compareWinsAverage({ matchCount: 0, winCount: 0, winsAverage: 0 }))
      .toMatchObject({ validity: 'ZERO_MATCH_COUNT', matches: null });
  });

  it('16. missing values', () => {
    expect(compareWinsAverage({ matchCount: 10, winCount: 5 }).validity).toBe('MISSING_VALUE');
    expect(compareWinsAverage({ matchCount: 10, winsAverage: 0.5, winCount: null }).validity).toBe('MISSING_VALUE');
  });

  it('17. negative and non-numeric values are invalid', () => {
    expect(compareWinsAverage({ matchCount: 10, winCount: -1, winsAverage: 0.1 }).validity).toBe('INVALID_NEGATIVE');
    expect(compareWinsAverage({ matchCount: 10, winCount: 5, winsAverage: -0.5 }).validity).toBe('INVALID_NEGATIVE');
    expect(compareWinsAverage({ matchCount: 10, winCount: 5, winsAverage: 'n/a' }).validity).toBe('NON_NUMERIC');
    expect(compareWinsAverage({ matchCount: 10, winCount: 5, winsAverage: '0.5' }).matches).toBe(true);
  });

  it('18. detects mismatches and classifies CONTRADICTED / SUPPORTED / UNVERIFIED', () => {
    const good = compareWinsAverage({ matchCount: 95, winCount: 42, winsAverage: 0.442 });
    const bad = compareWinsAverage({ matchCount: 95, winCount: 42, winsAverage: 0.512 });
    const invalid = compareWinsAverage({ matchCount: 0, winCount: 0, winsAverage: 0 });
    expect(bad.matches).toBe(false);
    expect(summarizeWinsAverage([good, bad]).status).toBe('CONTRADICTED');
    expect(summarizeWinsAverage([good, invalid]).status).toBe('SUPPORTED');
    expect(summarizeWinsAverage([good]).status).toBe('EMPIRICALLY_CONFIRMED_AS_WIN_RATIO_ON_SAMPLE');
    expect(summarizeWinsAverage([invalid]).status).toBe('UNVERIFIED');
  });

  it('19. precision distribution and rounding bounds', () => {
    expect(decimalPlaces(0.442)).toBe(3);
    expect(decimalPlaces(0.5)).toBe(1);
    expect(decimalPlaces(1e-7)).toBe(7);
    const summary = summarizeWinsAverage([
      compareWinsAverage({ matchCount: 95, winCount: 42, winsAverage: 0.442 }),
      compareWinsAverage({ matchCount: 4, winCount: 1, winsAverage: 0.25 }),
      compareWinsAverage({ matchCount: 2, winCount: 1, winsAverage: 0.5 }),
    ]);
    expect(summary.precisionDistribution).toEqual({ 1: 1, 2: 1, 3: 1 });
    expect(summary.inferredFieldPrecision).toBe(3);
    expect(summary.rowsBelowFieldPrecision).toBe(2);
    expect(summary.maximumAllowedRoundingError).toBe(0.05);
    expect(summary.maximumRoundingDifference).toBeCloseTo(0.0001053, 6);
  });

  it('20. summary is deterministic for the same input', () => {
    const rows = [
      { matchCount: 95, winCount: 42, winsAverage: 0.442 },
      { matchCount: 96, winCount: 60, winsAverage: 0.625 },
    ];
    const a = summarizeWinsAverage(rows.map(compareWinsAverage));
    const b = summarizeWinsAverage(rows.map(compareWinsAverage));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('rate fields analysed separately', () => {
  it('winRateHeroId1 and winRateHeroId2 alignments are independent', () => {
    const rows = [{ matchCount: 95, winCount: 42, winRateHeroId1: 0.442, winRateHeroId2: 0.512 }];
    const h1 = rateFieldAlignment(rows, 'winRateHeroId1');
    const h2 = rateFieldAlignment(rows, 'winRateHeroId2');
    expect(h1.alignedWithWinRatio.status).toBe('ALIGNED_ON_SAMPLE');
    expect(h1.alignedWithComplementRatio.status).toBe('NOT_ALIGNED_ON_SAMPLE');
    expect(h2.alignedWithWinRatio.status).toBe('NOT_ALIGNED_ON_SAMPLE');
    expect(h2.alignedWithComplementRatio.status).toBe('NOT_ALIGNED_ON_SAMPLE');
  });

  it('detects per-hero constancy of a rate field', () => {
    const response = { data: { heroStats: { w1: [{ heroId: 58, vs: [
      { heroId1: 58, heroId2: 1, winRateHeroId1: 0.474 },
      { heroId1: 58, heroId2: 2, winRateHeroId1: 0.474 },
    ] }] } } };
    expect(rateConstancyByHero([{ response }], 'winRateHeroId1', 'heroId1'))
      .toMatchObject({ groups: 1, constantGroups: 1, constantGroupsWithMultipleRows: 1 });
  });
});

describe('rank-level asymmetry contribution', () => {
  const row = rankContributionForPairWeek(PAIR, 2963, PROD_58_61, GROUPS_58_61) as any;

  it('21. signed deltas = gamesAtoB − gamesBtoA', () => {
    expect(row.groups.map((g: any) => g.signedDelta)).toEqual([-1, -5, -9, -2]);
    expect(row.production.signedDelta).toBe(-17);
  });

  it('23. four group deltas sum to the production delta (58:61 @ 2963)', () => {
    expect(row.groupSignedDeltaSum).toBe(-17);
    expect(row.decompositionMatchesProduction).toBe(true);
    expect(row.direction.allGroupsSameNonZeroSign).toBe(true);
    expect(row.direction.largestAbsoluteContributors).toEqual(['LEGEND_ANCIENT']);
  });

  it('24. relative delta uses the production formula |A−B|/A', () => {
    expect(row.production.relativeDeltaA).toBeCloseTo(17 / 301, 12);
    expect(row.production.relativeDeltaB).toBeCloseTo(17 / 318, 12);
    expect(row.groups[2].relativeDeltaA).toBeCloseTo(9 / 73, 12);
  });

  it('25. production threshold unchanged: >3% relative AND >15 games', () => {
    expect(row.production.thresholdExceeded).toBe(true);
    // Legend/Ancient is 12.3% relative but only 9 games: below threshold.
    expect(row.groups.every((g: any) => g.thresholdExceeded === false)).toBe(true);
    expect(row.thresholds.aggregateFailsWhileNoGroupFails).toBe(true);
    const edge = rankContributionForPairWeek(PAIR, 1, both([500, 250], [485, 240]), {
      HERALD_GUARDIAN: both([500, 250], [484, 240]),
      CRUSADER_ARCHON: both([0, 0], [0, 0]),
      LEGEND_ANCIENT: both([0, 0], [0, 0]),
      DIVINE_IMMORTAL: both([0, 0], [1, 0]),
    }) as any;
    expect(edge.production.thresholdExceeded).toBe(false); // 15 games is not > 15
    expect(edge.groups[0].thresholdExceeded).toBe(true); // 16 games, 3.2%
    expect(edge.thresholds.aggregatePassesWhileGroupFails).toBe(true);
  });

  it('22. detects opposite directions and compensation', () => {
    const mixed = rankContributionForPairWeek(PAIR, 2964, both([100, 50], [100, 50]), {
      HERALD_GUARDIAN: both([30, 15], [20, 10]),
      CRUSADER_ARCHON: both([20, 10], [30, 15]),
      LEGEND_ANCIENT: both([25, 12], [25, 13]),
      DIVINE_IMMORTAL: both([25, 13], [25, 12]),
    }) as any;
    expect(mixed.direction.mixedSigns).toBe(true);
    expect(mixed.direction.zeroDeltaGroups).toEqual(['LEGEND_ANCIENT', 'DIVINE_IMMORTAL']);
    expect(mixed.direction.compensatedMagnitude).toBe(20);
    expect(mixed.groups[0].shareOfProductionSignedDelta).toBeNull();
    const opposing = rankContributionForPairWeek(PAIR, 2963, PROD_58_61, {
      ...GROUPS_58_61, HERALD_GUARDIAN: both([97, 42], [96, 60]),
    }) as any;
    expect(opposing.direction.groupsOpposingProduction).toEqual(['HERALD_GUARDIAN']);
    expect(opposing.decompositionMatchesProduction).toBe(false);
  });

  it('26. incomplete rank contribution yields no decomposition', () => {
    const incomplete = rankContributionForPairWeek(PAIR, 2963, PROD_58_61, {
      ...GROUPS_58_61, CRUSADER_ARCHON: { AtoB: dir(100, 46), BtoA: null },
    }) as any;
    expect(incomplete.status).toBe('INCOMPLETE');
    expect(incomplete.groupSignedDeltaSum).toBeNull();
    expect(incomplete.groups[1].signedDelta).toBeNull();
    const summary = summarizeDirectionConsistency([incomplete, row]);
    expect(summary.incompletePairWeekRows).toBe(1);
    expect(summary.completePairWeekRows).toBe(1);
  });
});

describe('FIX12 raw-response recomputation (offline, real artifacts)', () => {
  let evidence: any;
  beforeAll(() => {
    evidence = runFix13();
  });

  it('protected and production sources match the expected hashes', () => {
    const hashes = captureSourceHashes();
    expect(verifySourceHashes(hashes)).toBe(true);
    expect(() => verifySourceHashes({ ...hashes, productionMeta: { physicalSha256: 'x' } }))
      .toThrow(/productionMeta/);
    expect(Object.keys(EXPECTED_PHYSICAL_SHA256)).toHaveLength(10);
  });

  it('1/9. 32 pair-week observations; production partition kept separate from FIX12 all-enum check', () => {
    expect(evidence.partitionVerification).toMatchObject({
      status: 'PROVEN_ON_SAMPLE',
      pairCount: 8,
      bucketCount: 4,
      pairWeekObservations: 32,
      completePairBucketCount: 32,
      matchingGamesAtoB: 32,
      matchingGamesBtoA: 32,
      matchingWinsAtoB: 32,
      matchingWinsBtoA: 32,
    });
    expect(evidence.allEnumPartitionCheckFix12.status).toBe('UNVERIFIED');
  });

  it('winsAverage matches winCount/matchCount on 446/446 rows', () => {
    expect(evidence.winsAverageSemantics).toMatchObject({
      status: 'EMPIRICALLY_CONFIRMED_AS_WIN_RATIO_ON_SAMPLE',
      relevantRows: 446,
      matchingWinRatioRows: 446,
      mismatchingRows: 0,
      matchingAtFieldPrecision: 446,
    });
  });

  it('58:61 @ 2963 decomposition matches the documented example', () => {
    const r = evidence.rankAsymmetryContribution.pairWeekRows
      .find((x: any) => x.canonicalPairId === '58:61' && x.bucket === 2963);
    expect(r.groups.map((g: any) => [g.gamesAtoB, g.gamesBtoA]))
      .toEqual([[95, 96], [100, 105], [73, 82], [33, 35]]);
    expect([r.production.gamesAtoB, r.production.gamesBtoA]).toEqual([301, 318]);
    expect(r.decompositionMatchesProduction).toBe(true);
    const forPair = (id: string) => evidence.rankAsymmetryContribution.pairWeekRows
      .filter((x: any) => x.canonicalPairId === id);
    for (const id of FIX13_FOCUS_PAIRS) {
      expect(forPair(id)).toHaveLength(4);
      expect(forPair(id).every((x: any) => x.decompositionMatchesProduction)).toBe(true);
    }
  });

  it('27. stable output ordering and canonical hash', () => {
    const ids = evidence.rankAsymmetryContribution.pairWeekRows
      .map((x: any) => `${x.canonicalPairId}@${x.bucket}`);
    expect(ids[0]).toBe('3:95@2963');
    expect(ids).toHaveLength(32);
    expect(canonicalJsonSha256(evidence, 'evidenceSha256')).toBe(evidence.evidenceSha256);
    const again = buildPartitionSemanticsEvidence({
      fix12Evidence: JSON.parse(readFileSync(new URL('../research/data-quality/stratz-reverse-pair-bracket-semantics-evidence.json', import.meta.url), 'utf8')),
      fix12Raw: JSON.parse(readFileSync(new URL('../research/data-quality/stratz-reverse-pair-bracket-raw-responses.json', import.meta.url), 'utf8')),
      sourceHashes: evidence.sourceHashes,
    });
    expect(again.evidenceSha256).toBe(evidence.evidenceSha256);
  });

  it('root cause stays UNRESOLVED and publishing stays blocked', () => {
    expect(evidence.rootCause).toMatchObject({ status: 'UNRESOLVED', productionPublishAllowed: false });
    expect(evidence.networkRequests).toBe(0);
    expect(JSON.stringify(evidence)).not.toMatch(/"response":\{"data"/);
  });
});
