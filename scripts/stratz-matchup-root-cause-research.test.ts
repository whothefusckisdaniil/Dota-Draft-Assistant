import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diagnoseDataset } from './stratz-matchup-asymmetry-lib.mjs';
import {
  ABSOLUTE_GAMES_DELTA_THRESHOLD,
  FIX9_INPUT_CANONICAL_SHA256,
  FIX10_REPEATABILITY_CANONICAL_SHA256,
  RELATIVE_DELTA_THRESHOLD,
  analyzeFix9Raw,
  buildRootCauseHypotheses,
  canonicalJsonSha256,
  compareMatchupRows,
  composeComparisons,
  createCompositionPlan,
  diagnosisRecord,
  isComparableViolation,
  normalizeStratzResponse,
  responseSha256,
  runFreshQuery,
  runOfflineAnalysis,
} from './stratz-matchup-root-cause-research.mjs';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'stratz-root-cause-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function loadInput() {
  return JSON.parse(readFileSync('scripts/stratz-diagnostic-input.json', 'utf8'));
}

function loadHeroNames() {
  const data = JSON.parse(readFileSync('public/data/heroes.json', 'utf8'));
  const heroes = Array.isArray(data) ? data : data.heroes;
  return new Map(heroes.map((hero: { id: number; localized_name?: string; name?: string }) => [
    hero.id,
    hero.localized_name ?? hero.name ?? `Hero ${hero.id}`,
  ]));
}

describe('FIX11 raw anomaly analysis', () => {
  it('recomputes all pair-week and directed violations from FIX9 raw responses', () => {
    const analysis = analyzeFix9Raw(loadInput(), { heroNames: loadHeroNames() });

    expect(analysis.perBucket.summary.map((bucket) => [
      bucket.bucket,
      bucket.directedViolationCount,
      bucket.pairWeekViolationCount,
      bucket.uniqueViolationPairCount,
    ])).toEqual([
      [2963, 25, 13, 13],
      [2964, 19, 10, 10],
      [2965, 11, 6, 6],
      [2966, 7, 5, 5],
    ]);
    expect(analysis.perBucket.directedViolationCount).toBe(62);
    expect(analysis.perBucket.pairWeekViolationCount).toBe(34);
    expect(analysis.perBucket.uniquePairCount).toBe(30);
    expect(analysis.perBucket.anomalyInventory).toHaveLength(34);
  });

  it('deduplicates unordered pair IDs while retaining every pair-week', () => {
    const analysis = analyzeFix9Raw(loadInput(), { heroNames: loadHeroNames() });
    const plan = createCompositionPlan(
      analysis.perBucket.anomalyInventory,
      [2963, 2964, 2965, 2966],
    );

    expect(plan.pairs).toHaveLength(30);
    expect(new Set(plan.pairs.map((pair) => pair.canonicalPairId)).size).toBe(30);
    expect(plan.requests.filter((request) => request.kind === 'pair-order')).toHaveLength(60);
    expect(plan.requests.filter((request) => request.kind === 'single-hero'))
      .toHaveLength(plan.uniqueHeroIds.length);
  });

  it('sums bucket game counts into the aggregate window without losing signed deltas', () => {
    const analysis = analyzeFix9Raw(loadInput(), { heroNames: loadHeroNames() });

    expect(analysis.aggregateAttribution.aggregateGameSumsMatchAllBuckets).toBe(true);
    expect(analysis.aggregateAttribution.aggregatePassingUniquePairCount).toBe(28);
    expect(analysis.aggregateAttribution.pairWeekFailuresWhosePairPassesAggregate).toBe(32);
    const enchantressBrood = analysis.aggregateAttribution.pairs.find(
      (pair) => pair.canonicalPairId === '58:61',
    );
    expect(enchantressBrood?.aggregate.gamesA).toBe(1318);
    expect(enchantressBrood?.aggregate.gamesB).toBe(1361);
    expect(enchantressBrood?.perBucket.map((bucket) => bucket.signedGamesDeltaAminusB))
      .toEqual([-17, -8, -13, -5]);
    expect(enchantressBrood?.aggregate.signedGamesDeltaAminusB).toBe(-43);
  });

  it('records the direction sign distribution and hero concentration from pair-weeks', () => {
    const analysis = analyzeFix9Raw(loadInput(), { heroNames: loadHeroNames() });

    expect(analysis.orientationAnalysis.gamesAGreaterThanGamesB).toBe(10);
    expect(analysis.orientationAnalysis.gamesBGreaterThanGamesA).toBe(24);
    const countsByName = new Map(analysis.heroConcentration.map((hero) => [
      hero.heroName,
      hero.pairWeekViolationCount,
    ]));
    expect([
      ['Naga Siren', 9],
      ['Enchantress', 5],
      ['Broodmother', 4],
      ['Treant Protector', 4],
      ['Huskar', 3],
      ['Terrorblade', 3],
    ].map(([name]) => [name, countsByName.get(name)])).toEqual([
      ['Naga Siren', 9],
      ['Enchantress', 5],
      ['Broodmother', 4],
      ['Treant Protector', 4],
      ['Huskar', 3],
      ['Terrorblade', 3],
    ]);
  });

  it('preserves absent reverse and duplicate statuses instead of comparing them as zeroes', () => {
    const missing = diagnoseDataset({
      '1': [{ hero_id: 2, games_played: 100, wins: 50 }],
    }).pairDiagnoses[0];
    const duplicate = diagnoseDataset({
      '1': [
        { hero_id: 2, games_played: 100, wins: 50 },
        { hero_id: 2, games_played: 101, wins: 51 },
      ],
      '2': [{ hero_id: 1, games_played: 100, wins: 50 }],
    }).pairDiagnoses[0];

    expect(diagnosisRecord(missing, 2963).status).toBe('MISSING_REVERSE');
    expect(diagnosisRecord(missing, 2963).gamesB).toBeNull();
    expect(diagnosisRecord(duplicate, 2963).status).toBe('DUPLICATE_DIRECTION');
    expect(diagnosisRecord(duplicate, 2963).thresholdExceeded).toBeNull();
    expect(isComparableViolation(duplicate)).toBe(false);
  });

  it('keeps the production threshold unchanged', () => {
    expect(RELATIVE_DELTA_THRESHOLD).toBe(0.03);
    expect(ABSOLUTE_GAMES_DELTA_THRESHOLD).toBe(15);
  });
});

