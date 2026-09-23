import { describe, expect, it } from 'vitest';
import type { Hero, MatchupRow } from '../types';
import { scoreCandidates } from './engine';
import type { Lane } from './positionsExtra';
import { confidenceOf, positionBonusOf, replay, sampleWeight, shrunkDelta, type PlayRow } from './replay';

describe('replay (playground math = engine math)', () => {
  it('answers: 55%/100g vs 53%/10000g — big sample wins', () => {
    const a = replay([{ id: 'a', enemy: 'Puck', games: 100, wr: 55 }], 7);
    const b = replay([{ id: 'b', enemy: 'Puck', games: 10000, wr: 53 }], 7);
    // raw: +5 vs +3; shrunk: +3.13 vs +2.98; conf: 0.5 vs 1.0
    expect(a.steps[0].raw).toBeCloseTo(5, 5);
    expect(a.steps[0].shrunk).toBeCloseTo(3.125, 3);
    expect(a.confidence).toBeCloseTo(0.5, 5);
    expect(b.steps[0].shrunk).toBeCloseTo(2.982, 2);
    expect(b.confidence).toBe(1);
    // raw: +5 vs +3; shrunk: +3.125 vs +2.982; conf: 0.5 vs 1.0
    // posScore 7 -> bonus +1.6; raw = team*0.8 + 1.6*0.2
    // final A = 2.82*0.65 = 1.833; final B = 2.7056*1.0 = 2.706
    expect(a.teamScore).toBeCloseTo(3.125, 3);
    expect(b.teamScore).toBeCloseTo(2.982, 2);
    expect(a.finalScore).toBeCloseTo(1.833, 2);
    expect(b.finalScore).toBeCloseTo(2.706, 2);
    expect(b.finalScore).toBeGreaterThan(a.finalScore);
  });

  it('pins: spiky 60/60/40 vs stable 53/53/53 — spiky wins, no variance penalty', () => {
    const spiky = replay(
      [
        { id: 'a1', enemy: 'Puck', games: 300, wr: 60 },
        { id: 'a2', enemy: 'Tide', games: 300, wr: 60 },
        { id: 'a3', enemy: 'Jugg', games: 300, wr: 40 },
      ],
      7,
    );
    const stable = replay(
      [
        { id: 'b1', enemy: 'Puck', games: 300, wr: 53 },
        { id: 'b2', enemy: 'Tide', games: 300, wr: 53 },
        { id: 'b3', enemy: 'Jugg', games: 300, wr: 53 },
      ],
      7,
    );
    // spiky team = (8.333+8.333-8.333)/3 = +2.778; stable = +2.500
    expect(spiky.teamScore).toBeCloseTo(2.778, 2);
    expect(stable.teamScore).toBeCloseTo(2.5, 2);
    // Equal games -> weights and confidence cancel; the higher weighted mean wins.
    // The model does NOT punish variance beyond the mean — there is no variance term.
    // Pinned outputs (posScore 7 -> bonus 1.6, conf = sqrt(300/400) = 0.86603):
    //   final = (team * 0.8 + 0.32) * (0.3 + 0.7 * 0.86603)
    //   spiky:  2.5422 * 0.90622 = 2.304
    //   stable: 2.3200 * 0.90622 = 2.102
    // If these pins fail, the scoring formula changed — update playgroundData.ts
    // preset #2 ("Higher mean wins…") in the same commit.
    expect(spiky.finalScore).toBeCloseTo(2.304, 2);
    expect(stable.finalScore).toBeCloseTo(2.102, 2);
    expect(spiky.finalScore).toBeGreaterThan(stable.finalScore);
  });

  it('shows the average trap: avg 1608 hides a 40g weak link', () => {
    const even = replay(
      ['P', 'T', 'J', 'S', 'L'].map((e, i) => ({ id: `a${i}`, enemy: e, games: 200, wr: 55 })),
      7,
    );
    const trap = replay(
      ['P', 'T', 'J', 'S', 'L'].map((e, i) => ({ id: `b${i}`, enemy: e, games: i === 4 ? 40 : 2000, wr: 55 })),
      7,
    );
    expect(even.avgGames).toBeCloseTo(200, 5);
    expect(trap.avgGames).toBeCloseTo(1608, 0);
    expect(even.confidence).toBeCloseTo(0.707, 2);
    expect(trap.confidence).toBe(1);
    expect(Math.min(...trap.steps.map((s) => s.games))).toBe(40);
  });

  it('helpers match engine constants', () => {
    expect(shrunkDelta(10, 60)).toBeCloseTo(5, 5);
    expect(sampleWeight(100)).toBe(10);
    expect(confidenceOf(400)).toBe(1);
    expect(positionBonusOf(7)).toBeCloseTo(1.6, 5);
  });
});

