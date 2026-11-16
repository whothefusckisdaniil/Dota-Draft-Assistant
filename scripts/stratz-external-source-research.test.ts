import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { BRACKETS, BUCKET_SEC } from './update-data-stratz.mjs';
import { canonicalJsonSha256 } from './stratz-matchup-root-cause-research.mjs';
import {
  EXPECTED_PHYSICAL_SHA256,
  assessSource,
  buildEscalation,
  buildExternalEvidence,
  captureSourceHashes,
  chunkSql,
  classifyRootCause,
  dedupeMatches,
  externalPairOrientation,
  rankGroupOfAverage,
  reconcilePairWeek,
  renderEscalationMarkdown,
  scanForCredentials,
  setEscalationStatus,
  verifySourceHashes,
} from './stratz-external-source-research.mjs';

const dq = (name: string) => JSON.parse(readFileSync(new URL(`../research/data-quality/${name}`, import.meta.url), 'utf8'));
const fix11 = dq('stratz-reverse-pair-root-cause-evidence.json');
const fix12 = dq('stratz-reverse-pair-bracket-semantics-evidence.json');
const fix13 = dq('stratz-reverse-pair-partition-semantics-evidence.json');
const fix14 = dq('stratz-reverse-pair-match-level-evidence.json');
const escalation = buildEscalation({ fix11, fix12, fix13, fix14, sourceHashes: { fix13Evidence: { path: 'x', physicalSha256: 'y' } } });
const markdown = renderEscalationMarkdown(escalation);

const FULL = {
  matchIds: true, timestamp: true, heroIdsBothTeams: true, playerSide: true, winner: true,
  rank: 'PER_PLAYER', pagination: true, historicalCoverage: true, accessible: true,
};
const PAIR = { canonicalPairId: '58:61', heroAId: 58, heroBId: 61 };
const match = (id: number, t: number, radiant: number[], dire: number[], extra: any = {}) => ({
  match_id: id, start_time: t, radiant_win: true, lobby_type: 7, game_mode: 22,
  avg_rank_tier: 43, num_rank_tier: 8, radiant_team: radiant, dire_team: dire, ...extra,
});
const T = 2963 * BUCKET_SEC;

describe('Direction A — support escalation', () => {
  it('1. contains both directions with counts confirmed by FIX12/FIX13', () => {
    const [ench, brood] = escalation.examples;
    expect(ench.aggregate).toEqual({ gamesAtoB: 1318, gamesBtoA: 1361, delta: -43 });
    expect(brood.aggregate).toEqual({ gamesAtoB: 1182, gamesBtoA: 1137, delta: 45 });
    expect(markdown).toContain('| 1318 | 1361 | -43 |');
    expect(markdown).toContain('| 1182 | 1137 | +45 |');
    expect(markdown).toContain('301 / 318');
  });

  it('2. contains all production brackets from production config', () => {
    expect(escalation.productionParameters.bracketBasicIds).toEqual([...BRACKETS]);
    for (const bracket of BRACKETS) expect(markdown).toContain(`\`${bracket}\``);
    expect(escalation.questions).toHaveLength(11);
  });

  it('3. contains no credentials; the scanner catches planted ones', () => {
    expect(scanForCredentials(markdown + JSON.stringify(escalation))).toEqual([]);
    expect(scanForCredentials('Authorization: Bearer abcdefghijklmnop')).not.toEqual([]);
    expect(scanForCredentials('x?key=ABCDEF0123456789')).not.toEqual([]);
    expect(scanForCredentials('secret-token-value-123 here', ['secret-token-value-123'])).toContain('KNOWN_SECRET_VALUE');
  });

  it('4. status is DRAFTED and never becomes SENT without confirmation', () => {
    expect(escalation.status).toBe('DRAFTED');
    expect(() => setEscalationStatus(escalation, 'SENT', undefined)).toThrow(/confirmation/);
    expect(() => setEscalationStatus(escalation, 'ANSWERED', { confirmedBy: 'x' })).toThrow(/confirmation/);
    const sent = setEscalationStatus(escalation, 'SENT', { confirmedBy: 'user', at: '2026-11-14', reference: 'ticket-1' });
    expect(sent.status).toBe('SENT');
    expect(() => setEscalationStatus(sent, 'DRAFTED', { confirmedBy: 'u', at: 'a', reference: 'r' })).toThrow();
  });
});

