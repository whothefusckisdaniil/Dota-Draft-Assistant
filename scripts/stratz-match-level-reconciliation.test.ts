import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { BRACKETS, BUCKET_SEC } from './update-data-stratz.mjs';
import { canonicalJsonSha256 } from './stratz-matchup-root-cause-research.mjs';
import {
  aggregateCrossCheck,
  assessPagination,
  assignBucket,
  buildMatchLevelEvidence,
  captureSourceHashes,
  checkBucketAssignment,
  collectHeroStatsResponses,
  collectMatchIds,
  compareMatchSets,
  discoverMatchLevelCapabilities,
  findField,
  matchOrientation,
  queryUsesProductionFilter,
  reconcileCount,
  reconcileWinCount,
  runFix14,
  verifySourceHashes,
} from './stratz-match-level-reconciliation.mjs';

// ---------------------------------------------------------------------------
// Minimal synthetic schema helpers
// ---------------------------------------------------------------------------
const named = (name: string, kind = 'OBJECT') => ({ kind, name, ofType: null });
const nonNull = (type: any) => ({ kind: 'NON_NULL', name: null, ofType: type });
const list = (type: any) => ({ kind: 'LIST', name: null, ofType: type });
const field = (name: string, type: any, args: any[] = [], description: string | null = null) =>
  ({ name, type, args, description, isDeprecated: false });
const arg = (name: string, type: any) => ({ name, type, description: null, defaultValue: null });

function schema(extraRootFields: any[] = [], extraTypes: any[] = []) {
  const Long = named('Long', 'SCALAR');
  const Short = named('Short', 'SCALAR');
  const Bool = named('Boolean', 'SCALAR');
  return {
    __schema: {
      queryType: { name: 'Root' },
      types: [
        { kind: 'OBJECT', name: 'Root', fields: [
          field('match', named('Match'), [arg('id', nonNull(Long))]),
          field('heroStats', named('HeroStats')),
          field('player', named('Player'), [arg('steamAccountId', nonNull(Long))]),
          ...extraRootFields,
        ] },
        { kind: 'OBJECT', name: 'Match', fields: [
          field('id', Long), field('didRadiantWin', Bool), field('startDateTime', Long),
          field('players', list(named('MatchPlayer'))),
        ] },
        { kind: 'OBJECT', name: 'MatchPlayer', fields: [
          field('matchId', Long), field('heroId', Short), field('isRadiant', Bool),
        ] },
        { kind: 'OBJECT', name: 'HeroStats', fields: [
          field('matchUp', list(named('Dryad')), [arg('heroIds', list(Short)), arg('week', Long), arg('bracketBasicIds', list(named('Bracket', 'ENUM'))), arg('take', named('Int', 'SCALAR'))]),
        ] },
        { kind: 'OBJECT', name: 'Dryad', fields: [field('heroId', Short), field('vs', list(named('DryadRow')))] },
        { kind: 'OBJECT', name: 'DryadRow', fields: [field('heroId1', Short), field('heroId2', Short), field('matchCount', Long), field('winCount', Long)] },
        { kind: 'OBJECT', name: 'Player', fields: [
          field('matches', list(named('Match')), [arg('heroIds', list(Short)), arg('startDateTime', Long), arg('bracketIds', list(named('Int', 'SCALAR')))]),
        ] },
        ...extraTypes,
      ],
    },
  };
}