describe('playground <-> engine parity', () => {
  const ALL_ROLES = ['Carry', 'Support', 'Nuker', 'Disabler', 'Durable', 'Escape', 'Pusher', 'Initiator', 'Jungler'];

  function synthHero(id: number, name: string): Hero {
    return {
      id,
      key: `npc_dota_hero_${name.toLowerCase().replace(/\s+/g, '_')}`,
      name,
      primaryAttr: 'universal',
      attackType: 'Melee',
      roles: [...ALL_ROLES],
      img: '',
      icon: '',
      proPick: 0,
      proWin: 0,
      pubPick: 0,
      pubWin: 0,
      nameRu: name,
    };
  }

  // [enemyId, games, candidate winrate %]. `wins` in MatchupRow are wins of the
  // URL hero (the enemy), so candidate wins = games - wins.
  const ENEMY_SPECS: Array<[number, number, number]> = [
    [1001, 300, 60],
    [1002, 300, 60],
    [1003, 300, 40],
    [1004, 300, 60],
    [1005, 300, 60],
  ];

  it('replay() matches scoreCandidates() on the same synthetic draft, all 5 lanes', () => {
    const candidate = synthHero(1, 'Playground Parity');
    const heroes = [candidate];
    const enemyIds = ENEMY_SPECS.map(([id]) => id);

    const heroById = new Map<number, Hero>();
    for (const h of heroes) heroById.set(h.id, h);
    for (const id of enemyIds) heroById.set(id, synthHero(id, `Enemy ${id}`));

    const matchupByEnemy = new Map<number, MatchupRow[]>();
    for (const [enemyId, games, wr] of ENEMY_SPECS) {
      const candidateWins = Math.round((wr / 100) * games);
      matchupByEnemy.set(enemyId, [{ hero_id: candidate.id, games_played: games, wins: games - candidateWins }]);
    }

    const rows: PlayRow[] = ENEMY_SPECS.map(([enemyId, games, wr], i) => ({
      id: `e${i}`,
      enemy: `E${enemyId}`,
      games,
      wr,
    }));

    for (const lane of ['1', '2', '3', '4', '5'] as Lane[]) {
      const results = scoreCandidates({ heroes, enemyIds, matchupByEnemy, heroById }, lane, { model: 'A' });
      // replay() is the model-A pipeline; pass 'A' explicitly now that the
      // production default in scoreCandidates() is 'M' (V9 median).
      // all-roles hero passes minPositionScore (4.5) in every lane, so parity
      // must hold for the full pipeline, not just one lucky lane
      expect(results, `lane ${lane}`).toHaveLength(1);
      const c = results[0];
      const r = replay(rows, c.positionScore);
      expect(r.teamScore, `lane ${lane} teamScore`).toBeCloseTo(c.teamScore, 6);
      expect(r.avgGames, `lane ${lane} avgGames`).toBeCloseTo(c.avgGames, 6);
      expect(r.confidence, `lane ${lane} confidence`).toBeCloseTo(c.confidence, 6);
      expect(r.positionBonus, `lane ${lane} positionBonus`).toBeCloseTo(c.positionBonus, 6);
      expect(r.finalScore, `lane ${lane} finalScore`).toBeCloseTo(c.finalScore, 6);
      expect(r.deltaStats.mean, `lane ${lane} mean`).toBeCloseTo(c.deltaStats.mean, 6);
      expect(r.deltaStats.median, `lane ${lane} median`).toBeCloseTo(c.deltaStats.median, 6);
      expect(r.deltaStats.min, `lane ${lane} min`).toBeCloseTo(c.deltaStats.min, 6);
      expect(r.deltaStats.max, `lane ${lane} max`).toBeCloseTo(c.deltaStats.max, 6);
    }
  });
});

