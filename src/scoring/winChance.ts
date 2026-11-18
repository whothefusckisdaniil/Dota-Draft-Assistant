import { APP_CONFIG } from '../config';
import type { MatchupRow } from '../types';
import { expectedSynergyWinrate, expectedWinrate, NEUTRAL_WINRATE } from './baseline';

/**
 * Win chance of a full 5 v 5 draft, from the same statistics as the picks.
 *
 * The draft edge of your team, in win-rate points, is the sum of three parts:
 *   heroes   — Σ (base win rate − 50) of your heroes minus the enemies';
 *   counters — Σ over all 25 pairs of your hero's matchup advantage vs that enemy;
 *   synergy  — Σ over your 10 teammate pairs of the same-team advantage minus the enemy's.
 * Advantages are shrunk by sample size exactly like the candidate scores.
 *
 * The chance is a logistic of the edge. The slope was fitted on ~4000 public
 * ranked matches (OpenDota, Nov 2026) with all-ranks tables: all three parts
 * got nearly the same weight (0.032 / 0.037 / 0.038), so one slope is used.
 * On held-out matches the draft alone picked the winner ~60% of the time —
 * a draft decides a game only partly, and the numbers stay modest on purpose.
 */
export const WIN_SLOPE = 0.0345;

export interface PairEdge { a: number; b: number; delta: number }

export interface WinChance {
  /** Your team's chance, 0..1. */
  chance: number;
  /** Parts of the edge, in win-rate points (positive = your favour). */
  heroes: number;
  counters: number;
  synergy: number;
  /** Strongest single factors for the explanation. */
  bestCounter: PairEdge | null;
  worstCounter: PairEdge | null;
}

const shrink = (raw: number, games: number) => (raw * games) / (games + APP_CONFIG.scoring.shrinkageK);

function index(tables: Map<number, MatchupRow[]> | null | undefined) {
  const out = new Map<number, Map<number, MatchupRow>>();
  if (!tables) return out;
  for (const [id, rows] of tables) out.set(id, new Map(rows.map((r) => [r.hero_id, r])));
  return out;
}

export function winChance(args: {
  team: number[];
  enemies: number[];
  /** Rows of enemy E: wins of E vs hero_id. */
  matchupByEnemy: Map<number, MatchupRow[]>;
  /** Rows of hero A: wins of the team with A and hero_id. Null = no synergy layer. */
  synergyByHero: Map<number, MatchupRow[]> | null;
  baseWinrates: Map<number, number> | undefined;
}): WinChance {
  const { team, enemies, baseWinrates } = args;
  const mu = index(args.matchupByEnemy);
  const sy = index(args.synergyByHero);
  const base = (id: number) => (baseWinrates?.get(id) ?? NEUTRAL_WINRATE) - NEUTRAL_WINRATE;

  const heroes = team.reduce((s, id) => s + base(id), 0) - enemies.reduce((s, id) => s + base(id), 0);

  let counters = 0;
  const pairs: PairEdge[] = [];
  for (const a of team) {
    for (const e of enemies) {
      const r = mu.get(e)?.get(a);
      if (!r || r.games_played <= 0) continue;
      const wr = (100 * (r.games_played - r.wins)) / r.games_played;
      const delta = shrink(wr - expectedWinrate(baseWinrates, a, e), r.games_played);
      counters += delta;
      pairs.push({ a, b: e, delta });
    }
  }

  const teamSynergy = (ids: number[]) => {
    let s = 0;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const r = sy.get(ids[i])?.get(ids[j]);
        if (!r || r.games_played <= 0) continue;
        s += shrink((100 * r.wins) / r.games_played - expectedSynergyWinrate(baseWinrates, ids[i], ids[j]), r.games_played);
      }
    }
    return s;
  };
  const synergy = teamSynergy(team) - teamSynergy(enemies);

  const edge = heroes + counters + synergy;
  pairs.sort((x, y) => y.delta - x.delta);
  return {
    chance: 1 / (1 + Math.exp(-WIN_SLOPE * edge)),
    heroes,
    counters,
    synergy,
    bestCounter: pairs[0] && pairs[0].delta > 0.5 ? pairs[0] : null,
    worstCounter: pairs.length && pairs[pairs.length - 1].delta < -0.5 ? pairs[pairs.length - 1] : null,
  };
}
