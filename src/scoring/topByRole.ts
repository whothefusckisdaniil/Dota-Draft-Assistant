import type { Hero } from '../types';
import type { RoleStats } from '../data/dataset';

/**
 * "Strongest heroes on a position right now" — no draft needed.
 * Win rate of each hero *when played at that position*, in the chosen rank
 * (or all ranks), over the same 30-day window as everything else.
 *
 * Only heroes actually played there: at least `minShare` of the hero's games
 * at that position and `minGames` games (a core with the odd support game
 * does not count). Ranked by the win rate shrunk toward 50% by
 * games / (games + K), so a 1 500-game outlier does not beat a 50 000-game hero
 * on noise alone.
 */
export interface TopRoleHero {
  hero: Hero;
  winrate: number;
  games: number;
  /** Share of this hero's games played at the position (0..1). */
  laneShare: number;
  /** Share of all matches in which this hero is played at the position (0..1). */
  pickRate: number;
  score: number;
}

export const TOP_ROLE = {
  minShare: 0.2,
  minGamesAllRanks: 2000,
  minGamesPerRank: 500,
  shrinkK: 1000,
  limit: 10,
} as const;

export function topHeroesForPosition(
  stats: RoleStats | null,
  heroes: Hero[],
  rank: string,
  position: 1 | 2 | 3 | 4 | 5,
  limit: number = TOP_ROLE.limit,
): TopRoleHero[] {
  const table = stats?.[rank] ?? stats?.ALL;
  if (!table) return [];
  const p = position - 1;
  const minGames = rank === 'ALL' || !stats?.[rank] ? TOP_ROLE.minGamesAllRanks : TOP_ROLE.minGamesPerRank;
  // every match has two players at each position
  let laneGames = 0;
  for (const cells of Object.values(table)) laneGames += cells[p]?.[0] ?? 0;
  const matches = laneGames / 2;
  const out: TopRoleHero[] = [];
  for (const hero of heroes) {
    const cells = table[String(hero.id)];
    if (!cells) continue;
    const [games, wins] = cells[p] ?? [0, 0];
    const total = cells.reduce((s, c) => s + c[0], 0);
    if (games < minGames || !total || games / total < TOP_ROLE.minShare) continue;
    const winrate = (100 * wins) / games;
    out.push({
      hero,
      winrate,
      games,
      laneShare: games / total,
      pickRate: matches ? games / matches : 0,
      score: 50 + ((winrate - 50) * games) / (games + TOP_ROLE.shrinkK),
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
