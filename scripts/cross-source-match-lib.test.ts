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
  sideOf,
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

describe('§2 a row without a position contributes no cells (§7)', () => {
  // The §7 fixture: hero 1, position null, one enemy, one item.
  const raw = { heroId: 1, position: null, isRadiant: true };
  const roster = [...fullRoster()].map((p) => ({ ...p, position: null }));

  it('parseStratzPosition returns null for a missing position', () => {
    expect(parseStratzPosition(raw.position)).toBeNull();
  });

  it('the raw player is still usable and keeps its identity', () => {
    const inv = splitInventory({ item0Id: 3, item1Id: 5 });
    expect(raw.heroId).toBe(1);
    expect(inv.finalInventory).toEqual([3, 5]);
  });

  it('every null-position player yields no positional key', () => {
    // The invariant: a null position must never appear inside a cell key.
    for (const p of roster) {
      const position = parseStratzPosition(p.position);
      expect(position).toBeNull();
      expect(String(position)).not.toMatch(/POSITION/);
    }
    expect(roster).toHaveLength(10);
  });

  it('the research script only builds cells when position !== null', async () => {
    const code = (await readFile(new URL('./cross-source-match-research.mjs', import.meta.url), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).toContain('const positional = position !== null');
    expect(code).toContain('if (positional) {');
  });
});

describe('§1 non-public discovery rows never take a bucket slot (§8)', () => {
  // The §8 fixture. Only the first row may occupy a slot.
  const discovery = [
    { match_id: 1, avg_rank_tier: 34, leagueid: 0 },
    { match_id: 2, avg_rank_tier: 35, leagueid: 123 },
    { match_id: 3, avg_rank_tier: 36, leagueid: null },
  ];
  const eligible = (r) => r.leagueid === 0;

  it('accepts only leagueid === 0', () => {
    expect(discovery.map(eligible)).toEqual([true, false, false]);
  });

  it('a missing leagueid is unknown, not eligible', () => {
    expect(eligible({ leagueid: null })).toBe(false);
    expect(eligible({ leagueid: undefined })).toBe(false);
  });

  it('rejects a league match even when its tier is in range', () => {
    const row = { match_id: 2, avg_rank_tier: 35, leagueid: 123 };
    expect(row.avg_rank_tier).toBe(35);
    expect(eligible(row)).toBe(false);
  });

  it('only one row survives, so the bucket keeps exactly one slot', () => {
    const taken = discovery.filter(eligible).filter((r) => r.avg_rank_tier >= 30 && r.avg_rank_tier <= 45);
    expect(taken.map((r) => r.match_id)).toEqual([1]);
  });
});

describe('§3 match identity is the bridge invariant (§9)', () => {
  const accept = (requestedId, match) => (match == null ? null : Number(match.id) === Number(requestedId));

  it('accepts a response for the requested match', () => {
    expect(accept(100, { id: 100 })).toBe(true);
  });

  it('rejects a response for a different match', () => {
    expect(accept(100, { id: 101 })).toBe(false);
  });

  it('treats a null match as not-found rather than a mismatch', () => {
    expect(accept(100, null)).toBeNull();
  });

  it('compares numerically, not as strings', () => {
    expect(accept(100, { id: '100' })).toBe(true);
  });
});

describe('§5 strict position parser', () => {
  it('accepts only the exact STRATZ enum', () => {
    for (const n of [1, 2, 3, 4, 5]) expect(parseStratzPosition(`POSITION_${n}`)).toBe(n);
  });

  it('rejects a stray digit instead of scraping it (§5)', () => {
    // A loose /(\d+)/ accepted all of these as position 3.
    for (const bad of ['garbage_3', 'POSITION_03', 'POSITION_3x', 'xPOSITION_3', 'POSITION_33']) {
      expect(parseStratzPosition(bad), bad).toBeNull();
    }
  });

  it('rejects out-of-range and unknown values', () => {
    for (const bad of ['POSITION_0', 'POSITION_6', 'POSITION_9', 'POSITION_UNKNOWN', '', null, undefined, 3]) {
      expect(parseStratzPosition(bad), String(bad)).toBeNull();
    }
  });
});

describe('§6 a side is a real boolean or nothing', () => {
  it('maps true to R and false to D', () => {
    expect(sideOf({ isRadiant: true })).toBe('R');
    expect(sideOf({ isRadiant: false })).toBe('D');
  });

  it('refuses every non-boolean (§6)', () => {
    for (const bad of [undefined, null, 0, 1, 'true', 'abc', {}, []]) {
      expect(sideOf({ isRadiant: bad }), String(bad)).toBeNull();
    }
    expect(sideOf({})).toBeNull();
    expect(sideOf(null)).toBeNull();
  });

  it('never invents a roster key for an unknown side', () => {
    for (const bad of [undefined, null, 0, 1, 'true', 'abc']) {
      expect(extractRosterKey({ heroId: 1, isRadiant: bad }), String(bad)).toBeNull();
    }
  });

  it('still keys real booleans', () => {
    expect(extractRosterKey({ heroId: 1, isRadiant: true })).toBe('1:R');
    expect(extractRosterKey({ heroId: 1, isRadiant: false })).toBe('1:D');
  });

  it('refuses a missing heroId even with a valid side', () => {
    expect(extractRosterKey({ isRadiant: true })).toBeNull();
    expect(extractRosterKey({ heroId: null, isRadiant: true })).toBeNull();
  });
});

describe('§4 the failure taxonomy stays distinct', () => {
  it('separates id mismatch from not-found', () => {
    expect(BRIDGE_FAILURE.STRATZ_ID_MISMATCH).toBe('STRATZ_ID_MISMATCH');
    expect(BRIDGE_FAILURE.STRATZ_ID_MISMATCH).not.toBe(BRIDGE_FAILURE.STRATZ_NOT_FOUND);
    expect(Object.values(BRIDGE_FAILURE).filter((v) => v === 'STRATZ_ID_MISMATCH')).toHaveLength(1);
  });
});

describe('the research script is free of pseudo-cells (§2, §3, §1)', () => {
  const src = async () => readFile(new URL('./cross-source-match-research.mjs', import.meta.url), 'utf8');

  it('never writes a literal null position into a cell key (§2)', async () => {
    expect(await src()).not.toMatch(/`\$\{[^\n]*\}\|null\|/);
    expect(await src()).not.toMatch(/position \?\? 'null'/);
  });

  it('guards the bridge on match identity (§3)', async () => {
    expect(await src()).toContain('STRATZ_ID_MISMATCH');
    expect(await src()).toMatch(/Number\(m\.id\)\s*!==\s*Number\(matchId\)/);
  });

  it('rejects non-public discovery rows before they take a slot (§1)', async () => {
    const code = await src();
    expect(code).toContain('m.leagueid !== 0');
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