describe('§3 schema discovery', () => {
  it('1. parses capabilities: aggregate without match IDs, scoped match lists → UNAVAILABLE', () => {
    const result = discoverMatchLevelCapabilities(schema()) as any;
    expect(result.status).toBe('MATCH_LEVEL_EVIDENCE_UNAVAILABLE');
    expect(result.aggregateEndpoint.path).toBe('heroStats.matchUp');
    expect(result.aggregateEndpoint.exposesMatchIdentities).toBe(false);
    const player = result.matchListEndpoints.find((e: any) => e.path === 'player.matches');
    expect(player).toMatchObject({ scope: 'ENTITY_SCOPED', heroPairFilter: true, timeFilter: true, bracketFilter: true, populationCandidate: false });
    expect(result.matchType.typeName).toBe('Match');
  });

  it('1b. an unscoped hero-pair/time/bracket match list is reported as a candidate', () => {
    const s = schema([field('findMatches', list(named('Match')), [
      arg('heroIds', list(named('Short', 'SCALAR'))), arg('week', named('Long', 'SCALAR')),
      arg('bracketBasicIds', list(named('Bracket', 'ENUM'))), arg('skip', named('Int', 'SCALAR')),
    ])]);
    const result = discoverMatchLevelCapabilities(s) as any;
    expect(result.status).toBe('MATCH_LEVEL_ENDPOINT_CANDIDATE_FOUND');
    expect(result.populationCandidates).toEqual(['findMatches']);
  });

  it('2. unknown fields are never reported as found', () => {
    const types = new Map(schema().__schema.types.map((t: any) => [t.name, t]));
    expect(findField(types, 'Match', 'didRadiantWin').found).toBe(true);
    expect(findField(types, 'Match', 'winnerTeam')).toEqual({ name: 'winnerTeam', found: false });
    expect(findField(types, 'NoSuchType', 'id').found).toBe(false);
    expect(discoverMatchLevelCapabilities({}).status).toBe('UNVERIFIED');
  });

  it('archived real schema reproduces the evidence capability report', () => {
    const raw = JSON.parse(readFileSync(new URL('../research/data-quality/stratz-reverse-pair-match-level-raw-responses.json', import.meta.url), 'utf8'));
    const evidence = JSON.parse(readFileSync(new URL('../research/data-quality/stratz-reverse-pair-match-level-evidence.json', import.meta.url), 'utf8'));
    const result = discoverMatchLevelCapabilities(raw.schemaIntrospection.response.data);
    expect(result).toEqual(evidence.discoveredCapabilities);
    expect(result.status).toBe('MATCH_LEVEL_EVIDENCE_UNAVAILABLE');
    expect(evidence.rootCause).toMatchObject({ status: 'UNRESOLVED', productionPublishAllowed: false });
    expect(canonicalJsonSha256(evidence, 'evidenceSha256')).toBe(evidence.evidenceSha256);
  });
});

describe('§5 match IDs and pagination', () => {
  it('3. missing match IDs are counted, not dropped silently', () => {
    const result = collectMatchIds([{ id: 1 }, { id: null }, {}, { id: 2 }]);
    expect(result).toMatchObject({ returnedRecords: 4, missingIdRecords: 2, uniqueIds: ['1', '2'] });
  });

  it('4/16. duplicate match IDs / records are detected', () => {
    const result = collectMatchIds([{ id: 9007199254740993n.toString() }, { id: '9007199254740993' }, { id: 5 }]);
    expect(result.duplicateIds).toEqual(['9007199254740993']);
    expect(result.uniqueIds).toEqual(['5', '9007199254740993']);
  });

  it('5. pagination is complete only when the last page is short', () => {
    expect(assessPagination([{ cursor: 0, ids: ['1', '2'] }, { cursor: 2, ids: ['3'] }], { take: 2 }).status).toBe('COMPLETE');
    expect(assessPagination([{ cursor: 0, ids: ['1', '2'] }], { take: 2 })).toMatchObject({ status: 'INCOMPLETE', reason: 'LAST_PAGE_FULL' });
    expect(assessPagination([], { take: 2 }).status).toBe('UNVERIFIED');
    expect(assessPagination([{ cursor: 0, ids: ['1'], error: 'x' }], { take: 2 }).status).toBe('INCOMPLETE');
  });

  it('6. cursor loops and repeated pages are detected', () => {
    expect(assessPagination([{ cursor: 'a', ids: ['1', '2'] }, { cursor: 'a', ids: ['3'] }], { take: 2 }).status).toBe('LOOP_DETECTED');
    expect(assessPagination([{ cursor: 0, ids: ['1', '2'] }, { cursor: 2, ids: ['1', '2'] }], { take: 2 }))
      .toMatchObject({ status: 'LOOP_DETECTED', loopAtPage: 1 });
  });
});

