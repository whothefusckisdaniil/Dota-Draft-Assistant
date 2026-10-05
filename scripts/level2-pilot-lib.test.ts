/**
 * Level-2 pure helpers (ТЗ §28 §31/§32).
 *
 * The aggregation is NOT re-implemented here — the tests call the same
 * functions the report calls, so a test passing means the report's maths
 * passing.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_DISCOVERY_ROWS_PER_BUCKET,
  POSITION_CLASS,
  SUPPORT_BINS_HE,
  SUPPORT_BINS_HP,
  TARGET_PER_BUCKET,
  TARGET_TOTAL,
  aggregateHeroPosition,
  aggregateItemCells,
  aggregateSupport,
  buildHeroEnemyRows,
  buildItemRows,
  bucketSupport,
  cellOverlap,
  compareAB,
  dedupeItemPresence,
  isItemClean,
  isResultClean,
  isTupleEligible,
  ontologyIntersection,
  positionClass,
  splitByMode,
  splitByRank,
  splitMatchesAB,
  supportSummary,
} from './level2-pilot-lib.mjs';

/** A clean 5v5, positions 1..5 on each side, distinct inventories. */
const roster = () => [
  { heroId: 1, position: 'POSITION_1', isRadiant: true, isVictory: true, item0Id: 50, item1Id: 116, item2Id: 50 },
  { heroId: 22, position: 'POSITION_2', isRadiant: true, isVictory: false, item0Id: 63, item1Id: 1, item2Id: 116 },
  { heroId: 44, position: 'POSITION_3', isRadiant: true, isVictory: true, item0Id: 36, item1Id: 108, item2Id: 180 },
  { heroId: 13, position: 'POSITION_4', isRadiant: true, isVictory: true, item0Id: 214, item1Id: 147, item2Id: 48 },
  { heroId: 29, position: 'POSITION_5', isRadiant: true, isVictory: false, item0Id: 141, item1Id: 254, item2Id: 63 },
  { heroId: 52, position: 'POSITION_1', isRadiant: false, isVictory: true, item0Id: 1, item1Id: 108, item2Id: 50 },
  { heroId: 5, position: 'POSITION_2', isRadiant: false, isVictory: true, item0Id: 63, item1Id: 116, item2Id: 36 },
  { heroId: 8, position: 'POSITION_3', isRadiant: false, isVictory: false, item0Id: 108, item1Id: 48, item2Id: 180 },
  { heroId: 20, position: 'POSITION_4', isRadiant: false, isVictory: true, item0Id: 147, item1Id: 214, item2Id: 141 },
  { heroId: 36, position: 'POSITION_5', isRadiant: false, isVictory: false, item0Id: 254, item1Id: 141, item2Id: 254 },
];
const ok = (players, extra = {}) => [{ ok: true, matchId: 'm1', bucket: 'herald_guardian', mode: 23, ...extra }];

describe('the fixed sample is declared, not derived (§2)', () => {
  it('is 100 per bucket and 400 total', () => {
    expect(TARGET_PER_BUCKET).toBe(100);
    expect(TARGET_TOTAL).toBe(400);
  });

  it('the scan ceiling is on rows EXAMINED (§3, §28.1 §4)', () => {
    expect(MAX_DISCOVERY_ROWS_PER_BUCKET).toBe(5000);
  });
});

describe('positionClass (§8)', () => {
  it('is FULL when every player has a real position', () => {
    expect(positionClass(roster())).toBe(POSITION_CLASS.FULL);
  });

  it('is NONE when no player has one', () => {
    expect(positionClass(roster().map((x) => ({ ...x, position: null })))).toBe(POSITION_CLASS.NONE);
  });

  it('is PARTIAL for mixed coverage', () => {
    const p = roster();
    p[0].position = null;
    expect(positionClass(p)).toBe(POSITION_CLASS.PARTIAL);
  });

  it('does not treat garbage as a position (§7)', () => {
    expect(positionClass(roster().map((x) => ({ ...x, position: 'garbage_3' })))).toBe(POSITION_CLASS.NONE);
  });
});

describe('dedupeItemPresence (§13)', () => {
  it('collapses duplicates into one presence with a copy count', () => {
    expect(dedupeItemPresence([50, 116, 50])).toEqual([{ itemId: 50, copyCount: 2 }, { itemId: 116, copyCount: 1 }]);
  });

  it('keeps three physical copies as ONE observation', () => {
    expect(dedupeItemPresence([7, 7, 7])).toHaveLength(1);
  });

  it('drops null/undefined and handles empty', () => {
    expect(dedupeItemPresence([1, null, undefined])).toEqual([{ itemId: 1, copyCount: 1 }]);
    expect(dedupeItemPresence([])).toEqual([]);
  });
});

