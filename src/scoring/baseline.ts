import type { MatchupRow } from '../types';

/**
 * Hero baseline win rates for the matchup advantage (Dotabuff-style
 * "disadvantage", computed from our own STRATZ data).
 *
 * A raw matchup win rate mixes two things: how strong a hero is in general and
 * how well it does against this particular enemy. A hero with a 55% overall win
 * rate looks like a "counter" to almost everyone. The advantage removes the
 * general part:
 *
 *   expected(A vs B) = base(A) − (base(B) − 50)
 *   advantage(A vs B) = winrate(A vs B) − expected(A vs B)
 *
 * so +3 means "A wins 3 pp more against B than A and B's usual win rates
 * predict".
 *
 * base(H) is H's win rate over every matchup row in the snapshot (same
 * 4-week window and rank brackets as the matchups). It needs the FULL matchup
 * matrix; a handful of tables (e.g. only the selected enemies) would make the
 * baseline equal to the very matchups it is meant to normalise.
 */
export function computeBaseWinrates(matchupByEnemy: Map<number, MatchupRow[]>): Map<number, number> {
  const games = new Map<number, number>();
  const wins = new Map<number, number>();
  for (const rows of matchupByEnemy.values()) {
    for (const row of rows) {
      if (!(row.games_played > 0)) continue;
      // Rows store ENEMY wins vs the candidate `hero_id`.
      games.set(row.hero_id, (games.get(row.hero_id) ?? 0) + row.games_played);
      wins.set(row.hero_id, (wins.get(row.hero_id) ?? 0) + (row.games_played - row.wins));
    }
  }
  const out = new Map<number, number>();
  for (const [heroId, g] of games) out.set(heroId, (100 * (wins.get(heroId) ?? 0)) / g);
  return out;
}

/** Neutral baseline used when a hero has no baseline: the old "winrate − 50". */
export const NEUTRAL_WINRATE = 50;

/** Expected team win rate of two teammates: both heroes' edges add up. */
export function expectedSynergyWinrate(baseWinrates: Map<number, number> | undefined, a: number, b: number): number {
  const ba = baseWinrates?.get(a) ?? NEUTRAL_WINRATE;
  const bb = baseWinrates?.get(b) ?? NEUTRAL_WINRATE;
  return ba + bb - NEUTRAL_WINRATE;
}

export function expectedWinrate(baseWinrates: Map<number, number> | undefined, candidateId: number, enemyId: number): number {
  const candidate = baseWinrates?.get(candidateId) ?? NEUTRAL_WINRATE;
  const enemy = baseWinrates?.get(enemyId) ?? NEUTRAL_WINRATE;
  return candidate - (enemy - NEUTRAL_WINRATE);
}