describe('FIX11 query comparison helpers', () => {
  const first = {
    data: {
      heroStats: {
        w2963: [
          { heroId: 2, vs: [{ heroId1: 2, heroId2: 1, matchCount: 20, winCount: 8 }] },
          { heroId: 1, vs: [{ heroId1: 1, heroId2: 2, matchCount: 19, winCount: 10 }] },
        ],
      },
    },
  };
  const reversed = {
    data: {
      heroStats: {
        w2963: [
          { heroId: 1, vs: [{ heroId1: 1, heroId2: 2, matchCount: 19, winCount: 10 }] },
          { heroId: 2, vs: [{ heroId1: 2, heroId2: 1, matchCount: 20, winCount: 8 }] },
        ],
      },
    },
  };

  it('normalizes JSON object, dryad, and matchup row ordering for response hashes', () => {
    expect(normalizeStratzResponse(first)).toEqual(normalizeStratzResponse(reversed));
    expect(responseSha256(first)).toBe(responseSha256(reversed));
  });

  it('compares pair-only, single-hero, and batch rows independent of row order', () => {
    const rows = [
      { requestedHeroId: 1, bucket: 2963, heroId1: 1, heroId2: 2, matchCount: 19, winCount: 10 },
      { requestedHeroId: 2, bucket: 2963, heroId1: 2, heroId2: 1, matchCount: 20, winCount: 8 },
    ];
    expect(compareMatchupRows(rows, [...rows].reverse(), [1, 2])).toEqual({
      matchingRowCount: 2,
      mismatchingRowCount: 0,
      mismatches: [],
    });
  });

  it('checks both pair query orders against FIX9 batch and deduplicated single queries', () => {
      const inventory = [{ canonicalPairId: '1:2', heroAId: 1, heroBId: 2 }];
      const plan = createCompositionPlan(inventory, [2963]);
      const response = (reverseOrder = false, changeHero1Count = false) => {
        const dryads = [
          { heroId: 1, vs: [{ heroId1: 1, heroId2: 2, matchCount: changeHero1Count ? 12 : 10, winCount: 4 }] },
          { heroId: 2, vs: [{ heroId1: 2, heroId2: 1, matchCount: 11, winCount: 6 }] },
        ];
        return {
          data: { heroStats: { w2963: reverseOrder ? dryads.reverse() : dryads } },
        };
      };
      const responses = new Map([
        [`pair-1-2-order-1-2`, response()],
        [`pair-1-2-order-2-1`, response(true)],
        ['single-1', response().data.heroStats.w2963.filter((dryad) => dryad.heroId === 1).length
          ? { data: { heroStats: { w2963: [response().data.heroStats.w2963[0]] } } } : null],
        ['single-2', { data: { heroStats: { w2963: [response().data.heroStats.w2963[1]] } } }],
      ]);
      const records = plan.requests.map((request) => ({
        requestId: request.requestId,
        status: 'VERIFIED',
      }));
      const input = {
        batchResults: {
          chunks: [
            { chunkIndex: 0, chunkHeroIds: [1], response: { data: { heroStats: { w2963: [response().data.heroStats.w2963[0]] } } } },
            { chunkIndex: 1, chunkHeroIds: [2], response: { data: { heroStats: { w2963: [response().data.heroStats.w2963[1]] } } } },
          ],
        },
      };
      const comparisons = composeComparisons(plan, records, responses, input, {}, [2963]);

      expect(comparisons.summary.orderMismatchCount).toBe(0);
      expect(comparisons.summary.batchMismatchCount).toBe(0);
      expect(comparisons.summary.pairOnlyVsSingleHeroMismatchCount).toBe(0);
      expect(comparisons.summary.batchComparisonCount).toBe(4);
      expect(comparisons.summary.pairOnlyVsSingleHeroComparisonCount).toBe(4);
    });

  it('separates historical FIX9 batch differences from current query-composition checks', () => {
    const plan = createCompositionPlan([
      { canonicalPairId: '1:2', heroAId: 1, heroBId: 2 },
    ], [2963]);
    const currentRows = [
      { heroId: 1, vs: [{ heroId1: 1, heroId2: 2, matchCount: 12, winCount: 5 }] },
      { heroId: 2, vs: [{ heroId1: 2, heroId2: 1, matchCount: 11, winCount: 6 }] },
    ];
    const currentResponse = (rows = currentRows) => ({ data: { heroStats: { w2963: rows } } });
    const responses = new Map([
      ['pair-1-2-order-1-2', currentResponse()],
      ['pair-1-2-order-2-1', currentResponse([...currentRows].reverse())],
      ['single-1', currentResponse([currentRows[0]])],
      ['single-2', currentResponse([currentRows[1]])],
    ]);
    const records = plan.requests.map((request) => ({
      requestId: request.requestId,
      status: 'VERIFIED',
    }));
    const input = {
      batchResults: {
        chunks: [
          { chunkIndex: 0, chunkHeroIds: [1], response: currentResponse([
            { ...currentRows[0], vs: [{ ...currentRows[0].vs[0], matchCount: 10, winCount: 4 }] },
          ]) },
          { chunkIndex: 1, chunkHeroIds: [2], response: currentResponse([currentRows[1]]) },
        ],
      },
    };
    const comparisons = composeComparisons(plan, records, responses, input, {}, [2963], {
      records: [
        { requestId: 'matched-fix9-chunk-0', status: 'VERIFIED' },
        { requestId: 'matched-fix9-chunk-1', status: 'VERIFIED' },
      ],
      responses: new Map([
        ['matched-fix9-chunk-0', currentResponse([currentRows[0]])],
        ['matched-fix9-chunk-1', currentResponse([currentRows[1]])],
      ]),
    });

    expect(comparisons.summary.orderMismatchCount).toBe(0);
    expect(comparisons.summary.pairOnlyVsSingleHeroMismatchCount).toBe(0);
    expect(comparisons.summary.batchMismatchCount).toBe(2);
    expect(comparisons.summary.singleHeroVsFix9BatchMismatchCount).toBe(1);
    expect(comparisons.historicalBatchComparison).toMatchObject({
      status: 'MISMATCH',
      summary: {
        pairOnlyVsFix9BatchUniqueMismatchRowCount: 1,
        singleHeroVsFix9BatchUniqueMismatchRowCount: 1,
        matchedBatchVsFix9BatchUniqueMismatchRowCount: 1,
        pairOnlyAndSingleHeroMismatchSetsEqual: true,
        singleHeroAndMatchedBatchMismatchSetsEqual: true,
        singleHeroMatchesCurrentMatchedBatch: true,
        temporalDifferenceSupported: true,
        singleHeroMismatchRowsByBucket: { 2963: 1 },
        singleHeroMatchCountIncreased: 1,
      },
    });
  });

  it('localizes a query-order mismatch to the requested hero and bucket', () => {
      const inventory = [{ canonicalPairId: '1:2', heroAId: 1, heroBId: 2 }];
      const plan = createCompositionPlan(inventory, [2963]);
      const forward = {
        data: { heroStats: { w2963: [
          { heroId: 1, vs: [{ heroId1: 1, heroId2: 2, matchCount: 10, winCount: 4 }] },
          { heroId: 2, vs: [{ heroId1: 2, heroId2: 1, matchCount: 11, winCount: 6 }] },
        ] } },
      };
      const reverse = {
        data: { heroStats: { w2963: [
          { heroId: 2, vs: [{ heroId1: 2, heroId2: 1, matchCount: 11, winCount: 6 }] },
          { heroId: 1, vs: [{ heroId1: 1, heroId2: 2, matchCount: 12, winCount: 4 }] },
        ] } },
      };
      const comparisons = composeComparisons(
        plan,
        plan.requests.map((request) => ({ requestId: request.requestId, status: 'VERIFIED' })),
        new Map([
          ['pair-1-2-order-1-2', forward],
          ['pair-1-2-order-2-1', reverse],
          ['single-1', { data: { heroStats: { w2963: [forward.data.heroStats.w2963[0]] } } }],
          ['single-2', { data: { heroStats: { w2963: [forward.data.heroStats.w2963[1]] } } }],
        ]),
        { batchResults: { chunks: [] } },
        {},
        [2963],
      );

    expect(comparisons.summary.orderMismatchCount).toBe(1);
    expect(comparisons.orderComparisons[0].comparison.mismatches[0]).toMatchObject({
      requestedHeroId: 1,
      bucket: 2963,
      heroId1: 1,
      heroId2: 2,
      left: { matchCount: 10, winCount: 4 },
      right: { matchCount: 12, winCount: 4 },
    });
  });

  it('keeps absent rows as missing instead of manufacturing zero counts', () => {
    const present = [{
      requestedHeroId: 1,
      bucket: 2963,
      heroId1: 1,
      heroId2: 2,
      matchCount: 19,
      winCount: 10,
    }];
    const comparison = compareMatchupRows(present, [], [1]);

    expect(comparison.matchingRowCount).toBe(0);
    expect(comparison.mismatchingRowCount).toBe(1);
    expect(comparison.mismatches[0].left).toEqual({ matchCount: 19, winCount: 10 });
    expect(comparison.mismatches[0].right).toBeNull();
  });

  it('classifies repeatability mismatch without resolving the root cause', () => {
    const left = [{
      requestedHeroId: 1,
      bucket: 2963,
      heroId1: 1,
      heroId2: 2,
      matchCount: 19,
      winCount: 10,
    }];
    const right = [{ ...left[0], matchCount: 20 }];
    const mismatch = compareMatchupRows(left, right, [1]);
    const hypotheses = buildRootCauseHypotheses(
      { orientationAnalysis: { rawRowsForAnomalyDirections: 1 }, perBucket: { pairWeekViolationCount: 1 }, aggregateAttribution: { aggregateGameSumsMatchAllBuckets: true } },
      { status: 'FAIL', comparisons: { summary: { orderMismatchCount: 0, batchMismatchCount: 0, pairOnlyVsSingleHeroMismatchCount: 0, fix10MismatchCount: mismatch.mismatchingRowCount } } },
      { claims: [] },
    );

    expect(mismatch.mismatchingRowCount).toBe(1);
    expect(hypotheses.find((item) => item.category === 'QUERY_FILTER_DEPENDENCE')?.status)
      .toBe('OBSERVED_NEEDS_LOCALIZATION');
  });

  it('does not classify historical batch drift as query-composition dependence', () => {
    const hypotheses = buildRootCauseHypotheses(
      { orientationAnalysis: { rawRowsForAnomalyDirections: 1 }, perBucket: { pairWeekViolationCount: 1 }, aggregateAttribution: { aggregateGameSumsMatchAllBuckets: true } },
      {
        status: 'PASS',
        comparisons: {
          summary: {
            orderMismatchCount: 0,
            batchMismatchCount: 56,
            pairOnlyVsSingleHeroMismatchCount: 0,
            fix10MismatchCount: 0,
          },
          historicalBatchComparison: {
            status: 'MISMATCH',
            summary: { temporalDifferenceSupported: true },
          },
        },
      },
      { claims: [] },
    );

    expect(hypotheses.find((item) => item.category === 'QUERY_FILTER_DEPENDENCE')?.status)
      .toBe('NOT_OBSERVED');
    expect(hypotheses.find((item) => item.category === 'BUCKET_INGESTION')?.status)
      .toBe('TEMPORAL_DIFFERENCES_OBSERVED_PROVENANCE_UNVERIFIED');
  });
});