describe('aggregation models (experiment lab)', () => {
  const ALL_ROLES = ['Carry', 'Support', 'Nuker', 'Disabler', 'Durable', 'Escape', 'Pusher', 'Initiator', 'Jungler'];

  function synthHero(id: number, name: string): Hero {
    return {
      id,
      key: `npc_dota_hero_${name.toLowerCase().replace(/\s+/g, '_')}`,
      name,
      primaryAttr: 'universal',
      attackType: 'Melee',
      roles: [...ALL_ROLES],
      img: '',
      icon: '',
      proPick: 0,
      proWin: 0,
      pubPick: 0,
      pubWin: 0,
      nameRu: name,
    };
  }

  function setup(specs: Array<[number, number, number]>) {
    const candidate = synthHero(1, 'Lab Candidate');
    const heroes = [candidate];
    const enemyIds = specs.map(([id]) => id);
    const heroById = new Map<number, Hero>();
    heroById.set(candidate.id, candidate);
    for (const id of enemyIds) heroById.set(id, synthHero(id, `Enemy ${id}`));
    const matchupByEnemy = new Map<number, MatchupRow[]>();
    for (const [enemyId, games, wr] of specs) {
      const candidateWins = Math.round((wr / 100) * games);
      matchupByEnemy.set(enemyId, [{ hero_id: candidate.id, games_played: games, wins: games - candidateWins }]);
    }
    return { heroes, enemyIds, matchupByEnemy, heroById };
  }

  it('Model M uses median teamScore, robust to one dominating matchup', () => {
    // 4 solid +1 positive matchups and one huge +14: weighted mean (A) is pulled
    // up by the outlier; median (M) stays near the typical matchup.
    const input = setup([
      [111, 300, 58],
      [112, 300, 58],
      [113, 300, 58],
      [114, 300, 58],
      [115, 900, 64], // shrunk ≈ +12.35 — the outlier
    ]);
    const a = scoreCandidates(input, '1', { model: 'A' });
    const m = scoreCandidates(input, '1', { model: 'M' });
    expect(a).toHaveLength(1);
    expect(m).toHaveLength(1);
    // A's weighted mean is above the typical matchup, M's is not
    expect(a[0].teamScore).toBeGreaterThan(4.5);
    expect(m[0].teamScoreM!).toBeCloseTo(m[0].deltaStats.median, 6);
    expect(m[0].teamScoreM!).toBeLessThan(a[0].teamScore);
    // M ranks by median-based score; confidence step identical to A
    const rawM = m[0].teamScoreM! * 0.8 + m[0].positionBonus * 0.2;
    expect(m[0].finalScore).toBeCloseTo(rawM * (0.3 + 0.7 * m[0].confidence), 6);
  });

  it('Model W penalizes very bad matchups (fixed -5pp threshold, -3 per bad)', () => {
    const clean = setup([
      [121, 300, 56],
      [122, 300, 56],
      [123, 300, 56],
      [124, 300, 56],
      [125, 300, 56],
    ]);
    const weak = setup([
      [131, 300, 56],
      [132, 300, 56],
      [133, 300, 56],
      [134, 300, 56],
      [135, 300, 41], // shrunk ≈ −7.5 → below −5 threshold
    ]);
    const cleanW = scoreCandidates(clean, '1', { model: 'W' });
    const weakW = scoreCandidates(weak, '1', { model: 'W' });
    const cleanA = scoreCandidates(clean, '1', { model: 'A' });
    const weakA = scoreCandidates(weak, '1', { model: 'A' });
    expect(cleanW[0].finalScore).toBeCloseTo(cleanA[0].finalScore, 9); // no bad matchups → W == A
    expect(weakW[0].finalScore).toBeCloseTo(weakA[0].finalScore - 3 * (0.3 + 0.7 * weakW[0].confidence), 6); // one bad matchup → −3 × blend
  });

  it('requireFullCoverage toggles strict vs minUsableEnemies coverage', () => {
    const partial = setup([
      [301, 500, 57],
      [302, 19, 55], // below minMatchesPerPair (20) — not usable
      [303, 20, 55],
      [304, 20, 55],
      [305, 20, 55],
    ]);
    // strict (default): usable data vs ALL enemies required → hidden
    expect(scoreCandidates(partial, '1')).toHaveLength(0);
    expect(scoreCandidates(partial, '1', { requireFullCoverage: true })).toHaveLength(0);
    // loosened: 1 usable matchup is enough (minUsableEnemies = 1)
    const loose = scoreCandidates(partial, '1', { requireFullCoverage: false });
    expect(loose).toHaveLength(1);
  });
});