describe('§6 A→B / B→A set comparison', () => {
  const full = (ids: string[]) => ({ ids, complete: true });

  it('7. intersection', () => {
    expect(compareMatchSets(full(['1', '2', '3']), full(['2', '3', '4']))).toMatchObject({ intersectionCount: 2, unionCount: 4 });
  });
  it('8. only A→B', () => {
    expect(compareMatchSets(full(['1', '2']), full(['2'])).onlyAtoB).toEqual(['1']);
  });
  it('9. only B→A', () => {
    expect(compareMatchSets(full(['2']), full(['2', '7'])).onlyBtoA).toEqual(['7']);
  });
  it('10. equal sets', () => {
    expect(compareMatchSets(full(['1', '2']), full(['2', '1'])).status).toBe('EQUAL_SETS');
  });
  it('11. different sets', () => {
    expect(compareMatchSets(full(['1']), full(['2'])).status).toBe('DIFFERENT_SETS');
  });
  it('12. an empty set from an incomplete source is not a proven zero population', () => {
    const result = compareMatchSets({ ids: [], complete: false }, full(['1']));
    expect(result.status).toBe('INCOMPLETE');
    expect(reconcileCount(0, 301, false).status).toBe('MATCH_LEVEL_UNAVAILABLE');
    expect(reconcileCount(null, 301, false).difference).toBeNull();
  });
  it('13. count reconciliation against the aggregate', () => {
    expect(reconcileCount(301, 301, true)).toEqual({ status: 'MATCH', difference: 0 });
    expect(reconcileCount(299, 301, true)).toEqual({ status: 'MISMATCH', difference: -2 });
    expect(reconcileCount(1, undefined, true).status).toBe('AGGREGATE_UNAVAILABLE');
  });
});

describe('§9 bucket assignment (production BUCKET_SEC)', () => {
  it('14. assigns a match to its production week bucket', () => {
    expect(BUCKET_SEC).toBe(604800);
    expect(assignBucket(2963 * BUCKET_SEC + 3600)).toBe(2963);
    expect(checkBucketAssignment({ startDateTime: 2964 * BUCKET_SEC + 10 }, 2964).status).toBe('CONSISTENT');
    expect(checkBucketAssignment({ startDateTime: 2964 * BUCKET_SEC + 10, reportedBucket: 2963 }, 2964).status).toBe('REPORTED_BUCKET_DIFFERS');
    expect(checkBucketAssignment({}, 2964).status).toBe('TIMESTAMP_MISSING');
  });
  it('15. boundary timestamps: start inclusive, end exclusive', () => {
    expect(assignBucket(2963 * BUCKET_SEC)).toBe(2963);
    expect(assignBucket(2964 * BUCKET_SEC - 1)).toBe(2963);
    expect(assignBucket(2964 * BUCKET_SEC)).toBe(2964);
    expect(checkBucketAssignment({ startDateTime: 2964 * BUCKET_SEC }, 2963).status).toBe('OUTSIDE_EXPECTED_BUCKET');
  });
});

describe('§8 winner orientation and winCount', () => {
  const match = (aRadiant: boolean, radiantWin: boolean, extra: any = {}) => ({
    didRadiantWin: radiantWin,
    players: [
      { heroId: 58, isRadiant: aRadiant, ...extra.a },
      { heroId: 61, isRadiant: !aRadiant, ...extra.b },
    ],
  });

  it('17. determines sides and winner from didRadiantWin + isRadiant', () => {
    expect(matchOrientation(match(true, true), 58, 61)).toMatchObject({ status: 'OPPOSING_TEAMS', heroAWon: true });
    expect(matchOrientation(match(false, true), 58, 61)).toMatchObject({ status: 'OPPOSING_TEAMS', heroAWon: false });
    expect(matchOrientation({ didRadiantWin: true, players: [{ heroId: 58, isRadiant: true }, { heroId: 61, isRadiant: true }] }, 58, 61).status).toBe('SAME_TEAM');
    expect(matchOrientation({ players: [{ heroId: 58, isRadiant: true }] }, 58, 61).status).toBe('HERO_MISSING');
    expect(matchOrientation(match(true, true, { a: { isVictory: false } }), 58, 61).status).toBe('WINNER_FLAGS_INCONSISTENT');
  });

  it('18. reconciles winCount without assuming heroId1 orientation', () => {
    const orientations = [match(true, true), match(true, false), match(false, false)].map((m) => matchOrientation(m, 58, 61));
    expect(reconcileWinCount(orientations, 2)).toMatchObject({ status: 'WINCOUNT_EQUALS_HERO1_WINS', heroAWins: 2 });
    expect(reconcileWinCount(orientations, 1).status).toBe('WINCOUNT_EQUALS_HERO2_WINS');
    expect(reconcileWinCount(orientations, 3).status).toBe('WINCOUNT_UNEXPLAINED');
    expect(reconcileWinCount([...orientations, { status: 'HERO_MISSING' }], 2).status).toBe('UNVERIFIED');
  });
});