describe('Direction B — source assessment', () => {
  it('5. source without match IDs → NOT_SUPPORTED', () => {
    expect(assessSource({ ...FULL, matchIds: false }).verdict).toBe('NOT_SUPPORTED');
  });
  it('6. source without (practical) pagination → INSUFFICIENT', () => {
    expect(assessSource({ ...FULL, pagination: false })).toMatchObject({ verdict: 'INSUFFICIENT', reasons: ['NO_PRACTICAL_PAGINATION'] });
    expect(assessSource({ ...FULL, pagination: 'IMPRACTICAL' }).verdict).toBe('INSUFFICIENT');
  });
  it('7. source without timestamp is excluded from bucket reconciliation', () => {
    const result = assessSource({ ...FULL, timestamp: false });
    expect(result.bucketReconciliation).toBe(false);
    expect(result.verdict).toBe('INSUFFICIENT');
  });
  it('8. source without both teams\' hero IDs is excluded from pair reconciliation', () => {
    const result = assessSource({ ...FULL, heroIdsBothTeams: false });
    expect(result.pairReconciliation).toBe(false);
    expect(result.reasons).toContain('NO_TWO_TEAM_HERO_IDS');
  });
  it('limitations are explicit: match-average rank, key-only access', () => {
    expect(assessSource({ ...FULL, rank: 'MATCH_AVERAGE' })).toMatchObject({ verdict: 'SUITABLE_WITH_LIMITATIONS', limitations: ['RANK_IS_MATCH_AVERAGE_NOT_PER_PLAYER'] });
    expect(assessSource({ ...FULL, rank: false }).limitations).toContain('NO_RANK_OR_BRACKET');
    expect(assessSource({ ...FULL, accessible: false }).verdict).toBe('INSUFFICIENT');
    expect(assessSource(FULL).verdict).toBe('SUITABLE');
  });
});

describe('external dataset handling', () => {
  const raw = (rows: any[], extra: any = {}) => ({
    retrievedAt: '2026-11-13T00:00:00.000Z',
    opendota: {
      boundaryMarginSec: { lower: 172800, upper: 100000 },
      chunks: [{
        fromId: 1, toId: 100, status: 'OK',
        rows: rows.map((m) => ['match_id', 'start_time', 'radiant_win', 'lobby_type', 'game_mode', 'avg_rank_tier', 'num_rank_tier', 'radiant_team', 'dire_team'].map((f) => m[f] ?? null)),
        totals: Object.fromEntries(fix13.buckets.map((b: number) => [`b${b}`, { matches: 10, ranked: 5, zeroHero: 1 }])),
      }],
      ...extra,
    },
  });

  it('9. partial coverage is never classified as complete', () => {
    const evidence = buildExternalEvidence({ raw: raw([match(1, T + 10, [58], [61])]), rawSha256: 'r', fix13, sourceHashes: {} });
    expect(evidence.sourceCoverage).toMatchObject({ status: 'PARTIAL', classification: 'PARTIAL_MATCH_COVERAGE' });
    expect(evidence.reconciliation.every((row: any) => row.coverage !== 'COMPLETE' && row.productionThresholdApplied === false)).toBe(true);
  });

  it('10. duplicate match IDs are detected, conflicting copies flagged', () => {
    const { matches, duplicates } = dedupeMatches([match(5, T, [58], [61]), match(5, T, [58], [61]), match(6, T, [58], [61]), match(6, T + 1, [58], [61])]);
    expect(matches).toHaveLength(2);
    expect(duplicates).toEqual([
      { matchId: '5', occurrences: 2, conflicting: false },
      { matchId: '6', occurrences: 2, conflicting: true },
    ]);
  });

  it('11/12. bucket assignment uses production BUCKET_SEC with [start, end) boundaries', () => {
    const matches = [
      match(1, T, [58], [61]), // first second of 2963
      match(2, T + BUCKET_SEC - 1, [58], [61]), // last second of 2963
      match(3, T + BUCKET_SEC, [58], [61]), // first second of 2964
    ];
    const w2963 = reconcilePairWeek({ pair: PAIR, bucket: 2963, matches, stratz: null, coverageStatus: 'PARTIAL' });
    const w2964 = reconcilePairWeek({ pair: PAIR, bucket: 2964, matches, stratz: null, coverageStatus: 'PARTIAL' });
    expect(w2963.external.subsets.ALL_PUBLIC.matches).toBe(2);
    expect(w2964.external.subsets.ALL_PUBLIC.matches).toBe(1);
  });

  it('13. winner orientation is derived, never guessed', () => {
    expect(externalPairOrientation(match(1, T, [58, 1], [61, 2]), 58, 61)).toEqual({ status: 'OPPOSING', heroAWon: true });
    expect(externalPairOrientation(match(1, T, [61], [58]), 58, 61)).toEqual({ status: 'OPPOSING', heroAWon: false });
    expect(externalPairOrientation(match(1, T, [58], [61], { radiant_win: null }), 58, 61)).toEqual({ status: 'OPPOSING', heroAWon: null });
    expect(externalPairOrientation(match(1, T, [58, 61], [2]), 58, 61).status).toBe('SAME_TEAM');
    expect(externalPairOrientation(match(1, T, [0, 0], [0, 0]), 58, 61).status).toBe('PAIR_NOT_PRESENT');
    const row = reconcilePairWeek({ pair: PAIR, bucket: 2963, matches: [match(1, T, [58], [61], { radiant_win: null })], stratz: null, coverageStatus: 'PARTIAL' });
    expect(row.external.subsets.ALL_PUBLIC).toMatchObject({ matches: 1, heroAWins: 0, heroBWins: 0, winnerUnknown: 1 });
  });

  it('rank groups use the tens digit of avg_rank_tier; missing rank is UNKNOWN', () => {
    expect(rankGroupOfAverage(15)).toBe('HERALD_GUARDIAN');
    expect(rankGroupOfAverage(43)).toBe('CRUSADER_ARCHON');
    expect(rankGroupOfAverage(80)).toBe('DIVINE_IMMORTAL');
    expect(rankGroupOfAverage(null)).toBe('UNKNOWN');
  });

  it('18. empty external data is not read as zero STRATZ games', () => {
    const evidence = buildExternalEvidence({ raw: raw([]), rawSha256: 'r', fix13, sourceHashes: {} });
    const row = evidence.reconciliation.find((item: any) => item.canonicalPairId === '58:61' && item.bucket === 2963);
    expect(row.stratz.gamesAtoB).toBe(301);
    expect(row.comparison.externalMatches).toBe(0);
    expect(row.comparison.relativeDifferenceAtoB).toBeNull();
    expect(row.coverage).toBe('PARTIAL');
    expect(row.productionThresholdApplied).toBe(false);
  });

  it('collector SQL is a read-only SELECT over public_matches with the pair predicate', () => {
    const sql = chunkSql(10, 20, [PAIR]);
    expect(sql).toMatch(/^SELECT .* FROM public_matches WHERE match_id >= 10 AND match_id < 20/);
    expect(sql).toContain('(58 = ANY(radiant_team) AND 61 = ANY(dire_team)) OR (61 = ANY(radiant_team) AND 58 = ANY(dire_team))');
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP)\b/i);
  });
});

