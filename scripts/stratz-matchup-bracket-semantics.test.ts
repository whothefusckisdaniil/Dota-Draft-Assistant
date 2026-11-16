import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  canonicalJsonSha256,
} from './stratz-matchup-root-cause-research.mjs';
import {
  BRACKETS,
  buildChunkQuery,
} from './update-data-stratz.mjs';
import {
  FIX12_REQUIRED_PAIRS,
  buildDiagnosticPairQuery,
  captureSourceHashes,
  comparePairDirections,
  compareRate,
  compileFilterAnalysis,
  createBracketFilterConfigurations,
  executeDiagnosticQuery,
  isUnknownRankValue,
  makeRootCauseAssessment,
  mapProductionBrackets,
  makeRankSchemaIntrospectionQuery,
  normalizeRankFilter,
  normalizedResponseSha256,
  queryRateEvidence,
  selectStratifiedPairs,
  summarizeRankSchema,
  validateDiagnosticResponse,
  verifyProtectedSourceHashes,
  verifyFix12Evidence,
} from './stratz-matchup-bracket-semantics.mjs';

const enumValues = [
  { name: 'HERALD_GUARDIAN', description: 'Herald and Guardian', isDeprecated: false },
  { name: 'CRUSADER_ARCHON', description: null, isDeprecated: false },
  { name: 'LEGEND_ANCIENT', description: null, isDeprecated: false },
  { name: 'DIVINE_IMMORTAL', description: null, isDeprecated: false },
  { name: 'UNKNOWN', description: null, isDeprecated: false },
];

const pair = {
  canonicalPairId: '58:61',
  heroAId: 58,
  heroBId: 61,
  buckets: [2963],
};

function direction(matchCount: number, winCount: number, extra = {}) {
  return {
    matchCount,
    winCount,
    duplicateCount: 1,
    winRateHeroId1: null,
    winRateHeroId2: null,
    winsAverage: null,
    ...extra,
  };
}

function filterResult(filterId: string, gamesA: number, gamesB: number) {
  const comparison = comparePairDirections(pair, [{
    bucket: 2963,
    directionAtoB: direction(gamesA, Math.floor(gamesA / 2)),
    directionBtoA: direction(gamesB, Math.floor(gamesB / 2)),
  }], filterId);
  return {
    ...comparison,
    canonicalPairId: pair.canonicalPairId,
    filterId,
    brackets: null,
    requestId: `${filterId}-request`,
    queryHash: 'a'.repeat(64),
    responseHash: 'b'.repeat(64),
    status: 'VERIFIED',
    orientationIssues: [],
  };
}