describe('buildHeroEnemyRows (§9, §10)', () => {
  const players = roster();
  const { rows, failures } = buildHeroEnemyRows(ok(players), new Map([['m1', players]]));

  it('produces one row per (player, enemy)', () => {
    expect(rows).toHaveLength(50);
    expect(failures).toHaveLength(0);
  });

  it('records exactly five enemies per player (§9)', () => {
    const perPlayer = new Map();
    for (const r of rows) perPlayer.set(r.heroId, (perPlayer.get(r.heroId) ?? new Set()).add(r.enemyHeroId));
    for (const s of perPlayer.values()) expect(s.size).toBe(5);
  });

  it('excludes a null position entirely (§7)', () => {
    const p = roster();
    p[0].position = null;
    const out = buildHeroEnemyRows(ok(p), new Map([['m1', p]]));
    expect(out.rows.some((r) => r.heroId === 1)).toBe(false);
    expect(out.rows.every((r) => r.position !== null)).toBe(true);
  });

  it('rejects a roster that cannot yield 5 enemies (§9)', () => {
    const p = roster().slice(0, 4);
    const out = buildHeroEnemyRows(ok(p), new Map([['m1', p]]));
    expect(out.rows).toHaveLength(0);
    expect(out.failures.length).toBeGreaterThan(0);
  });

  it('skips a match that failed to bridge — never back-filled (§5)', () => {
    expect(buildHeroEnemyRows([{ ok: false, matchId: 'm1', reason: 'STRATZ_NOT_FOUND' }], new Map([['m1', players]])).rows).toHaveLength(0);
  });
});

describe('buildItemRows (§11, §12)', () => {
  const players = roster();
  const { rows } = buildHeroEnemyRows(ok(players), new Map([['m1', players]]));
  const inv = new Map(players.map((p) => [`m1|${p.heroId}`, {
    finalInventory: [p.item0Id, p.item1Id, p.item2Id].filter(Boolean), backpack: [7], neutral: 9,
  }]));
  const itemRows = buildItemRows(rows, inv);

  it('emits more rows than the hero-enemy layer', () => {
    expect(itemRows.length).toBeGreaterThan(rows.length);
  });

  it('uses final inventory only, never merging backpack/neutral (§12)', () => {
    const ids = new Set(itemRows.map((r) => r.itemId));
    expect(ids.has(7)).toBe(false);
    expect(ids.has(9)).toBe(false);
  });

  it('carries copyCount for duplicated items (§13)', () => {
    const dup = itemRows.filter((r) => r.copyCount > 1);
    expect(dup.length).toBeGreaterThan(0);
    expect(dup.every((r) => r.copyCount >= 2)).toBe(true);
  });

  it('handles a player with no inventory', () => {
    expect(buildItemRows(rows, new Map()).length).toBe(0);
  });
});

describe('heroes stay separate (§32 regression)', () => {
  // Three heroes, one match, one shared item: three distinct Hero x Item
  // relations, never one pooled cell.
  // A valid 5v5 where three RADIANT heroes share one item. They must stay three
  // distinct relations, never one pooled cell.
  const players = [
    { heroId: 1, position: 'POSITION_1', isRadiant: true, isVictory: true, item0Id: 50 },
    { heroId: 22, position: 'POSITION_1', isRadiant: true, isVictory: true, item0Id: 50 },
    { heroId: 13, position: 'POSITION_1', isRadiant: true, isVictory: true, item0Id: 50 },
    { heroId: 100, position: 'POSITION_2', isRadiant: true, isVictory: true, item0Id: 63 },
    { heroId: 101, position: 'POSITION_3', isRadiant: true, isVictory: true, item0Id: 63 },
    { heroId: 200, position: 'POSITION_1', isRadiant: false, isVictory: false, item0Id: 50 },
    { heroId: 201, position: 'POSITION_2', isRadiant: false, isVictory: true, item0Id: 63 },
    { heroId: 202, position: 'POSITION_3', isRadiant: false, isVictory: true, item0Id: 63 },
    { heroId: 203, position: 'POSITION_4', isRadiant: false, isVictory: false, item0Id: 63 },
    { heroId: 204, position: 'POSITION_5', isRadiant: false, isVictory: true, item0Id: 63 },
  ];
  const { rows: he } = buildHeroEnemyRows(ok(players), new Map([['m1', players]]));
  const inv = new Map(players.map((p) => [`m1|${p.heroId}`, { finalInventory: [p.item0Id] }]));
  const items = buildItemRows(he, inv);
  const cells = aggregateSupport(he, items);

  it('never merges different heroes into one cell', () => {
    for (const c of cells) expect(c.key.split('|')[0]).toBe(String(c.heroId));
  });

  it('keeps three separate Hero x Item relations for the same item', () => {
    expect(new Set(items.filter((r) => r.itemId === 50).map((r) => r.heroId)).size).toBeGreaterThanOrEqual(3);
  });

  it('records raw counts and never a rate (§14)', () => {
    for (const c of cells) {
      expect(typeof c.wins).toBe('number');
      expect(c).not.toHaveProperty('winrate');
      expect(c).not.toHaveProperty('score');
      expect(c).not.toHaveProperty('lift');
    }
  });
});

