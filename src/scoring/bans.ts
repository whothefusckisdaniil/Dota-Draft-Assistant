import { APP_CONFIG } from '../config';
import type { Hero, MatchupRow } from '../types';
import { expectedSynergyWinrate, expectedWinrate } from './baseline';
import { computeDeltaStats } from './engine';

/**
 * Ban suggestions — derived from the same tables as the recommendations.
 *
 * A hero is worth banning when it
 *   1. counters YOUR team: its matchup advantage against your picked heroes
 *      (from the matchup tables keyed by your allies), and/or
 *   2. fits the ENEMY team: its same-team advantage with the enemy picks
 *      (from the synergy tables keyed by the enemies).
 *
 *   banScore = median threat vs allies + wSynergy × median synergy with enemies
 *
 * With only enemies picked, (2) alone decides; with only allies, (1) alone.
 * Heroes already picked or banned are never suggested. Not role-specific: the
 * enemy can play the hero anywhere.
 */
export interface BanSuggestion {
  hero: Hero;
  score: number;
  /** Shrunk advantage of this hero against each of your heroes (pp). */
  threats: { allyId: number; delta: number; games: number }[];
  /** Shrunk same-team advantage with each enemy (pp). */
  fits: { enemyId: number; delta: number; games: number }[];
}

export interface BanInput {
  heroes: Hero[];
  allyIds: number[];
  enemyIds: number[];
  excludeIds: number[];
  /** Matchup tables keyed by hero (wins = key hero's wins) — the app's `matchups`. */
  matchupByHero: Map<number, MatchupRow[]>;
  /** Same-team tables keyed by hero (wins = team wins); null = no synergy data. */
  synergyByHero: Map<number, MatchupRow[]> | null;
  baseWinrates?: Map<number, number>;
  limit?: number;
}

const shrink = (raw: number, games: number) => (raw * games) / (games + APP_CONFIG.scoring.shrinkageK);

export function suggestBans(input: BanInput): BanSuggestion[] {
  const cfg = APP_CONFIG.scoring;
  const { heroes, allyIds, enemyIds, matchupByHero, synergyByHero, baseWinrates } = input;
  const useFits = enemyIds.length > 0 && !!synergyByHero;
  if (allyIds.length === 0 && !useFits) return [];
  const excluded = new Set([...input.excludeIds, ...allyIds, ...enemyIds]);

  const out: BanSuggestion[] = [];
  for (const hero of heroes) {
    if (excluded.has(hero.id)) continue;

    // 1. Threat: this hero as an enemy of each ally. Ally's table row for
    //    `hero` stores the ally's wins, so the hero's win rate is 1 − wins/games.
    const threats: BanSuggestion['threats'] = [];
    for (const allyId of allyIds) {
      const row = matchupByHero.get(allyId)?.find((r) => r.hero_id === hero.id);
      if (!row || row.games_played < cfg.minMatchesPerPair) continue;
      const wr = ((row.games_played - row.wins) / row.games_played) * 100;
      const raw = wr - expectedWinrate(baseWinrates, hero.id, allyId);
      threats.push({ allyId, delta: shrink(raw, row.games_played), games: row.games_played });
    }
    if (threats.length < allyIds.length) continue; // strict coverage, like the recommendations

    // 2. Fit: this hero on the enemy team, with each enemy.
    const fits: BanSuggestion['fits'] = [];
    if (useFits) {
      for (const enemyId of enemyIds) {
        const row = synergyByHero!.get(enemyId)?.find((r) => r.hero_id === hero.id);
        if (!row || row.games_played < cfg.minMatchesPerPair) continue;
        const wr = (row.wins / row.games_played) * 100;
        const raw = wr - expectedSynergyWinrate(baseWinrates, hero.id, enemyId);
        fits.push({ enemyId, delta: shrink(raw, row.games_played), games: row.games_played });
      }
      if (fits.length < enemyIds.length) continue;
    }

    const threat = threats.length ? computeDeltaStats(threats.map((t) => t.delta)).median : 0;
    const fit = fits.length ? computeDeltaStats(fits.map((f) => f.delta)).median : 0;
    out.push({ hero, score: threat + cfg.wSynergy * fit, threats, fits });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, input.limit ?? cfg.banSuggestions);
}
