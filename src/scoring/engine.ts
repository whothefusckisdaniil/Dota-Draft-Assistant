import { APP_CONFIG } from '../config';
import type { LaneDetail, AggOptions, CandidateScore, DeltaStats, Hero, MatchupDetail, MatchupRow, PositionDataset, SynergyDetail } from '../types';
import { LANE_AFFINITY } from './positions';
import { EXTRA_AFFINITY, positionScoreBase, type Lane } from './positionsExtra';
import { isEligibleAt } from './positionEligibility';
import { expectedSynergyWinrate, expectedWinrate } from './baseline';

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
  /**
   * Real pick rates per lane (ТЗ №9). REQUIRED for a non-empty result: without
   * it there is no evidence a hero can play the lane, and inventing a fallback
   * would reintroduce the exact off-role bug the position layer exists to fix.
   */
  positions: PositionDataset;
  /** Heroes whose matchup table failed to load — no candidate may be scored. */
  failedEnemyIds?: number[];
  /**
   * Hero baseline win rates (%) from the FULL snapshot — see
   * `computeBaseWinrates`. With them, every matchup is scored by its
   * advantage (win rate vs the enemy minus what both heroes' usual win rates
   * predict) instead of raw win rate. Production always passes them; without
   * them (synthetic lab presets) the baseline is the neutral 50%.
   */
  baseWinrates?: Map<number, number>;
  /** Your team (up to 4 heroes). Candidates are also scored by synergy with them. */
  allyIds?: number[];
  /**
   * Same-team tables keyed by ally: `rows` for that ally, `wins` = wins of the
   * team with both heroes. Null/undefined = no synergy data (allies are then
   * only excluded from the candidates, not scored).
   */
  synergyByAlly?: Map<number, MatchupRow[]> | null;
  /** Heroes that cannot be picked (bans, already picked elsewhere). */
  excludeIds?: number[];
  /** Your ally on this lane (from ally positions) and its laning table. */
  lane?: LaneInput | null;
}

export interface LaneInput {
  allyId: number;
  /** Ally's lane results with each partner at its position: id → [lanes, won, lost]. */
  partners: Record<string, [number, number, number]>;
  /** Ally's usual lane win share at its position (0..1). */
  allyAvg: number;
  /** A candidate's usual lane win share at the scored position (0..1), if known. */
  candidateAvg: (heroId: number) => number | undefined;
}

/** Laning with the lane partner: share vs what both heroes usually get. */
export function laneDetail(heroId: number, lane: LaneInput): LaneDetail | null {
  const cfg = APP_CONFIG.scoring;
  const row = lane.partners[String(heroId)];
  if (!row) return null;
  const [, won, lost] = row;
  const games = won + lost;
  if (games <= 0) return null;
  const share = (100 * won) / games;
  const expected = ((lane.candidateAvg(heroId) ?? 0.5) + lane.allyAvg - 0.5) * 100;
  const raw = share - expected;
  return {
    allyId: lane.allyId, games, won, lost, share, expected,
    delta: (raw * games) / (games + cfg.laneShrinkK),
    usable: games >= cfg.laneMinGames,
  };
}

/** Same-team advantage of `heroId` with each ally (shrunk like matchups). */
export function synergyDetails(
  heroId: number,
  allyIds: number[],
  synergyByAlly: Map<number, MatchupRow[]>,
  baseWinrates: Map<number, number> | undefined,
): SynergyDetail[] {
  const cfg = APP_CONFIG.scoring;
  const out: SynergyDetail[] = [];
  for (const allyId of allyIds) {
    const row = synergyByAlly.get(allyId)?.find((r) => r.hero_id === heroId);
    if (!row || row.games_played <= 0) continue;
    const games = row.games_played;
    const winrate = (row.wins / games) * 100;
    const expected = expectedSynergyWinrate(baseWinrates, heroId, allyId);
    const rawDelta = winrate - expected;
    const delta = (rawDelta * games) / (games + cfg.shrinkageK);
    out.push({ allyId, games, winrate, expectedWinrate: expected, delta, rawDelta, usable: games >= cfg.minMatchesPerPair });
  }
  return out;
}