describe('A/B is a split of MATCHES (§28.2 §1)', () => {
  const ids = (n) => Array.from({ length: n }, (_, i) => ({ matchId: `m${i}` }));

  it('100 matches -> 50/50', () => {
    const { a, b, half } = splitMatchesAB(ids(100));
    expect([a.length, b.length, half]).toEqual([50, 50, 50]);
  });

  it('101 matches -> 50/51 (never a forced 50/50)', () => {
    const { a, b } = splitMatchesAB(ids(101));
    expect([a.length, b.length]).toEqual([50, 51]);
  });

  it('never splits a match, and preserves selection order', () => {
    const { a, b } = splitMatchesAB(ids(7));
    expect([...a, ...b].map((m) => m.matchId)).toEqual(ids(7).map((m) => m.matchId));
    expect(new Set([...a, ...b].map((m) => m.matchId)).size).toBe(7);
  });

  it('handles an empty and a single-match corpus', () => {
    expect(splitMatchesAB([]).n).toBe(0);
    expect(splitMatchesAB(ids(1))).toMatchObject({ n: 1, half: 0 });
  });
});

describe('compareAB works on the match grain (§28.2 §3)', () => {
  const players = roster();
  const perMatch = (id) => [`m${id}`, players.map((p) => ({ ...p }))];
  const inventory = new Map(players.map((p) => [`m0|${p.heroId}`, { finalInventory: [p.item0Id] }]));

  it('keeps buckets independent — each is halved on its own N', () => {
    const g1 = Array.from({ length: 10 }, (_, i) => ({ matchId: `g${i}`, bucket: 'herald_guardian', ok: true, rosterExact: true }));
    const g2 = Array.from({ length: 6 }, (_, i) => ({ matchId: `c${i}`, bucket: 'crusader_archon', ok: true, rosterExact: true }));
    expect(compareAB(g1, new Map(), new Map())).toMatchObject({ n: 10, aMatches: 5, bMatches: 5 });
    expect(compareAB(g2, new Map(), new Map())).toMatchObject({ n: 6, aMatches: 3, bMatches: 3 });
  });

  it('reports overlap per dimension', () => {
    const matches = Array.from({ length: 4 }, (_, i) => ({ matchId: `m${i}`, bucket: 'x', ok: true, rosterExact: true }));
    const pm = new Map(matches.flatMap((m, i) => [[`m${i}`, players]]));
    const r = compareAB(matches, pm, inventory);
    expect(r.hp).toHaveProperty('jaccard');
    expect(r.hpe).toHaveProperty('jaccard');
  });
});

describe('eligibility gates (§28.2 §5)', () => {
  const base = { ok: true, rosterExact: true, resultChecked: 10, resultMismatches: 0, itemCompared: 5, itemMismatch: 0 };

  it('a failed bridge is never tuple-eligible', () => {
    expect(isTupleEligible({ ...base, ok: false })).toBe(false);
  });

  it('a roster mismatch makes the tuple ineligible (§32)', () => {
    expect(isTupleEligible({ ...base, rosterExact: false })).toBe(false);
  });

  it('a result mismatch is excluded from result aggregates only', () => {
    const bad = { ...base, resultMismatches: 1 };
    expect(isResultClean(bad)).toBe(false);
    expect(isItemClean(bad)).toBe(true);       // items unaffected
    expect(isTupleEligible(bad)).toBe(true);    // still a valid tuple
  });

  it('an item mismatch is excluded from item aggregates only', () => {
    const bad = { ...base, itemMismatch: 2 };
    expect(isItemClean(bad)).toBe(false);
    expect(isResultClean(bad)).toBe(true);
  });

  it('an uncompared match feeds neither aggregate', () => {
    const unchecked = { ...base, resultChecked: 0, itemCompared: 0 };
    expect(isResultClean(unchecked)).toBe(false);
    expect(isItemClean(unchecked)).toBe(false);
    expect(isTupleEligible(unchecked)).toBe(true);
  });

  it('treats a missing match as ineligible', () => {
    const gates = [isTupleEligible, isResultClean, isItemClean];
    for (const f of gates) expect(f(null)).toBe(false);
    for (const f of gates) expect(f(undefined)).toBe(false);
  });
});

