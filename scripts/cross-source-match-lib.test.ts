/**
 * Cross-source bridge helper tests (ТЗ §27 §24, plus the §26 read-only guard).
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  BRIDGE_FAILURE,
  STRATZ_MATCH_QUERY,
  assertReadOnlyQuery,
  classifyBridgeFailure,
  extractEnemies,
  extractRosterKey,
  inventoryMultiset,
  parseStratzPosition,
  resultFromOpenDota,
  sameRoster,
  splitInventory,
  validatePositions,
} from './cross-source-match-lib.mjs';

const radiant = (heroId, position, extra = {}) => ({ heroId, position, isRadiant: true, ...extra });
const dire = (heroId, position, extra = {}) => ({ heroId, position, isRadiant: false, ...extra });
/** A clean 5v5 with positions 1..5 on each side. */
const fullRoster = () => [
  radiant(1, 'POSITION_1'), radiant(22, 'POSITION_2'), radiant(44, 'POSITION_3'),
  radiant(13, 'POSITION_4'), radiant(29, 'POSITION_5'),
  dire(52, 'POSITION_1'), dire(5, 'POSITION_2'), dire(8, 'POSITION_3'),
  dire(20, 'POSITION_4'), dire(36, 'POSITION_5'),
];

describe('the STRATZ query is read-only (§26)', () => {
  it('contains no mutation operation', () => {
    expect(() => assertReadOnlyQuery(STRATZ_MATCH_QUERY)).not.toThrow();
    expect(STRATZ_MATCH_QUERY).not.toMatch(/\bmutation\b/i);
  });

  it('declares a plain query', () => {
    expect(STRATZ_MATCH_QUERY.trimStart().startsWith('query')).toBe(true);
  });

  it('rejects a query that mutates', () => {
    expect(() => assertReadOnlyQuery('mutation { createMatch(id: 1) { id } }')).toThrow(/not read-only/);
  });

  it('rejects a query referencing a mutation field', () => {
    expect(() => assertReadOnlyQuery('query { x { deleteMatch } }')).toThrow(/deleteMatch/);
  });

  it('the research script sends only this query (§26)', async () => {
    const raw = await readFile(new URL('./cross-source-match-research.mjs', import.meta.url), 'utf8');
    // Strip comments first. The file's own prose says "mutation-free", and a
    // guard that fires on documentation is a guard people learn to disable.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/mutation/i);
    expect(code).toContain('STRATZ_MATCH_QUERY');
  });

  it('opens no GraphQL document of its own — only the shared constant (§26)', async () => {
    const raw = await readFile(new URL('./cross-source-match-research.mjs', import.meta.url), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const documents = code.match(/query\s+\w+\s*[({]|{ *match\s*\(/gi) ?? [];
    expect(documents).toHaveLength(0);
  });
});

describe('parseStratzPosition (§9)', () => {
  it('parses POSITION_1..POSITION_5', () => {
    for (const n of [1, 2, 3, 4, 5]) expect(parseStratzPosition(`POSITION_${n}`)).toBe(n);
  });

  it('returns null for null and UNKNOWN', () => {
    expect(parseStratzPosition(null)).toBeNull();
    expect(parseStratzPosition(undefined)).toBeNull();
    expect(parseStratzPosition('POSITION_UNKNOWN')).toBeNull();
  });

  it('rejects out-of-range 0 and 6 rather than clamping', () => {
    expect(parseStratzPosition('POSITION_0')).toBeNull();
    expect(parseStratzPosition('POSITION_6')).toBeNull();
    expect(parseStratzPosition(0)).toBeNull();
    expect(parseStratzPosition(6)).toBeNull();
  });
});

describe('extractRosterKey and sameRoster (§8)', () => {
  it('keys by heroId and side, not by array order', () => {
    expect(extractRosterKey(radiant(1, 'POSITION_1'))).toBe('1:R');
    expect(extractRosterKey(dire(1, 'POSITION_1'))).toBe('1:D');
  });

  it('treats the same heroes on different sides as different keys', () => {
    const a = [radiant(1, 'POSITION_1'), dire(1, 'POSITION_1')];
    const b = [dire(1, 'POSITION_1'), radiant(1, 'POSITION_1')];
    expect(sameRoster(a, b).exact).toBe(true);
    expect(sameRoster([radiant(1, 'POSITION_1')], [dire(1, 'POSITION_1')]).exact).toBe(false);
  });

  it('matches a 5v5 roster exactly', () => {
    expect(sameRoster(fullRoster(), fullRoster()).exact).toBe(true);
  });

  it('matches regardless of player order', () => {
    expect(sameRoster(fullRoster(), [...fullRoster()].reverse()).exact).toBe(true);
  });

  it('reports a player missing in STRATZ', () => {
    const r = sameRoster(fullRoster(), fullRoster().slice(0, 9));
    expect(r.exact).toBe(false);
    expect(r.missingInStratz).toHaveLength(1);
  });

  it('reports a player missing in OpenDota', () => {
    const r = sameRoster(fullRoster().slice(0, 9), fullRoster());
    expect(r.exact).toBe(false);
    expect(r.missingInOpenDota).toHaveLength(1);
  });

  it('detects a duplicate player on one side', () => {
    const st = fullRoster();
    st[1] = radiant(1, 'POSITION_2');
    const r = sameRoster(fullRoster(), st);
    expect(r.exact).toBe(false);
    expect(r.missingInOpenDota).toContain('1:R');
  });

  it('handles 4 vs 6 players as a mismatch', () => {
    const od = fullRoster().slice(0, 4);
    const st = fullRoster().slice(0, 6);
    const r = sameRoster(od, st);
    expect(r.exact).toBe(false);
    expect(r.openDotaCount).toBe(4);
    expect(r.stratzCount).toBe(6);
    // OpenDota is the subset, so STRATZ holds the two extra players.
    expect(r.missingInStratz).toHaveLength(0);
    expect(r.missingInOpenDota).toHaveLength(2);
  });

  it('does not let a stray 11th player pass as an exact roster', () => {
    const st = [...fullRoster(), radiant(99, 'POSITION_1')];
    expect(sameRoster(fullRoster(), st).exact).toBe(false);
  });
});

describe('extractEnemies (§11)', () => {
  it('returns exactly 5 enemies for a valid roster', () => {
    const r = fullRoster();
    expect(extractEnemies(r, r[0])).toHaveLength(5);
    expect(extractEnemies(r, r[5])).toHaveLength(5);
  });

  it('returns the opposite side, not the whole roster', () => {
    const r = fullRoster();
    const enemies = extractEnemies(r, r[0]);
    expect(enemies).not.toContain(1);   // not self
    expect(enemies).not.toContain(29);  // still Radiant
    expect(enemies).toContain(52);      // Dire
  });

  it('returns null when the roster is not 5v5', () => {
    expect(extractEnemies(fullRoster().slice(0, 9), fullRoster()[0])).toBeNull();
    expect(extractEnemies([], null)).toBeNull();
  });

  it('returns null for a 4-vs-6 roster rather than inventing enemies', () => {
    const bad = [...fullRoster(), radiant(99, 'POSITION_1')];
    expect(extractEnemies(bad, bad[0])).toBeNull();
  });
});

describe('validatePositions records rather than rejects (§10)', () => {
  it('reports full coverage on a clean 5v5', () => {
    const v = validatePositions(fullRoster());
    expect(v.total).toBe(10);
    expect(v.covered).toBe(10);
    expect(v.coveragePct).toBe(100);
    expect(v.teamsBalanced).toBe(true);
    expect(v.allPositionsDistinctPerTeam).toBe(true);
  });

  it('counts a null position as missing coverage', () => {
    const r = fullRoster();
    r[0].position = null;
    const v = validatePositions(r);
    expect(v.covered).toBe(9);
    expect(v.missing).toBe(1);
    expect(v.coveragePct).toBe(90);
  });

  it('treats POSITION_0 and POSITION_6 as missing, not as positions', () => {
    const r = fullRoster();
    r[0].position = 'POSITION_0';
    r[1].position = 'POSITION_6';
    expect(validatePositions(r).covered).toBe(8);
  });

  it('OBSERVES 1,2,3,4,4 instead of rejecting it', () => {
    const r = fullRoster();
    r[4].position = 'POSITION_4';
    const v = validatePositions(r);
    expect(v.allPositionsDistinctPerTeam).toBe(false);
    expect(v.perTeam.R.duplicated).toContain('4x2');
    expect(v.perTeam.R.missing).toContain(5);
    // Coverage is unaffected: the positions exist, they are just not distinct.
    expect(v.covered).toBe(10);
  });

  it('reports an unbalanced team', () => {
    expect(validatePositions(fullRoster().slice(0, 8)).teamsBalanced).toBe(false);
  });

  it('survives an empty roster', () => {
    const v = validatePositions([]);
    expect(v.total).toBe(0);
    expect(v.coveragePct).toBeNull();
  });
});