describe('§7 aggregate cross-check', () => {
  const response = (rows: any[]) => ({ data: { heroStats: { w2963: [{ heroId: 58, vs: rows }] } } });
  const prodQuery = `{ heroStats { w2963: matchUp(heroIds: [58], week: ${2963 * BUCKET_SEC}, bracketBasicIds: [${BRACKETS.join(', ')}], take: 200) { heroId } } }`;

  it('only production-filter queries are counted; archives without query text are accepted', () => {
    expect(queryUsesProductionFilter(prodQuery, 2963)).toBe(true);
    expect(queryUsesProductionFilter(prodQuery.replace('HERALD_GUARDIAN, ', ''), 2963)).toBe(false);
    expect(queryUsesProductionFilter(null, 2963)).toBeNull();
    const responses = collectHeroStatsResponses({
      a: { query: prodQuery, response: response([{ heroId1: 58, heroId2: 61, matchCount: 301, winCount: 137 }]) },
      b: { query: prodQuery.replace('HERALD_GUARDIAN, ', ''), response: response([{ heroId1: 58, heroId2: 61, matchCount: 206, winCount: 95 }]) },
    });
    const rows = aggregateCrossCheck({ s: responses }, [{ canonicalPairId: '58:61', heroAId: 58, heroBId: 61 }], [2963], [
      { canonicalPairId: '58:61', bucket: 2963, production: { gamesAtoB: 301, winsAtoB: 137, gamesBtoA: 318, winsBtoA: 179 } },
    ]);
    expect(rows[0].sources.s.AtoB).toEqual({ observations: 1, distinct: ['301/137'], rejectedNonProduction: 1 });
    expect(rows[0].matchLevel.AtoB.status).toBe('MATCH_LEVEL_UNAVAILABLE');
  });
});

describe('protection and determinism', () => {
  it('19. historical FIX9–FIX13 and production hashes are unchanged', () => {
    const hashes = captureSourceHashes();
    expect(verifySourceHashes(hashes)).toBe(true);
    expect(() => verifySourceHashes({ ...hashes, fix13Evidence: { physicalSha256: '0' } })).toThrow(/fix13Evidence/);
  });

  it('20. evidence output is deterministic for identical inputs', () => {
    const fix13 = JSON.parse(readFileSync(new URL('../research/data-quality/stratz-reverse-pair-partition-semantics-evidence.json', import.meta.url), 'utf8'));
    const input = () => ({
      sourceHashesBefore: { a: { physicalSha256: 'x' } },
      sourceHashesAfter: { a: { physicalSha256: 'x' } },
      introspection: { record: { requestId: 'r', status: 'VERIFIED', requestHash: 'q', responseHash: 'h', finishedAt: '2026-01-01T00:00:00.000Z', transportCreated: true, transportClosed: true } },
      capabilities: discoverMatchLevelCapabilities(schema()),
      fix13,
      aggregateRows: [],
    });
    const a = buildMatchLevelEvidence(input() as any);
    const b = buildMatchLevelEvidence(input() as any);
    expect(a.evidenceSha256).toBe(b.evidenceSha256);
    expect(a.finalStatus).toBe('MATCH_LEVEL_EVIDENCE_UNAVAILABLE');
    expect(a.matchSets.pairWeeks).toHaveLength(32);
    expect(a.matchSets.pairWeeks.every((row: any) => row.AtoB === null && row.comparison.status === 'INCOMPLETE')).toBe(true);
  });

  it('runFix14 issues exactly one introspection and no match queries (mock transport)', async () => {
    const queries: string[] = [];
    class FakeTransport {
      async init() {}
      async query(q: string) {
        queries.push(q);
        return { data: schema() };
      }
      async close() {}
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { evidence, raw } = await runFix14({ StratzTransport: FakeTransport, loadToken: () => 'test-token', now: () => new Date('2026-01-01T00:00:00Z') });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/__schema/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(evidence.queries.matchLevelRequests).toBe(0);
    expect(JSON.stringify([evidence, raw])).not.toContain('test-token');
    expect(evidence.countReconciliation.aggregateStablePairWeeks).toBe(32);
  });
});