describe('aggregateItemCells (§15)', () => {
  const players = roster();
  const { rows } = buildHeroEnemyRows(ok(players), new Map([['m1', players]]));
  const inv = new Map(players.map((p) => [`m1|${p.heroId}`, { finalInventory: [p.item0Id] }]));
  const cells = aggregateItemCells(buildItemRows(rows, inv));

  it('keys on hero, position, enemy AND item', () => {
    for (const c of cells) expect(c.key.split('|')).toHaveLength(4);
  });

  it('computes no ranking score', () => {
    expect(Object.keys(cells[0]).sort()).toEqual([
      'enemyHeroId', 'heroId', 'itemId', 'key', 'lossesWithItem', 'matchesWithItem', 'position', 'winsWithItem',
    ]);
  });
});

describe('aggregateHeroPosition (§17)', () => {
  const players = roster();
  const { rows } = buildHeroEnemyRows(ok(players), new Map([['m1', players]]));

  it('keys on hero and position only', () => {
    for (const c of aggregateHeroPosition(rows)) expect(c.key.split('|')).toHaveLength(2);
  });

  it('counts a match once even with five enemies', () => {
    expect(aggregateHeroPosition(rows).every((c) => c.matches === 1)).toBe(true);
  });
});

describe('bucketSupport (§16)', () => {
  const cells = (counts) => counts.map((n, i) => ({ key: `c${i}`, matches: n }));

  it('places values in the declared bins', () => {
    expect(bucketSupport(cells([0, 1, 3, 7, 15, 30, 90]), SUPPORT_BINS_HE).map((x) => x.cells)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it('sums observations, not cells', () => {
    expect(bucketSupport(cells([1, 3, 7]), SUPPORT_BINS_HE).reduce((a, x) => a + x.observations, 0)).toBe(11);
  });

  it('uses the wider Hero x Position bins', () => {
    expect(SUPPORT_BINS_HP.map((b) => b.label)).toEqual(['0-4', '5-9', '10-24', '25-49', '50+']);
  });

  it('handles an empty cell set and an empty bucket (§32)', () => {
    expect(bucketSupport([], SUPPORT_BINS_HE).every((b) => b.cells === 0)).toBe(true);
    expect(aggregateSupport([], [])).toEqual([]);
    expect(splitByRank([]).size).toBe(0);
  });
});

describe('splits (§19, §20)', () => {
  const rows = [
    { bucket: 'herald_guardian', mode: 23 }, { bucket: 'herald_guardian', mode: 1 },
    { bucket: 'crusader_archon', mode: 23 },
  ];

  it('splitByRank groups by bucket', () => {
    expect(splitByRank(rows).get('herald_guardian')).toHaveLength(2);
    expect(splitByRank(rows).get('crusader_archon')).toHaveLength(1);
  });

  it('splitByMode groups by mode', () => {
    expect(splitByMode(rows).get('23')).toHaveLength(2);
  });

  it('files a missing key as unknown rather than dropping it', () => {
    expect(splitByRank([{ matchId: 1 }]).get('unknown')).toHaveLength(1);
  });
});

describe('ontologyIntersection (§18)', () => {
  const positions = { 1: { positions: { 1: { games: 100 }, 5: { games: 0 } } }, 2: { positions: {} } };

  it('separates known from unknown cells', () => {
    const r = ontologyIntersection([{ key: '1|1', heroId: 1, position: 1 }, { key: '2|2', heroId: 2, position: 2 }], positions);
    expect(r.known).toBe(1);
    expect(r.unknown).toBe(1);
  });

  it('treats a zero-game position as unsupported', () => {
    expect(ontologyIntersection([{ key: '1|5', heroId: 1, position: 5 }], positions).unknown).toBe(1);
  });

  it('is read-only: it never mutates production eligibility', () => {
    ontologyIntersection([{ key: '1|1', heroId: 1, position: 1 }], positions);
    expect(positions[1].positions['1'].games).toBe(100);
  });

  it('handles a missing ontology without throwing', () => {
    expect(ontologyIntersection([{ key: '9|9', heroId: 9, position: 9 }], null).unknown).toBe(1);
  });
});

describe('cellOverlap and supportSummary (§26)', () => {
  it('counts shared cells', () => {
    expect(cellOverlap([{ key: 'a' }, { key: 'b' }], [{ key: 'b' }, { key: 'c' }])).toMatchObject({ a: 2, b: 2, shared: 1 });
  });

  it('returns a null jaccard for two empty halves', () => {
    expect(cellOverlap([], []).jaccard).toBeNull();
  });

  it('summarises support without a rate', () => {
    expect(supportSummary([{ matches: 12 }, { matches: 3 }], 10)).toEqual({ floor: 10, cellsKept: 1, cellsTotal: 2, observations: 12 });
  });
});