describe('FIX11 evidence and transport lifecycle', () => {
  it('keeps protected canonical hashes and produces deterministic unresolved evidence offline', async () => {
    const paths = [path.join(tempDir, 'first.json'), path.join(tempDir, 'second.json')];
    const now = () => new Date('2026-11-12T10:00:00.000Z');
    const [firstEvidence, secondEvidence] = await Promise.all(paths.map((evidencePath) =>
      runOfflineAnalysis({ evidencePath, now })));

    expect(firstEvidence.protectedSourceHashes.fix9Input.canonicalSha256)
      .toBe(FIX9_INPUT_CANONICAL_SHA256);
    expect(firstEvidence.protectedSourceHashes.fix10RepeatabilityEvidence.canonicalSha256)
      .toBe(FIX10_REPEATABILITY_CANONICAL_SHA256);
    expect(firstEvidence.rootCause.status).toBe('UNRESOLVED');
    expect(firstEvidence.rootCause.category).toBe('UNRESOLVED');
    expect(firstEvidence.rootCause.productionPublishAllowed).toBe(false);
    expect(firstEvidence.evidenceSha256).toBe(secondEvidence.evidenceSha256);
    expect(readFileSync(paths[0], 'utf8')).toBe(readFileSync(paths[1], 'utf8'));
    expect(existsSync(paths[0])).toBe(true);
    expect(canonicalJsonSha256(firstEvidence, 'evidenceSha256')).toBe(firstEvidence.evidenceSha256);
  });

  it('closes the production transport on success and query failure', async () => {
    let closed = 0;
    class MockTransport {
      constructor(private readonly fail = false) {}
      async init() {}
      async query() {
        if (this.fail) throw new Error('request failed token-secret');
        return { data: { heroStats: { w2963: [{ heroId: 1, vs: [] }] } } };
      }
      async close() {
        closed += 1;
      }
    }
    const now = () => new Date('2026-11-12T10:00:00.000Z');
    const success = await runFreshQuery({
      query: 'query',
      requestedHeroIds: [1],
      buckets: [2963],
      Transport: class extends MockTransport {
        constructor() { super(false); }
      },
      token: 'token-secret',
      now,
    });
    const failure = await runFreshQuery({
      query: 'query',
      requestedHeroIds: [1],
      buckets: [2963],
      Transport: class extends MockTransport {
        constructor() { super(true); }
      },
      token: 'token-secret',
      now,
    });

    expect(success.status).toBe('VERIFIED');
    expect(success.transportCreated).toBe(true);
    expect(success.transportClosed).toBe(true);
    expect(failure.status).toBe('FAILED');
    expect(failure.error).not.toContain('token-secret');
    expect(failure.transportClosed).toBe(true);
    expect(closed).toBe(2);
  });
});
