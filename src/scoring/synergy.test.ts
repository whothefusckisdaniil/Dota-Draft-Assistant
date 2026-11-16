import { describe, expect, it } from 'vitest';
import type { Hero, MatchupRow, PositionDataset } from '../types';
import { scoreCandidates } from './engine';
import { suggestBans } from './bans';
import { expectedSynergyWinrate } from './baseline';

function hero(id: number, name: string): Hero {
  return {
    id, key: `npc_dota_hero_${name.toLowerCase()}`, name,
    primaryAttr: 'agi', attackType: 'Melee', roles: ['Carry'], img: '', icon: '',
    proPick: 0, proWin: 0, pubPick: 0, pubWin: 0, nameRu: '',
  };
}
const allLanes = (ids: number[]): PositionDataset => Object.fromEntries(ids.map((id) => [id, {
  totalGames: 5000,
  positions: Object.fromEntries(['1', '2', '3', '4', '5'].map((p) => [p, { games: 1000, share: 0.2 }])),
}])) as unknown as PositionDataset;
/** Enemy-perspective matchup row: `enemyWins` = wins of the table's key hero. */
const vs = (hero_id: number, games: number, enemyWins: number): MatchupRow => ({ hero_id, games_played: games, wins: enemyWins });
/** Same-team row: `teamWins` = wins of the pair. */
const withRow = (hero_id: number, games: number, teamWins: number): MatchupRow => ({ hero_id, games_played: games, wins: teamWins });

// Enemy 10, ally 20. Candidates 1 and 2 counter the enemy equally (52%);
// candidate 2 fits the ally (55% together), candidate 1 does not (45%).
const heroes = [hero(1, 'One'), hero(2, 'Two'), hero(3, 'Three'), hero(10, 'Enemy'), hero(20, 'Ally')];
const heroById = new Map(heroes.map((h) => [h.id, h]));
const ids = heroes.map((h) => h.id);
const positions = allLanes(ids);
const base = new Map(ids.map((id) => [id, 50]));
const matchups = new Map<number, MatchupRow[]>([
  [10, [vs(1, 4000, 1920), vs(2, 4000, 1920), vs(3, 4000, 2000), vs(20, 4000, 2000)]],
  [20, [vs(1, 4000, 2000), vs(2, 4000, 2000), vs(3, 4000, 1600), vs(10, 4000, 2000)]], // hero 3 beats the ally 60%
]);
const synergy = new Map<number, MatchupRow[]>([
  [20, [withRow(1, 4000, 1800), withRow(2, 4000, 2200), withRow(3, 4000, 2000), withRow(10, 4000, 2000)]],
  [10, [withRow(1, 4000, 2000), withRow(2, 4000, 2000), withRow(3, 4000, 2280), withRow(20, 4000, 2000)]], // hero 3 fits the enemy
]);
const input = { heroes, enemyIds: [10], matchupByEnemy: matchups, heroById, positions, baseWinrates: base };

describe('scoreCandidates — allies (synergy)', () => {
  it('without allies the ranking is exactly the counterpick ranking', () => {
    const a = scoreCandidates(input, '1');
    const b = scoreCandidates({ ...input, allyIds: [], synergyByAlly: synergy }, '1');
    expect(b.map((c) => [c.hero.id, c.finalScore])).toEqual(a.map((c) => [c.hero.id, c.finalScore]));
    expect(a[0].synergy).toEqual([]);
    expect(a[0].draftScore).toBeCloseTo(a[0].teamScoreM!, 10);
  });

  it('a hero that fits your team outranks an equal counter that does not', () => {
    const ranked = scoreCandidates({ ...input, allyIds: [20], synergyByAlly: synergy }, '1');
    const order = ranked.map((c) => c.hero.name);
    expect(order.indexOf('Two')).toBeLessThan(order.indexOf('One'));
    const two = ranked.find((c) => c.hero.name === 'Two')!;
    expect(two.synergy[0].allyId).toBe(20);
    expect(two.synergy[0].winrate).toBeCloseTo(55, 9);
    expect(two.synergy[0].expectedWinrate).toBeCloseTo(50, 9);
    expect(two.synergyScore).toBeCloseTo((5 * 4000) / 4060, 6);
    expect(two.draftScore).toBeCloseTo(two.teamScoreM! + 0.5 * two.synergyScore, 10);
  });

  it('allies are never recommended, bans are excluded', () => {
    const ranked = scoreCandidates({ ...input, allyIds: [20], synergyByAlly: synergy, excludeIds: [2] }, '1');
    expect(ranked.map((c) => c.hero.id)).not.toContain(20);
    expect(ranked.map((c) => c.hero.id)).not.toContain(2);
  });

  it('allies only (no enemies) ranks by synergy', () => {
    const ranked = scoreCandidates({ ...input, enemyIds: [], allyIds: [20], synergyByAlly: synergy }, '1');
    expect(ranked[0].hero.name).toBe('Two');
    expect(ranked[0].matchups).toEqual([]);
  });

  it('allies without synergy data: allies are only excluded, nothing else changes', () => {
    const ranked = scoreCandidates({ ...input, allyIds: [20], synergyByAlly: null }, '1');
    expect(ranked.map((c) => c.hero.id)).not.toContain(20);
    expect(ranked.every((c) => c.synergy.length === 0)).toBe(true);
  });

  it('expected team win rate adds both heroes’ edges', () => {
    expect(expectedSynergyWinrate(new Map([[1, 53], [2, 48]]), 1, 2)).toBeCloseTo(51, 10);
    expect(expectedSynergyWinrate(undefined, 1, 2)).toBe(50);
  });
});

describe('suggestBans', () => {
  const banInput = { heroes, allyIds: [20], enemyIds: [10], excludeIds: [], matchupByHero: matchups, synergyByHero: synergy, baseWinrates: base };

  it('suggests the hero that beats your team and fits theirs', () => {
    const bans = suggestBans(banInput);
    expect(bans[0].hero.name).toBe('Three');
    expect(bans[0].threats[0]).toMatchObject({ allyId: 20 });
    expect(bans[0].threats[0].delta).toBeCloseTo((10 * 4000) / 4060, 6);
    expect(bans[0].fits[0].delta).toBeCloseTo((7 * 4000) / 4060, 6);
    expect(bans[0].score).toBeCloseTo(bans[0].threats[0].delta + 0.5 * bans[0].fits[0].delta, 10);
  });

  it('never suggests picked or banned heroes', () => {
    const bans = suggestBans({ ...banInput, excludeIds: [3] });
    const banned = bans.map((b) => b.hero.id);
    for (const id of [3, 10, 20]) expect(banned).not.toContain(id);
  });

  it('works with only enemies (fit) or only allies (threat), not with neither', () => {
    expect(suggestBans({ ...banInput, allyIds: [] })[0].hero.name).toBe('Three');
    expect(suggestBans({ ...banInput, enemyIds: [] })[0].hero.name).toBe('Three');
    expect(suggestBans({ ...banInput, allyIds: [], enemyIds: [] })).toEqual([]);
    expect(suggestBans({ ...banInput, allyIds: [], synergyByHero: null })).toEqual([]);
  });
});
