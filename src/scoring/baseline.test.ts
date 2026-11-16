import { describe, expect, it } from 'vitest';
import heroesRaw from '../../public/data/heroes.json';
import matchupsRaw from '../../public/data/matchups.json';
import type { Hero, MatchupRow, PositionDataset } from '../types';
import { computeBaseWinrates, expectedWinrate } from './baseline';
import { scoreCandidates } from './engine';

function hero(id: number, name: string): Hero {
  return {
    id, key: `npc_dota_hero_${name.toLowerCase().replace(/\s+/g, '_')}`, name,
    primaryAttr: 'agi', attackType: 'Melee', roles: ['Carry'], img: '', icon: '',
    proPick: 0, proWin: 0, pubPick: 0, pubWin: 0, nameRu: '',
  };
}
function allLanes(ids: number[]): PositionDataset {
  const out: PositionDataset = {};
  for (const id of ids) {
    out[id] = { totalGames: 5000, positions: { '1': { games: 1000, share: 0.2 }, '2': { games: 1000, share: 0.2 }, '3': { games: 1000, share: 0.2 }, '4': { games: 1000, share: 0.2 }, '5': { games: 1000, share: 0.2 } } };
  }
  return out;
}
/** Enemy-perspective row: `enemyWins` = wins of the table's key hero against `hero_id`. */
const row = (hero_id: number, games_played: number, enemyWins: number): MatchupRow => ({ hero_id, games_played, wins: enemyWins });

describe('computeBaseWinrates', () => {
  it('is each hero\'s win rate over every row it appears in (rows store enemy wins)', () => {
    const tables = new Map<number, MatchupRow[]>([
      [1, [row(2, 100, 40), row(3, 100, 50)]], // hero 2 wins 60/100, hero 3 wins 50/100 vs hero 1
      [2, [row(1, 100, 60), row(3, 300, 150)]], // hero 1 wins 40/100, hero 3 wins 150/300 vs hero 2
    ]);
    const base = computeBaseWinrates(tables);
    expect(base.get(1)).toBeCloseTo(40, 10);
    expect(base.get(2)).toBeCloseTo(60, 10);
    expect(base.get(3)).toBeCloseTo((50 + 150) / 4, 10);
  });

  it('ignores zero-game rows', () => {
    expect(computeBaseWinrates(new Map([[1, [row(2, 0, 0)]]])).has(2)).toBe(false);
  });
});

describe('expectedWinrate', () => {
  it('is base(candidate) − (base(enemy) − 50)', () => {
    const base = new Map([[1, 55], [2, 47]]);
    expect(expectedWinrate(base, 1, 2)).toBeCloseTo(58, 10);
    expect(expectedWinrate(base, 2, 1)).toBeCloseTo(42, 10);
  });
  it('falls back to a neutral 50% for unknown heroes', () => {
    expect(expectedWinrate(new Map(), 1, 2)).toBe(50);
    expect(expectedWinrate(undefined, 1, 2)).toBe(50);
  });
});