export function scoreCandidates(input: ScoreInput, pos: Lane, opts: AggOptions = {}): CandidateScore[] {
  const { heroes, enemyIds, matchupByEnemy, heroById, positions, failedEnemyIds, baseWinrates } = input;
  const allyIds = input.allyIds ?? [];
  const synergyByAlly = input.synergyByAlly ?? null;
  const scoreAllies = allyIds.length > 0 && !!synergyByAlly;
  const excluded = new Set([...(input.excludeIds ?? []), ...allyIds]);
  if (enemyIds.length === 0 && !scoreAllies) return [];
  if (scoreAllies && allyIds.some((id) => !synergyByAlly!.has(id))) return [];
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
    if (enemySet.has(hero.id) || excluded.has(hero.id)) continue;
    const matchups: MatchupDetail[] = [];
    for (const enemyId of enemyIds) {
      const rows = matchupByEnemy.get(enemyId);
      if (!rows) continue; // unreachable after the guard above, kept for safety
      const row = rows.find((r) => r.hero_id === hero.id);
      if (!row || row.games_played <= 0) continue;
      const games = row.games_played;
      const winsForCandidate = games - row.wins;
      const winrate = (winsForCandidate / games) * 100;
      // Matchup advantage: how much better than the two heroes' usual win
      // rates predict (neutral 50% baseline when no baselines are supplied).
      const expected = baseWinrates ? expectedWinrate(baseWinrates, hero.id, enemyId) : cfg.neutralWinrate;
      const rawDelta = winrate - expected;
      const delta = (rawDelta * games) / (games + cfg.shrinkageK);
      matchups.push({ enemyId, games, winsForCandidate, winrate, expectedWinrate: expected, delta, rawDelta, usable: games >= cfg.minMatchesPerPair });
    }
    const usable = matchups.filter((m) => m.usable);
    // Coverage gate. Default (V2, strict): usable data vs EVERY selected enemy.
    // requireFullCoverage=false loosens this to minUsableEnemies usable matchups.
    const fullCoverage = opts.requireFullCoverage ?? cfg.requireFullCoverage;
    const required = fullCoverage ? enemyIds.length : Math.min(cfg.minUsableEnemies, enemyIds.length);
    if (usable.length < required) continue;
    // Synergy: same strict coverage — usable same-team data with EVERY ally.
    const synergy = scoreAllies ? synergyDetails(hero.id, allyIds, synergyByAlly!, baseWinrates) : [];
    const usableSynergy = synergy.filter((s) => s.usable);
    if (scoreAllies && usableSynergy.length < allyIds.length) continue;
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
    const synergyGames = usableSynergy.reduce((sum, s) => sum + s.games, 0);
    const avgGames = (gamesSum + synergyGames) / Math.max(1, usable.length + usableSynergy.length);
    if (avgGames < cfg.minimumSampleAvg) continue;
    const confidence = Math.min(1, Math.sqrt(avgGames / cfg.confidenceDenominator));
    // ТЗ №9 §11 — HARD GATE, evaluated before any role score or bonus exists.
    // A hero that does not actually get picked on this lane is not a candidate,
    // however good its matchup numbers are. Without this, counter advantage
    // alone could pull Meepo onto pos 4 or Wraith King onto pos 5, because
    // their OpenDota role tags happened to fit.
    if (!isEligibleAt(positions, hero.id, pos)) continue;
    // Secondary only: the heuristic role score nudges ranking, it no longer
    // decides eligibility (§10, §12).
    const pScore = positionScore(hero, pos);
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
    const synergyScore = usableSynergy.length > 0 ? computeDeltaStats(usableSynergy.map((s) => s.delta)).median : 0;
    // Lane partner: optional (no coverage gate) — no data, no adjustment.
    const lane = input.lane ? laneDetail(hero.id, input.lane) : null;
    const laneBonus = lane?.usable ? cfg.wLane * lane.delta : 0;
    let teamScoreM: number | undefined;
    let finalScore: number;
    let draftScore = teamScore + cfg.wSynergy * synergyScore + laneBonus;
    if (model === 'M') {
      teamScoreM = deltaStats.median;
      draftScore = teamScoreM + cfg.wSynergy * synergyScore + laneBonus;
      const rawM = draftScore * cfg.wCounter + positionBonus * cfg.wPosition;
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
      synergy,
      synergyScore,
      lane,
      draftScore,
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
