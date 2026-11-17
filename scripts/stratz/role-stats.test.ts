import { describe, expect, it } from 'vitest';
import { buildRoleStatsQuery, finalizeRoleStats, validateRoleStats } from './role-stats.mjs';

const BRACKETS = ['HERALD_GUARDIAN', 'CRUSADER_ARCHON', 'LEGEND_ANCIENT', 'DIVINE_IMMORTAL'];
const HEROES = [1, 2, 3, 4, 5].map((id) => ({ id }));

/** Hero N plays position N only: every position gets the same games, 50% wins. */
function raw(games = 2000) {
  return Object.fromEntries(BRACKETS.map((b) => [b, Object.fromEntries(HEROES.map((h) => [h.id, [0, 1, 2, 3, 4].map((p) => (p === h.id - 1 ? [games, games / 2] : [0, 0]))]))]));
}

describe('role stats (per-position win rates by rank)', () => {
  it('asks for every bracket in one request per bucket, with win counts', () => {
    const q = buildRoleStatsQuery([1, 2], 100);
    for (const b of BRACKETS) expect(q).toContain(`${b}: stats(`);
    expect(q).toContain('winCount');
    expect(q).toContain('groupByPosition: true');
  });

  it('adds ALL as the sum of the brackets and fills missing heroes with zeros', () => {
    const r = raw();
    delete (r.HERALD_GUARDIAN as Record<string, unknown>)['3'];
    const st = finalizeRoleStats(r, HEROES);
    expect(st.HERALD_GUARDIAN[3]).toEqual([[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]);
    expect(st.ALL[1][0]).toEqual([8000, 4000]);
    expect(st.ALL[3][2]).toEqual([6000, 3000]);
  });

  it('passes a balanced population and rejects a broken one', () => {
    expect(() => validateRoleStats(finalizeRoleStats(raw(), HEROES), HEROES)).not.toThrow();
    const skewed = raw();
    for (const b of BRACKETS) (skewed as Record<string, Record<string, number[][]>>)[b]['5'][4] = [9000, 4500];
    expect(() => validateRoleStats(finalizeRoleStats(skewed, HEROES), HEROES)).toThrow(/position 5 has/);
    const wins = raw();
    for (const b of BRACKETS) (wins as Record<string, Record<string, number[][]>>)[b]['2'][1] = [2000, 1500];
    expect(() => validateRoleStats(finalizeRoleStats(wins, HEROES), HEROES)).toThrow(/win rate/);
  });

  it('keeps the rest of the snapshot when the role-stats fetch fails', async () => {
    const { buildDataset } = await import('../update-data-stratz.mjs');
    const ids = Array.from({ length: 100 }, (_, i) => i + 1);
    const heroes = ids.map((id) => ({ id, name: `Hero ${id}`, key: `npc_dota_hero_h${id}`, roles: ['Carry'], img: 'x', pubPick: 1 }));
    const table = () => Object.fromEntries(ids.map((i) => [String(i), ids.filter((j) => j !== i).map((j) => ({ hero_id: j, games_played: 1000, wins: 500 }))]));
    const positions = Object.fromEntries(ids.map((i) => [String(i), { totalGames: 5000, positions: Object.fromEntries(['1', '2', '3', '4', '5'].map((p) => [p, { games: 1000, share: 0.2 }])) }]));
    const result = await buildDataset({
      fetchMetadata: async () => ({ heroes, latestPatch: '7.42', heroCount: 100 }),
      fetchMatchups: async () => table(),
      fetchPositions: async () => positions,
      fetchRoleStats: async () => { throw new Error('STRATZ HTTP 500'); },
      now: new Date('2026-09-28T12:00:00Z'),
      log: () => {},
    });
    expect(result.roleStats).toBeNull();
    expect(result.meta.roleStats).toBeNull();
  });
});
