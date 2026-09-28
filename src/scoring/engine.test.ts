import { describe, expect, it } from 'vitest';
import type { Hero, MatchupRow, PositionDataset } from '../types';
import { scoreCandidates, type ScoreInput } from './engine';

function hero(id: number, name: string, roles: string[]): Hero {
  return {
    id, key: `npc_dota_hero_${name.toLowerCase().replace(/\s+/g, '_')}`, name,
    primaryAttr: 'agi', attackType: 'Melee', roles, img: '', icon: '',
    proPick: 0, proWin: 0, pubPick: 0, pubWin: 0, nameRu: '',
  };
}

// rows from the ENEMY perspective: wins = enemy wins vs candidate
function rows(pairs: [candidateId: number, games: number, enemyWins: number][]): MatchupRow[] {
  return pairs.map(([hero_id, games_played, wins]) => ({ hero_id, games_played, wins }));
}

const carry = (id: number, name: string) => hero(id, name, ['Carry', 'Escape']);
const support = (id: number, name: string) => hero(id, name, ['Support', 'Disabler', 'Nuker']);

/**
 * Synthetic position data where every listed hero is eligible on every lane.
 * These tests are about the matchup/shrinkage math, so eligibility must not be
 * a second moving part — the gate itself is covered in positionEligibility.test.ts.
 */
function allLanesEligible(heroIds: number[]): PositionDataset {
  const out: PositionDataset = {};
  for (const id of heroIds) {
    const games = 1000;
    out[id] = {
      totalGames: games * 5,
      positions: {
        '1': { games, share: 0.2 }, '2': { games, share: 0.2 }, '3': { games, share: 0.2 },
        '4': { games, share: 0.2 }, '5': { games, share: 0.2 },
      },
    };
  }
  return out;
}

function input(partial: Partial<ScoreInput>): ScoreInput {
  const heroes: Hero[] = partial.heroes ?? [];
  return {
    heroes,
    enemyIds: partial.enemyIds ?? [],
    matchupByEnemy: partial.matchupByEnemy ?? new Map(),
    heroById: partial.heroById ?? new Map(heroes.map((h) => [h.id, h])),
    positions: partial.positions ?? allLanesEligible(heroes.map((h) => h.id)),
  };
}

const ENEMIES = [hero(13, 'Puck', ['Nuker']), hero(29, 'Tidehunter', ['Initiator', 'Durable'])];

