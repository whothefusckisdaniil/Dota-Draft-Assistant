import type { HeroPositionEntry, PositionDataset } from '../types';
import type { Lane } from './positionsExtra';

/**
 * Empirical position eligibility (ТЗ №9).
 *
 * OpenDota `roles` are ability tags, not positions — "Support" is applied to
 * Wraith King, "Disabler" to Meepo — so they cannot decide whether a hero may
 * be recommended on a lane. This replaces them with the real thing: what
 * fraction of that hero's actual games are played at each position.
 *
 * One rule for every hero; there are no per-hero exceptions. A hero is eligible
 * on a lane only if it clears BOTH thresholds, and a hero with no position data
 * is never eligible anywhere (fail-closed, §13).
 *
 * The thresholds live in `scripts/stratz/eligibility.mjs` and are mirrored here
 * so the generator and the app can never disagree; `eligibility.test.ts` asserts
 * the two stay in sync.
 */
export const POSITION_ELIGIBILITY = {
  /** Minimum share of the hero's games played at that position. */
  minShare: 0.08,
  /** Minimum absolute games at that position across the whole window. */
  minGames: 500,
} as const;

export interface PositionVerdict {
  eligible: boolean;
  share: number;
  games: number;
  totalGames: number;
}

/** Full verdict for one hero on one lane — also used for the UI's role copy. */
export function positionEligibility(
  positions: PositionDataset | undefined,
  heroId: number,
  lane: Lane,
): PositionVerdict {
  const entry: HeroPositionEntry | undefined = positions?.[heroId];
  const stat = entry?.positions?.[lane];
  if (!entry || !stat) {
    return { eligible: false, share: 0, games: 0, totalGames: entry?.totalGames ?? 0 };
  }
  return {
    eligible: stat.share >= POSITION_ELIGIBILITY.minShare && stat.games >= POSITION_ELIGIBILITY.minGames,
    share: stat.share,
    games: stat.games,
    totalGames: entry.totalGames,
  };
}

/** Convenience predicate for the hard gate in `scoreCandidates`. */
export function isEligibleAt(positions: PositionDataset | undefined, heroId: number, lane: Lane): boolean {
  return positionEligibility(positions, heroId, lane).eligible;
}

/** All lanes a hero may be ranked on (§14 — flex heroes keep several). */
export function eligibleLanes(positions: PositionDataset | undefined, heroId: number): Lane[] {
  return (['1', '2', '3', '4', '5'] as Lane[]).filter((l) => isEligibleAt(positions, heroId, l));
}
