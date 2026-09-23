import { APP_CONFIG } from '../config';
import type { AggOptions, CandidateScore, DeltaStats, Hero, MatchupDetail, MatchupRow } from '../types';
import { LANE_AFFINITY } from './positions';
import { EXTRA_AFFINITY, positionScoreBase, type Lane } from './positionsExtra';

export function positionScore(hero: Hero, pos: Lane): number {
  const a = LANE_AFFINITY[hero.name] ?? {};
  const b = EXTRA_AFFINITY[hero.name] ?? {};
  return positionScoreBase(hero, pos, { ...a, ...b });
}

export function fmtDelta(d: number): string {
  const sign = d > 0 ? '+' : d < 0 ? '−' : '';
  return `${sign}${Math.abs(d).toFixed(1)}`;
}

export function laneLabel(pos: Lane): string {
  return pos === '1' ? 'Carry' : pos === '2' ? 'Mid' : pos === '3' ? 'Offlane' : pos === '4' ? 'Support 4' : 'Support 5';
}

function buildExplanation(args: {
  matchups: MatchupDetail[];
  enemyNames: Map<number, string>;
  avgGames: number;
  positiveCount: number;
  totalUsable: number;
  pScore: number;
  posLabel: string;
}): string[] {
  const { matchups, enemyNames, avgGames, positiveCount, totalUsable, pScore, posLabel } = args;
  const out: string[] = [];
  const sorted = [...matchups].filter((m) => m.usable).sort((a, b) => b.delta - a.delta);
  const best = sorted.slice(0, 2).filter((m) => m.delta > 0.5);
  const worst = [...sorted].reverse().find((m) => m.delta < -2);
  if (best.length > 0) {
    out.push(`Statistically favorable against ${best.map((m) => enemyNames.get(m.enemyId) ?? `#${m.enemyId}`).join(' and ')}.`);
  }
  if (worst) out.push(`Weak spot: ${enemyNames.get(worst.enemyId) ?? 'one enemy'} (${fmtDelta(worst.delta)}).`);
  if (totalUsable > 1) {
    out.push(positiveCount === totalUsable
      ? `Positive matchups against all ${totalUsable} selected enemies.`
      : `Positive against ${positiveCount} of ${totalUsable} selected enemies.`);
  }
  if (avgGames >= 800) out.push('Large statistical sample — high confidence.');
  else if (avgGames >= 200) out.push('Solid sample size.');
  else out.push('Limited sample — treat as a hint, not a guarantee.');
  if (pScore >= 7) out.push(`Strong role fit for ${posLabel}.`);
  else if (pScore >= 5) out.push(`Reasonable role fit for ${posLabel}.`);
  else out.push(`Off-role pick for ${posLabel} — counter value outweighs role fit.`);
  return out;
}

export interface ScoreInput {
  heroes: Hero[];
  enemyIds: number[];
  matchupByEnemy: Map<number, MatchupRow[]>;
  heroById: Map<number, Hero>;
  /** Heroes whose matchup table failed to load — no candidate may be scored. */
  failedEnemyIds?: number[];
}

export function scoreCandidates(input: ScoreInput, pos: Lane, opts: AggOptions = {}): CandidateScore[] {
  const { heroes, enemyIds, matchupByEnemy, heroById, failedEnemyIds } = input;
  const cfg = APP_CONFIG.scoring;
  // Production default is M (median teamScore) — validated against A on the
  // evaluation set in V9/V10 (see liveValidate.ts). A/W stay available in the
  // dev lab only.
  const model = opts.model ?? 'M';
  const enemySet = new Set(enemyIds);
  const enemyNames = new Map<number, string>(enemyIds.map((id) => [id, heroById.get(id)?.name ?? `#${id}`]));

  // If any selected enemy has no matchup table at all, we cannot honestly
  // compare candidates "against the whole draft" — return nothing and let
  // the UI explain that data is missing (instead of ranking partial heroes).
  const failed = new Set(failedEnemyIds ?? []);
  for (const id of enemyIds) {
    if (!matchupByEnemy.has(id)) failed.add(id);
  }
  if (failed.size > 0) return [];

  const results: CandidateScore[] = [];

  for (const hero of heroes) {
    if (enemySet.has(hero.id)) continue;
    const matchups: MatchupDetail[] = [];
    for (const enemyId of enemyIds) {
      const rows = matchupByEnemy.get(enemyId);
      if (!rows) continue; // unreachable after the guard above, kept for safety
      const row = rows.find((r) => r.hero_id === hero.id);
      if (!row || row.games_played <= 0) continue;
      const games = row.games_played;
      const winsForCandidate = games - row.wins;
      const winrate = (winsForCandidate / games) * 100;
      const rawDelta = winrate - cfg.neutralWinrate;
      const delta = (rawDelta * games) / (games + cfg.shrinkageK);
      matchups.push({ enemyId, games, winsForCandidate, winrate, delta, rawDelta, usable: games >= cfg.minMatchesPerPair });
    }
    const usable = matchups.filter((m) => m.usable);
    // Coverage gate. Default (V2, strict): usable data vs EVERY selected enemy.
    // requireFullCoverage=false loosens this to minUsableEnemies usable matchups.
    const fullCoverage = opts.requireFullCoverage ?? cfg.requireFullCoverage;
    const required = fullCoverage ? enemyIds.length : Math.min(cfg.minUsableEnemies, enemyIds.length);
    if (usable.length < required) continue;
    let num = 0;
    let den = 0;
    let gamesSum = 0;
    for (const m of usable) {
      const w = Math.sqrt(m.games);
      num += m.delta * w;
      den += w;
      gamesSum += m.games;
    }
    const teamScore = den > 0 ? num / den : 0;
    const avgGames = gamesSum / usable.length;
    if (avgGames < cfg.minimumSampleAvg) continue;
    const confidence = Math.min(1, Math.sqrt(avgGames / cfg.confidenceDenominator));
    const pScore = positionScore(hero, pos);
    const minP = cfg.minPositionScore[pos] ?? 0;
    if (pScore < minP) continue;
    const positionBonus = ((pScore - 5) / 5) * cfg.positionBonusRange;
    const deltas = usable.map((m) => m.delta);
    const deltaStats = computeDeltaStats(deltas);
    // Aggregation models (V8 experiment lab) — same pipeline, different teamScore/final:
    //   A — current production: √games-weighted mean, final = raw*(0.3+0.7*conf)
    //   M — median: teamScore = median of usable shrunk deltas (robust to one
    //       huge matchup dominating the weighted mean); final confidence kept.
    //   W — weak-link: current aggregation, then subtract weakLinkPenalty for
    //       every matchup whose shrunk delta is below weakLinkThreshold.
    //       Diagnostic: measures "hero without a critical bad matchup".
    const badCount = deltas.filter((d) => d < cfg.weakLinkThreshold).length;
    const raw = teamScore * cfg.wCounter + positionBonus * cfg.wPosition;
    let teamScoreM: number | undefined;
    let finalScore: number;
    if (model === 'M') {
      teamScoreM = deltaStats.median;
      const rawM = teamScoreM * cfg.wCounter + positionBonus * cfg.wPosition;
      finalScore = rawM * (0.3 + 0.7 * confidence);
    } else if (model === 'W') {
      const rawW = raw - badCount * cfg.weakLinkPenalty;
      finalScore = rawW * (0.3 + 0.7 * confidence);
    } else {
      finalScore = raw * (0.3 + 0.7 * confidence);
    }
    const positiveCount = usable.filter((m) => m.delta > 0).length;
    const posLabel = laneLabel(pos);
    const sortedUsable = [...usable].sort((a, b) => b.delta - a.delta);
    results.push({
      hero, teamScore, teamScoreM, avgGames, confidence, positionScore: pScore, positionBonus, finalScore,
      matchups, usableEnemies: usable.length, lowData: avgGames < 200 || usable.length < enemyIds.length,
      explanation: buildExplanation({ matchups, enemyNames, avgGames, positiveCount, totalUsable: usable.length, pScore, posLabel }),
      bestAgainst: sortedUsable.filter((m) => m.delta > 0.5).slice(0, 2).map((m) => enemyNames.get(m.enemyId)!),
      worstAgainst: sortedUsable.filter((m) => m.delta < -2).slice(-1).map((m) => enemyNames.get(m.enemyId)!),
      deltaStats,
    });
  }
  results.sort((a, b) => b.finalScore - a.finalScore);
  return results.slice(0, cfg.topN);
}

/** mean / median / min / max over usable shrunk deltas (pp). */
export function computeDeltaStats(deltas: number[]): DeltaStats {
  const sorted = [...deltas].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return { mean: 0, median: 0, min: 0, max: 0 };
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  const median = n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  return { mean, median, min: sorted[0], max: sorted[n - 1] };
}