describe('FIX12 rank enum mapping and query composition', () => {
  it('maps every production bracket value to an exact schema enum value', () => {
    const mapping = mapProductionBrackets(enumValues, BRACKETS);

    expect(mapping.productionValues.map((entry) => entry.status))
      .toEqual(['EXACT_ENUM_MATCH', 'EXACT_ENUM_MATCH', 'EXACT_ENUM_MATCH', 'EXACT_ENUM_MATCH']);
    expect(mapping.allNonUnknownEnumsCovered).toBe(true);
    expect(mapping.unknownIncludedInProduction).toBe(false);
    expect(mapping.unknownValues).toEqual(['UNKNOWN']);
    expect(mapping.intendedRankRangeStatus).toBe('UNVERIFIED');
  });

  it('detects an Unknown enum by schema name or description', () => {
    expect(isUnknownRankValue({ name: 'UNKNOWN', description: null })).toBe(true);
    expect(isUnknownRankValue({ name: 'UNRANKED', description: 'Unknown MMR' })).toBe(true);
    expect(isUnknownRankValue({ name: 'HERALD_GUARDIAN', description: null })).toBe(false);
  });

  it('reports absent production enum values instead of silently accepting them', () => {
    const mapping = mapProductionBrackets(enumValues, [...BRACKETS, 'MISSING_ENUM']);

    expect(mapping.productionValues.at(-1)).toMatchObject({
      productionValue: 'MISSING_ENUM',
      status: 'UNKNOWN_ENUM_VALUE',
    });
    expect(mapping.mappingStatus).toBe('INVALID_OR_DEPRECATED_PRODUCTION_VALUE');
  });

  it('includes no-filter only when introspection says the argument is nullable', () => {
    const nullable = createBracketFilterConfigurations(enumValues, BRACKETS, true);
    const required = createBracketFilterConfigurations(enumValues, BRACKETS, false);

    expect(nullable.some((config) => config.id === 'no-bracket-filter')).toBe(true);
    expect(required.some((config) => config.id === 'no-bracket-filter')).toBe(false);
    expect(nullable.find((config) => config.id === 'unknown-only')?.aliases)
      .toContain('individual:UNKNOWN');
  });

  it('normalizes filter sets deterministically in schema order and rejects unknown values', () => {
    expect(normalizeRankFilter(['UNKNOWN', 'HERALD_GUARDIAN', 'UNKNOWN'], enumValues))
      .toEqual(['HERALD_GUARDIAN', 'UNKNOWN']);
    expect(() => normalizeRankFilter(['NONEXISTENT'], enumValues))
      .toThrow('Unknown bracket enum value');
  });

  it('changes only bracket filters and diagnostic fields in the production query', () => {
    const heroIds = [58, 61];
    const buckets = [2963, 2964];
    const productionQuery = buildChunkQuery(heroIds, buckets);
    const variant = buildDiagnosticPairQuery({
      heroIds,
      buckets,
      bracketFilter: BRACKETS,
      buildQuery: buildChunkQuery,
    });
    const productionSelection = variant.query.replace(
      / winRateHeroId1 winRateHeroId2 winsAverage/g,
      '',
    );

    expect(productionSelection).toBe(productionQuery);
    expect(variant.productionQuery).toBe(productionQuery);
  });

  it('omits bracketBasicIds only with affirmative nullable schema evidence', () => {
    expect(() => buildDiagnosticPairQuery({
      heroIds: [58, 61],
      buckets: [2963],
      bracketFilter: null,
    })).toThrow('does not allow omitting');
    const query = buildDiagnosticPairQuery({
      heroIds: [58, 61],
      buckets: [2963],
      bracketFilter: null,
      bracketArgumentNullable: true,
    });
    expect(query.query).not.toContain('bracketBasicIds:');
    expect(query.query).toContain('take: 200');
  });

  it('includes enum and exact argument nullability in the introspection query summary', () => {
    const summary = summarizeRankSchema({
      data: {
        rankBracketBasicEnum: {
          name: 'RankBracketBasicEnum',
          kind: 'ENUM',
          enumValues,
        },
        heroStatsQuery: {
          name: 'HeroStatsQuery',
          fields: [{
            name: 'matchUp',
            type: { kind: 'LIST', name: null, ofType: { kind: 'OBJECT', name: 'HeroStatsHeroDryadType' } },
            args: [
              { name: 'heroId', description: null, type: { kind: 'SCALAR', name: 'Short' } },
              { name: 'week', description: null, type: { kind: 'SCALAR', name: 'Long' } },
              { name: 'take', description: null, type: { kind: 'SCALAR', name: 'Int' } },
              { name: 'bracketBasicIds', description: null, type: { kind: 'LIST', name: null, ofType: { kind: 'ENUM', name: 'RankBracketBasicEnum' } } },
            ],
          }],
        },
        matchupRow: { name: 'HeroStatsHeroDryadType', fields: [] },
      },
    });

    expect(summary.matchUp.arguments).toMatchObject({
      heroId: { graphqlType: 'Short', nullable: true },
      week: { graphqlType: 'Long', nullable: true },
      take: { graphqlType: 'Int', nullable: true },
      bracketBasicIds: { graphqlType: '[RankBracketBasicEnum]', nullable: true },
    });
    expect(makeRankSchemaIntrospectionQuery()).toContain('enumValues(includeDeprecated: true)');
  });
});