describe('root cause, hashes, determinism', () => {
  it('14/15. protected FIX9–FIX14, production data and production module hashes are verified', () => {
    const hashes = captureSourceHashes();
    expect(verifySourceHashes(hashes)).toBe(true);
    expect(Object.keys(EXPECTED_PHYSICAL_SHA256)).toHaveLength(14);
    expect(EXPECTED_PHYSICAL_SHA256.productionModule).toMatch(/^[0-9a-f]{64}$/);
    expect(() => verifySourceHashes({ ...hashes, fix14Raw: { physicalSha256: 'x' } })).toThrow(/fix14Raw/);
  });

  it('16. root cause stays UNRESOLVED without an answer or complete reconciliation', () => {
    const partial = classifyRootCause({ escalation, externalEvidence: { sourceCoverage: { status: 'PARTIAL', reasons: ['X'] } } });
    expect(partial).toMatchObject({ status: 'UNRESOLVED', productionPublishAllowed: false });
    expect(partial.categories.find((c: any) => c.category === 'PUBLIC_SOURCE_COVERAGE_INSUFFICIENT').applies).toBe(true);
    const answered = classifyRootCause({ escalation: { ...escalation, status: 'ANSWERED' }, externalEvidence: { sourceCoverage: { status: 'COMPLETE' } } });
    expect(answered.status).toBe('UNRESOLVED');
    expect(answered.categories.filter((c: any) => c.applies && c.category.endsWith('CONFIRMED'))).toEqual([]);
  });

  it('17. JSON generation is deterministic', () => {
    const again = buildEscalation({ fix11, fix12, fix13, fix14, sourceHashes: { fix13Evidence: { path: 'x', physicalSha256: 'y' } } });
    expect(JSON.stringify(again)).toBe(JSON.stringify(escalation));
    expect(renderEscalationMarkdown(again)).toBe(markdown);
    const rawFixture = { retrievedAt: 'r', opendota: { boundaryMarginSec: { lower: 1, upper: 1 }, chunks: [] } };
    const a = buildExternalEvidence({ raw: rawFixture, rawSha256: 's', fix13, sourceHashes: {} });
    const b = buildExternalEvidence({ raw: rawFixture, rawSha256: 's', fix13, sourceHashes: {} });
    expect(a.evidenceSha256).toBe(b.evidenceSha256);
    expect(canonicalJsonSha256(a, 'evidenceSha256')).toBe(a.evidenceSha256);
  });

  it('offline: building the escalation makes no network calls', () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    buildEscalation({ fix11, fix12, fix13, fix14, sourceHashes: {} });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
