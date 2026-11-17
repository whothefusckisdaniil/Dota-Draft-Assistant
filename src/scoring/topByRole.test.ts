import { describe, expect, it } from 'vitest';
import heroesRaw from '../../public/data/heroes.json';
// Optional layer: the snapshot may ship without it (then the check is skipped,
// never failing the daily refresh).
const roleStatsFiles = import.meta.glob('../../public/data/role-stats.json', { eager: true, import: 'default' });
import { topHeroesForPosition } from './topByRole';
import type { Hero } from '../types';
import type { RoleStats } from '../data/dataset';

const hero = (id: number) => ({ id, name: `H${id}` }) as Hero;
const HEROES = [1, 2, 3, 4].map(hero);
const cells = (pos5: [number, number], other = 0): [number, number][] => [[other, other / 2], [0, 0], [0, 0], [0, 0], pos5];

describe('top heroes for a position', () => {
  const stats: RoleStats = {
    ALL: {
      1: cells([10000, 5400]), // 54%, real support
      2: cells([2000, 1100]), // 55% raw, but a small sample: shrunk below hero 1
      3: cells([20000, 10600], 200000), // 53% at pos 5 but 91% of its games are carry
      4: cells([1000, 700]), // too few games
    },
  };

  it('keeps only heroes really played there and ranks by shrunk win rate', () => {
    const top = topHeroesForPosition(stats, HEROES, 'ALL', 5);
    expect(top.map((t) => t.hero.id)).toEqual([1, 2]);
    expect(top[0].winrate).toBeCloseTo(54);
    expect(top[0].laneShare).toBe(1);
  });

  it('falls back to all ranks when a rank is missing', () => {
    expect(topHeroesForPosition(stats, HEROES, 'DIVINE_IMMORTAL', 5).map((t) => t.hero.id)).toEqual([1, 2]);
  });

  it('works on the committed snapshot for every rank (supports present)', () => {
    const real = Object.values(roleStatsFiles)[0] as RoleStats | undefined;
    if (!real) return;
    const heroes = heroesRaw as unknown as Hero[];
    for (const rank of Object.keys(real)) {
      for (const pos of [4, 5] as const) {
        const top = topHeroesForPosition(real, heroes, rank, pos);
        expect(top.length, `${rank} pos ${pos}`).toBeGreaterThanOrEqual(5);
        for (const t of top) expect(t.winrate).toBeGreaterThan(40);
      }
    }
  });
});