describe('FIX12 directional comparisons and rank additivity', () => {
  it('compares A→B and B→A independently and preserves bucket order', () => {
    const comparison = comparePairDirections(pair, [
      { bucket: 2964, directionAtoB: direction(80, 40), directionBtoA: direction(70, 35) },
      { bucket: 2963, directionAtoB: direction(100, 50), directionBtoA: direction(90, 45) },
    ], 'production');

    expect(comparison.perBucket.map((row) => row.bucket)).toEqual([2963, 2964]);
    expect(comparison.aggregate).toEqual({ gamesA: 180, gamesB: 160, winsA: 90, winsB: 80 });
  });

  it('keeps absent reverse rows null and excludes duplicate directions from totals', () => {
    const missing = comparePairDirections(pair, [{
      bucket: 2963,
      directionAtoB: direction(100, 50),
      directionBtoA: null,
    }], 'production');
    const duplicate = comparePairDirections(pair, [{
      bucket: 2963,
      directionAtoB: { duplicateCount: 2, duplicateRows: [{ matchCount: 10 }, { matchCount: 11 }] },
      directionBtoA: direction(90, 40),
    }], 'production');

    expect(missing.perBucket[0].heroBtoA).toBeNull();
    expect(missing.aggregate).toBeNull();
    expect(duplicate.perBucket[0].status).toBe('DUPLICATE_DIRECTION');
    expect(duplicate.perBucket[0].thresholdExceeded).toBeNull();
    expect(duplicate.aggregate).toBeNull();
  });

  it('checks all-rank count against the sum of individual filters without hiding non-additivity', () => {
    const configurations = [
      { id: 'production', brackets: BRACKETS, aliases: ['production'] },
      { id: 'all-ranks', brackets: enumValues.map((entry) => entry.name), aliases: ['all-ranks'] },
      { id: 'unknown-only', brackets: ['UNKNOWN'], aliases: ['unknown-only', 'individual:UNKNOWN'] },
      { id: 'rank-a', brackets: ['HERALD_GUARDIAN'], aliases: ['individual:HERALD_GUARDIAN'] },
      { id: 'rank-b', brackets: ['CRUSADER_ARCHON'], aliases: ['individual:CRUSADER_ARCHON'] },
      { id: 'rank-c', brackets: ['LEGEND_ANCIENT'], aliases: ['individual:LEGEND_ANCIENT'] },
      { id: 'rank-d', brackets: ['DIVINE_IMMORTAL'], aliases: ['individual:DIVINE_IMMORTAL'] },
    ];
    const results = [
      filterResult('production', 15, 16),
      filterResult('all-ranks', 40, 42),
      filterResult('unknown-only', 2, 1),
      filterResult('rank-a', 10, 12),
      filterResult('rank-b', 10, 10),
      filterResult('rank-c', 10, 10),
      filterResult('rank-d', 8, 9),
    ];
    const analysis = compileFilterAnalysis(
      [pair],
      configurations,
      results,
      enumValues,
      [2963],
    );

    expect(analysis.allRankVsIndividualSum.status).toBe('EMPIRICALLY_ADDITIVE_FOR_SAMPLE_SCHEMA_MUTUAL_EXCLUSIVITY_UNVERIFIED');
    expect(analysis.allRankVsIndividualSum.comparedDirectionBuckets).toBe(2);
    expect(analysis.productionVsAllRankAndUnknown[0].allRankAddedUnknownOrOtherCount).toBe(25);
  });

  it('reports individual-rank sum mismatch without assuming the filters partition data', () => {
    const configs = [
      { id: 'production', brackets: BRACKETS, aliases: ['production'] },
      { id: 'all-ranks', brackets: enumValues.map((entry) => entry.name), aliases: ['all-ranks'] },
      { id: 'rank-a', brackets: ['HERALD_GUARDIAN'], aliases: ['individual:HERALD_GUARDIAN'] },
      { id: 'rank-b', brackets: ['CRUSADER_ARCHON'], aliases: ['individual:CRUSADER_ARCHON'] },
    ];
    const analysis = compileFilterAnalysis(
      [pair],
      configs,
      [
        filterResult('production', 10, 10),
        filterResult('all-ranks', 30, 30),
        filterResult('rank-a', 10, 10),
        filterResult('rank-b', 10, 10),
      ],
      enumValues,
      [2963],
    );

    expect(analysis.allRankVsIndividualSum.status).toBe('NOT_ADDITIVE_FOR_SAMPLE');
    expect(analysis.allRankVsIndividualSum.schemaMutualExclusivity).toBe('UNVERIFIED');
  });
});

