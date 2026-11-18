import { describe, expect, it } from 'vitest';
import { winChance } from './winChance';
import type { MatchupRow } from '../types';

const team = [1, 2, 3, 4, 5];
const enemies = [6, 7, 8, 9, 10];
const even = (ids: number[]) => new Map(ids.map((id) => [id, ids.filter((x) => x !== id).map((h): MatchupRow => ({ hero_id: h, games_played: 10000, wins: 5000 }))]));
const all = [...team, ...enemies];
const base = new Map(all.map((id) => [id, 50]));

describe('winChance', () => {
  it('is 50% for an even draft and symmetric', () => {
    const r = winChance({ team, enemies, matchupByEnemy: even(all), synergyByHero: even(all), baseWinrates: base });
    expect(r.chance).toBeCloseTo(0.5, 6);
  });

  it('favours the stronger heroes and the counters, and flips when sides swap', () => {
    const strong = new Map(base);
    strong.set(1, 53);
    const mu = even(all);
    // enemy 6 loses to hero 2: rows of 6 store 6's wins vs 2
    mu.set(6, mu.get(6)!.map((r) => (r.hero_id === 2 ? { ...r, wins: 4400 } : r)));
    const a = winChance({ team, enemies, matchupByEnemy: mu, synergyByHero: even(all), baseWinrates: strong });
    const b = winChance({ team: enemies, enemies: team, matchupByEnemy: mu, synergyByHero: even(all), baseWinrates: strong });
    expect(a.heroes).toBeCloseTo(3);
    // hero 1's matchups are exactly what its higher base predicts away: −3 × 5, then +6 vs enemy 6
    expect(a.counters).toBeCloseTo(-15 * (10000 / 10060) + 6 * (10000 / 10060), 3);
    const c = winChance({ team, enemies, matchupByEnemy: mu, synergyByHero: even(all), baseWinrates: base });
    expect(c.counters).toBeGreaterThan(5);
    expect(c.chance).toBeGreaterThan(0.54);
    expect(c.chance).toBeLessThan(0.75);
    expect(c.bestCounter).toMatchObject({ a: 2, b: 6 });
    expect(b.heroes).toBeCloseTo(-3);
  });

  it('works without a synergy layer', () => {
    const r = winChance({ team, enemies, matchupByEnemy: even(all), synergyByHero: null, baseWinrates: base });
    expect(r.synergy).toBe(0);
  });
});