describe('scoreCandidates — ranking by matchup advantage', () => {
  // Enemy 10 (base 50). Candidate 1 is strong in general (base 56) and wins 57%
  // against the enemy; candidate 2 is weak in general (base 44) but wins 52%.
  const heroes = [hero(1, 'Strong'), hero(2, 'Specialist'), hero(10, 'Enemy')];
  const heroById = new Map(heroes.map((h) => [h.id, h]));
  const matchupByEnemy = new Map<number, MatchupRow[]>([[10, [row(1, 4000, 4000 - 2280), row(2, 4000, 4000 - 2080)]]]);
  const positions = allLanes([1, 2, 10]);
  const baseWinrates = new Map([[1, 56], [2, 44], [10, 50]]);
  const input = { heroes, enemyIds: [10], matchupByEnemy, heroById, positions };

  it('a counter specialist outranks a hero that is merely strong in general', () => {
    const ranked = scoreCandidates({ ...input, baseWinrates }, '1');
    expect(ranked.map((c) => c.hero.name)).toEqual(['Specialist', 'Strong']);
    const [spec, strong] = ranked;
    expect(spec.matchups[0].rawDelta).toBeCloseTo(52 - 44, 10); // +8 advantage
    expect(strong.matchups[0].rawDelta).toBeCloseTo(57 - 56, 10); // +1 advantage
    expect(spec.matchups[0].expectedWinrate).toBeCloseTo(44, 10);
    expect(spec.matchups[0].winrate).toBeCloseTo(52, 10); // raw win rate is still reported
  });

  it('the enemy\'s own strength is accounted for as well', () => {
    const tough = new Map([[1, 56], [2, 44], [10, 54]]); // a strong enemy lowers every expectation by 4
    const [spec] = scoreCandidates({ ...input, baseWinrates: tough }, '1');
    expect(spec.matchups[0].expectedWinrate).toBeCloseTo(40, 10);
    expect(spec.matchups[0].rawDelta).toBeCloseTo(12, 10);
  });

  it('without baselines the engine keeps the neutral 50% reference (lab presets)', () => {
    const ranked = scoreCandidates(input, '1');
    expect(ranked.map((c) => c.hero.name)).toEqual(['Strong', 'Specialist']);
    expect(ranked[0].matchups[0].expectedWinrate).toBe(50);
    expect(ranked[0].matchups[0].rawDelta).toBeCloseTo(7, 10);
  });

  it('shrinkage applies to the advantage', () => {
    const [spec] = scoreCandidates({ ...input, baseWinrates }, '1');
    expect(spec.matchups[0].delta).toBeCloseTo((8 * 4000) / (4000 + 60), 10);
  });
});

describe('the committed snapshot', () => {
  const heroes = heroesRaw as unknown as Hero[];
  const raw = matchupsRaw as unknown as Record<string, MatchupRow[]>;
  const matchups = new Map(Object.entries(raw).map(([k, v]) => [Number(k), v]));
  const base = computeBaseWinrates(matchups);

  it('has a baseline for every hero, within a sane band, averaging 50% by games', () => {
    expect(base.size).toBe(heroes.length);
    for (const h of heroes) expect(base.get(h.id), h.name).toBeGreaterThan(35);
    for (const h of heroes) expect(base.get(h.id), h.name).toBeLessThan(65);
    let games = 0;
    let weighted = 0;
    for (const rows of matchups.values()) for (const r of rows) { games += r.games_played; weighted += r.games_played * (base.get(r.hero_id) ?? 0); }
    expect(weighted / games).toBeGreaterThan(49);
    expect(weighted / games).toBeLessThan(51);
  });

  it('advantage removes general hero strength: it averages ~0 where raw win rate does not', () => {
    // Data-independent invariants (the snapshot refreshes daily). Over every
    // row, the game-weighted mean advantage is ~0 by construction, while the
    // strongest hero's raw win rate is above 50 against most opponents.
    let games = 0;
    let weightedAdv = 0;
    for (const [enemy, rows] of matchups) {
      for (const r of rows) {
        const wr = (100 * (r.games_played - r.wins)) / r.games_played;
        games += r.games_played;
        weightedAdv += r.games_played * (wr - expectedWinrate(base, r.hero_id, enemy));
      }
    }
    expect(Math.abs(weightedAdv / games)).toBeLessThan(0.5);

    const strongest = [...base.entries()].sort((a, b) => b[1] - a[1])[0][0];
    let rawAbove = 0;
    let advAbove = 0;
    let n = 0;
    for (const [enemy, rows] of matchups) {
      const r = rows.find((x) => x.hero_id === strongest);
      if (!r) continue;
      const wr = (100 * (r.games_played - r.wins)) / r.games_played;
      n += 1;
      if (wr > 50) rawAbove += 1;
      if (wr - expectedWinrate(base, strongest, enemy) > 0) advAbove += 1;
    }
    expect(rawAbove / n).toBeGreaterThan(0.7); // raw WR calls it a "counter" to most heroes
    expect(advAbove / n).toBeLessThan(rawAbove / n); // the advantage does not
  });
});