describe('scoreCandidates', () => {
  it('scores a single enemy (1-enemy case)', () => {
    const slark = carry(93, 'Slark');
    const inpt = input({
      heroes: [slark, ...ENEMIES],
      enemyIds: [13],
      matchupByEnemy: new Map([[13, rows([[93, 300, 120]])]]), // slark wins 180/300 = 60%
    });
    const res = scoreCandidates(inpt, '1');
    expect(res).toHaveLength(1);
    expect(res[0].hero.name).toBe('Slark');
    expect(res[0].teamScore).toBeGreaterThan(0);
    expect(res[0].matchups).toHaveLength(1);
  });

  it('requires usable data vs ALL 5 enemies (strict coverage)', () => {
    const slark = carry(93, 'Slark');
    const enemies = [13, 29, 8, 18, 26].map((id) => hero(id, `E${id}`, ['Carry']));
    const byEnemy = new Map<number, MatchupRow[]>();
    // slark strong vs Puck only, missing everywhere else
    byEnemy.set(13, rows([[93, 300, 100]]));
    for (const id of [29, 8, 18, 26]) byEnemy.set(id, rows([]));
    const res = scoreCandidates(
      input({ heroes: [slark, ...enemies], enemyIds: [13, 29, 8, 18, 26], matchupByEnemy: byEnemy }),
      '1',
    );
    expect(res).toHaveLength(0);
  });

  it('caps the ranking at topN = 15, sorted descending (Top-15 contract)', () => {
    // 16 fully-usable carry candidates vs one enemy, strictly decreasing scores:
    // candidate i wins (1000 - (380 + i*10)) / 1000 → 62%, 61%, … 47%.
    const candidates = Array.from({ length: 16 }, (_, i) => carry(100 + i, `Cand${i}`));
    const enemy = hero(13, 'Puck', ['Nuker']);
    const byEnemy = new Map<number, MatchupRow[]>([
      [13, rows(candidates.map((h, i) => [h.id, 1000, 380 + i * 10]))],
    ]);
    const res = scoreCandidates(
      input({ heroes: [...candidates, enemy], enemyIds: [13], matchupByEnemy: byEnemy }),
      '1',
    );
    // contract: APP_CONFIG.scoring.topN === 15
    expect(res).toHaveLength(15);
    for (let i = 1; i < res.length; i += 1) {
      expect(res[i - 1].finalScore).toBeGreaterThanOrEqual(res[i].finalScore);
    }
    // the worst of the 16 (Cand15, 47% WR) must not make the cut,
    // the best (Cand0, 62% WR) must lead
    expect(res.some((c) => c.hero.id === 115)).toBe(false);
    expect(res[0].hero.id).toBe(100);
  });

  it('hides candidates with a thin pair sample (< minMatchesPerPair)', () => {
    const slark = carry(93, 'Slark');
    const inpt = input({
      heroes: [slark, ...ENEMIES],
      enemyIds: [13, 29],
      matchupByEnemy: new Map([
        [13, rows([[93, 300, 100]])],
        [29, rows([[93, 5, 0]])]]), // 5 games -> not usable -> coverage fails
    });
    expect(scoreCandidates(inpt, '1')).toHaveLength(0);
  });

  it('returns nothing when an enemy matchup table failed to load', () => {
    const slark = carry(93, 'Slark');
    const inpt = input({
      heroes: [slark, ...ENEMIES],
      enemyIds: [13, 29],
      matchupByEnemy: new Map([[13, rows([[93, 300, 100]])]]),
      failedEnemyIds: [29],
    });
    expect(scoreCandidates(inpt, '1')).toHaveLength(0);
  });

  it('prefers the stable-against-all hero over the spiky one', () => {
    const steady = carry(93, 'Slark');
    const spiky = carry(54, 'Lifestealer');
    const inpt = input({
      heroes: [steady, spiky, ...ENEMIES],
      enemyIds: [13, 29],
      matchupByEnemy: new Map([
        // steady: +8pp vs both (300 games each)
        [13, rows([[93, 300, 126], [54, 300, 60]])],
        [29, rows([[93, 300, 126], [54, 300, 210]])],
      ]),
    });
    const res = scoreCandidates(inpt, '1');
    expect(res[0].hero.name).toBe('Slark');
  });

  it('never recommends an enemy hero against itself', () => {
    const puckAsCandidate = carry(13, 'Puck');
    const inpt = input({
      heroes: [puckAsCandidate, ...ENEMIES],
      enemyIds: [13],
      matchupByEnemy: new Map([[13, rows([[13, 300, 150]])]]),
    });
    expect(scoreCandidates(inpt, '1')).toHaveLength(0);
  });

  it('filters by ROLE DATA: a hero that never plays the lane is excluded', () => {
    // The gate is empirical (ТЗ №9), not role-tag based: the same helper
    // `allLanesEligible` would let Crystal Maiden through as a carry. What
    // decides it here is the fixture — nobody plays her there.
    const cm = support(5, 'Crystal Maiden');
    const slark = carry(93, 'Slark');
    const byEnemy = new Map([[13, rows([[5, 300, 100], [93, 300, 100]])]]);

    // Realistic data: Crystal Maiden 0.1% carry, Slark 62% carry.
    const positions: PositionDataset = {
      5: {
        totalGames: 100_000,
        positions: {
          '1': { games: 100, share: 0.001 }, '2': { games: 4000, share: 0.04 },
          '3': { games: 3000, share: 0.03 }, '4': { games: 20000, share: 0.2 },
          '5': { games: 74000, share: 0.739 },
        },
      },
      93: {
        totalGames: 100_000,
        positions: {
          '1': { games: 62000, share: 0.62 }, '2': { games: 20000, share: 0.2 },
          '3': { games: 10000, share: 0.1 }, '4': { games: 6000, share: 0.06 },
          '5': { games: 2000, share: 0.02 },
        },
      },
    };
    const inpt = input({ heroes: [cm, slark, ...ENEMIES], enemyIds: [13], matchupByEnemy: byEnemy, positions });

    const carries = scoreCandidates(inpt, '1').map((c) => c.hero.name);
    expect(carries).toContain('Slark');
    // Identical matchup numbers, identical role tags — the only difference is
    // that nobody actually picks Crystal Maiden as a carry.
    expect(carries).not.toContain('Crystal Maiden');
    const sup5 = scoreCandidates(inpt, '5').map((c) => c.hero.name);
    expect(sup5).toContain('Crystal Maiden');
  });

  it('ignores zero-game rows', () => {
    const slark = carry(93, 'Slark');
    const inpt = input({
      heroes: [slark, ...ENEMIES],
      enemyIds: [13],
      matchupByEnemy: new Map([[13, rows([[93, 0, 0]])]]),
    });
    expect(scoreCandidates(inpt, '1')).toHaveLength(0);
  });
});