describe('FIX12 response and win-rate semantics', () => {
  it('accepts a structurally valid response with null rate fields as unavailable evidence', () => {
    const response = {
      data: {
        heroStats: {
          w2963: [{
            heroId: 58,
            vs: [{
              heroId1: 58,
              heroId2: 61,
              matchCount: 12,
              winCount: 6,
              winRateHeroId1: null,
              winRateHeroId2: null,
              winsAverage: null,
            }],
          }],
        },
      },
    };

    expect(validateDiagnosticResponse(
      response,
      [58, 61],
      [2963],
      ['winRateHeroId1', 'winRateHeroId2', 'winsAverage'],
    ).rowCount).toBe(1);
    expect(() => validateDiagnosticResponse(
      { data: { heroStats: { w2963: [] } } },
      [58, 61],
      [2963, 2964],
      [],
    )).toThrow('missing bucket w2964');
  });

  it('uses decimal precision and accepts both 0–1 and 0–100 rate scales', () => {
    expect(compareRate('0.33333', 1 / 3)?.matches).toBe(true);
    expect(compareRate('33.333', 1 / 3)?.matches).toBe(true);
    expect(compareRate(0.5, 0.6)?.matches).toBe(false);
  });

  it('confirms winCount alignment with heroId1 rate and complementary heroId2 rate', () => {
    const summary = queryRateEvidence([{
      canonicalPairId: '58:61',
      bucket: 2963,
      heroId1: 58,
      heroId2: 61,
      matchCount: 100,
      winCount: 60,
      winRateHeroId1: '0.6000',
      winRateHeroId2: '40.00',
      winsAverage: 0.5,
    }]);

    expect(summary.winCountInterpretation).toBe('EMPIRICALLY_CONFIRMED');
    expect(summary.directHero1Matches).toBe(1);
    expect(summary.inverseHero2Matches).toBe(1);
  });

  it('marks a consistent inverse winCount reading as contradicted for the heroId1 interpretation', () => {
    const summary = queryRateEvidence([{
      matchCount: 100,
      winCount: 60,
      winRateHeroId1: '0.4000',
      winRateHeroId2: '0.6000',
      winsAverage: null,
    }]);

    expect(summary.winCountInterpretation).toBe('CONTRADICTED');
    expect(summary.hero1AgainstInverseRateMatches).toBe(1);
    expect(summary.hero2AgainstInverseRateMatches).toBe(1);
  });

  it('does not infer winCount semantics from incomplete rate alignment', () => {
    const summary = queryRateEvidence([
      {
        matchCount: 100,
        winCount: 60,
        winRateHeroId1: '0.6000',
        winRateHeroId2: '0.4000',
        winsAverage: null,
      },
      {
        matchCount: 100,
        winCount: 60,
        winRateHeroId1: '0.4500',
        winRateHeroId2: '0.5500',
        winsAverage: null,
      },
    ]);

    expect(summary.directHero1Matches).toBe(1);
    expect(summary.inverseHero2Matches).toBe(1);
    expect(summary.winCountInterpretation).toBe('UNVERIFIED');
  });

  it('normalizes response order before computing a SHA-256 digest', () => {
    const first = { data: { heroStats: { w2963: [
      { heroId: 61, vs: [{ heroId1: 61, heroId2: 58, matchCount: 10, winCount: 5 }] },
      { heroId: 58, vs: [{ heroId1: 58, heroId2: 61, matchCount: 12, winCount: 6 }] },
    ] } } };
    const reordered = { data: { heroStats: { w2963: [
      { heroId: 58, vs: [{ heroId1: 58, heroId2: 61, matchCount: 12, winCount: 6 }] },
      { heroId: 61, vs: [{ heroId1: 61, heroId2: 58, matchCount: 10, winCount: 5 }] },
    ] } } };

    expect(normalizedResponseSha256(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(normalizedResponseSha256(first)).toBe(normalizedResponseSha256(reordered));
  });

  it('validates the raw artifact canonical hash and rejects altered raw responses', () => {
    const sources = captureSourceHashes();
    const raw = { queryResponses: { request: { response: { data: { ok: true } } } } };
    const evidence = {
      sourceHashes: { before: sources, after: sources, unchanged: true },
      rawResponseArtifact: { canonicalSha256: canonicalJsonSha256(raw) },
      rootCause: { status: 'UNRESOLVED', productionPublishAllowed: false },
      evidenceSha256: null,
    };
    evidence.evidenceSha256 = canonicalJsonSha256(evidence, 'evidenceSha256');

    expect(verifyFix12Evidence(evidence, raw, sources, sources).status).toBe('PASS');
    expect(() => verifyFix12Evidence(
      evidence,
      { queryResponses: {} },
      sources,
      sources,
    )).toThrow('raw response canonical hash mismatch');
  });
});

describe('FIX12 selection, provenance, and transport lifecycle', () => {
  it('selects the same stratified eight pairs from protected FIX11 anomaly evidence', () => {
    const fix11 = JSON.parse(readFileSync(
      'research/data-quality/stratz-reverse-pair-root-cause-evidence.json',
      'utf8',
    ));
    const first = selectStratifiedPairs(fix11.anomalyAnalysis.perBucket.anomalyInventory);
    const second = selectStratifiedPairs(fix11.anomalyAnalysis.perBucket.anomalyInventory);
    const selectedIds = first.map((item) => item.canonicalPairId);

    expect(first).toHaveLength(8);
    expect(selectedIds).toEqual(second.map((item) => item.canonicalPairId));
    expect(FIX12_REQUIRED_PAIRS.every((id) => selectedIds.includes(id))).toBe(true);
    expect(first.some((item) => item.buckets.includes(2966))).toBe(true);
    expect(first.some((item) => item.buckets.length > 1)).toBe(true);
    expect(first.some((item) => item.buckets.length === 1)).toBe(true);
  });

  it('protects source hashes without mutating FIX9–FIX11 or production files', () => {
    const before = captureSourceHashes();
    expect(verifyProtectedSourceHashes(before).fix11.rootCause.status).toBe('UNRESOLVED');
    const after = captureSourceHashes();

    expect(after).toEqual(before);
  });

  it('keeps root cause unresolved without sufficient causal evidence', () => {
    const result = makeRootCauseAssessment(
      {
        bracketFilterEffect: { status: 'UNRESOLVED' },
        unknownFilterAvailable: false,
        productionVsAllRankAndUnknown: [],
      },
      { reverseMatchCountEquality: { status: 'UNVERIFIED' } },
      [],
    );

    expect(result.status).toBe('UNRESOLVED');
    expect(result.category).toBe('UNRESOLVED');
    expect(result.productionPublishAllowed).toBe(false);
  });

  it('closes successful mock transports and returns a hashed validated response', async () => {
    const close = vi.fn();
    class MockTransport {
      async init() {}
      async query() {
        return { data: { ok: true } };
      }
      async close() {
        close();
      }
    }
    const result = await executeDiagnosticQuery({
      requestId: 'mock-success',
      query: '{ ping }',
      Transport: MockTransport,
      token: 'test-secret-token',
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      validate: () => ({ rowCount: 0 }),
    });

    expect(result.record.status).toBe('VERIFIED');
    expect(result.record.responseHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.record.transportClosed).toBe(true);
    expect(result.response).toEqual({ data: { ok: true } });
    expect(close).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('test-secret-token');
  });

  it('closes failing mock transports and does not persist unvalidated responses', async () => {
    const close = vi.fn();
    class MockTransport {
      async init() {}
      async query() {
        return { data: { private: true } };
      }
      async close() {
        close();
      }
    }
    const result = await executeDiagnosticQuery({
      requestId: 'mock-invalid',
      query: '{ invalid }',
      Transport: MockTransport,
      token: 'test-secret-token',
      validate: () => {
        throw new Error('test-secret-token validation failed');
      },
    });

    expect(result.record.status).toBe('FAILED');
    expect(result.record.error).not.toContain('test-secret-token');
    expect(result.record.responseHash).toBeNull();
    expect(result.response).toBeNull();
    expect(close).toHaveBeenCalledOnce();
  });
});
