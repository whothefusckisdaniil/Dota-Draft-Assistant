import { APP_CONFIG } from '../config';
import type { DeltaStats } from '../types';

export interface PlayRow {
  id: string;
  enemy: string;
  games: number;
  wr: number; // candidate winrate % vs this enemy
}

const cfg = APP_CONFIG.scoring;

export function shrunkDelta(rawDelta: number, games: number): number {
  return (rawDelta * games) / (games + cfg.shrinkageK);
}

export function sampleWeight(games: number): number {
  return Math.sqrt(games);
}

export function confidenceOf(avgGames: number): number {
  return Math.min(1, Math.sqrt(avgGames / cfg.confidenceDenominator));
}

export function positionBonusOf(posScore: number): number {
  return ((posScore - 5) / 5) * cfg.positionBonusRange;
}

export interface ReplayStep {
  id: string;
  enemy: string;
  games: number;
  wr: number;
  raw: number;
  shrunk: number;
  w: number;
}

/** Pure replay of src/scoring/engine.ts math on synthetic rows.
 *  Parity with the engine is enforced by replay.test.ts
 *  ("replay() matches scoreCandidates() on the same synthetic draft"):
 *  change engine.ts without updating this file and the test fails. */
export function replay(rows: PlayRow[], posScore: number): {
  steps: ReplayStep[];
  teamScore: number;
  avgGames: number;
  confidence: number;
  positionBonus: number;
  raw: number;
  finalScore: number;
  usable: number;
  deltaStats: DeltaStats;
} {
  const steps = rows.map((r) => {
    const raw = r.wr - cfg.neutralWinrate;
    return { id: r.id, enemy: r.enemy, games: r.games, wr: r.wr, raw, shrunk: shrunkDelta(raw, r.games), w: sampleWeight(r.games) };
  });
  const usable = steps.filter((s) => s.games >= cfg.minMatchesPerPair);
  let num = 0;
  let den = 0;
  let sum = 0;
  for (const s of usable) {
    num += s.shrunk * s.w;
    den += s.w;
    sum += s.games;
  }
  const teamScore = den > 0 ? num / den : 0;
  const avgGames = usable.length > 0 ? sum / usable.length : 0;
  const confidence = confidenceOf(avgGames);
  const positionBonus = positionBonusOf(posScore);
  const raw = teamScore * cfg.wCounter + positionBonus * cfg.wPosition;
  const finalScore = raw * (0.3 + 0.7 * confidence);
  return { steps, teamScore, avgGames, confidence, positionBonus, raw, finalScore, usable: usable.length, deltaStats: computeDeltaStats(usable.map((s) => s.shrunk)) };
}

/** Mean / median / min / max over the given values. Mirrors engine.computeDeltaStats. */
export function computeDeltaStats(values: number[]): DeltaStats {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return { mean: 0, median: 0, min: 0, max: 0 };
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  const median = n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  return { mean, median, min: sorted[0], max: sorted[n - 1] };
}
