/**
 * Live draft validation — runs the REAL scoring engine on REAL OpenDota data
 * for hand-picked drafts and prints the full breakdown.
 * Triggered via:  LIVE=1 npx vitest run src/scoring/live.validate.test.ts
 * Read-only by design: no formula changes here, this is the expected-vs-actual log.
 */
import { getHeroes, getHeroStats, getMatchupsMany } from '../data/opendota';
import { mergeHeroes } from '../data/heroes';
import { fmtDelta, laneLabel, scoreCandidates } from './engine';
import { spearmanRho } from './stats';
import type { Lane } from './positionsExtra';
import type { CandidateScore, Hero, MatchupRow } from '../types';

// No @types/node in this project; declare the minimal surface we need.
declare const process: { env: Record<string, string | undefined> };

interface PairStat {
  lanes: number;
  sameTop1: number; // A#1 === B#1
  top1Preserved: number; // the A#1 hero is present anywhere in B's top-5
  overlapSum: number; // Σ |A∩B| over lanes (each list is exactly top-5)
  shiftSum: number; // Σ |Δrank| over heroes present in BOTH top-5s
  shiftHeroes: number;
  lanesWithShift: number; // lanes where at least one shared hero moved ≥2 ranks
  rhoSum: number; // Σ Spearman ρ over lanes with ≥2 shared heroes
  rhoCount: number;
}

function newPairStat(): PairStat {
  return { lanes: 0, sameTop1: 0, top1Preserved: 0, overlapSum: 0, shiftSum: 0, shiftHeroes: 0, lanesWithShift: 0, rhoSum: 0, rhoCount: 0 };
}

/** Aggregates ranking-agreement metrics for one lane, one model pair.
 *  IMPORTANT: top1Preserved counts exactly "the A#1 hero is in B's top-5",
 *  not "the two top-5 lists share any hero" (that was a V9 metric bug). */
function accumulatePair(s: PairStat, a: CandidateScore[], b: CandidateScore[]): void {
  s.lanes += 1;
  const aTop1 = a[0]?.hero.id;
  const bTop1 = b[0]?.hero.id;
  if (aTop1 !== undefined && aTop1 === bTop1) s.sameTop1 += 1;
  if (aTop1 !== undefined && b.some((t) => t.hero.id === aTop1)) s.top1Preserved += 1;
  const byIdA = new Map(a.map((t) => [t.hero.id, t]));
  const inter = b.filter((t) => byIdA.has(t.hero.id));
  s.overlapSum += inter.length;
  let moved = false;
  const ranksA: number[] = [];
  const ranksB: number[] = [];
  for (const t of inter) {
    const rA = a.findIndex((x) => x.hero.id === t.hero.id) + 1;
    const rB = b.indexOf(t) + 1;
    ranksA.push(rA);
    ranksB.push(rB);
    s.shiftSum += Math.abs(rA - rB);
    s.shiftHeroes += 1;
    if (Math.abs(rA - rB) >= 2) moved = true;
  }
  if (moved) s.lanesWithShift += 1;
  if (ranksA.length >= 2) {
    const rho = spearmanRho(ranksA, ranksB);
    if (!Number.isNaN(rho)) {
      s.rhoSum += rho;
      s.rhoCount += 1;
    }
  }
}

const LANES: Lane[] = ['1', '2', '3', '4', '5'];

interface DraftCase {
  name: string;
  enemies: string[]; // localized names
  expected: Partial<Record<Lane, string>>; // Dota-logic expectation, filled before running
}

export const LIVE_CASES: DraftCase[] = [
  {
    name: 'Classic teamfight-ult draft',
    enemies: ['Puck', 'Tidehunter', 'Juggernaut', 'Sven', 'Lion'],
    expected: {
      '1': 'Lifestealer / Ursa — magic-immune-ish brawlers vs heavy AoE stun lineup',
      '2': 'Storm Spirit / Ember — mobile, dodges AoE; Puck himself fits',
      '3': 'Bristleback / Timbersaw — tanky; Tide/Jugg magic burst is a risk',
      '4': 'Tusk / Rubick — Rubick steals Echo-Slam-class ults',
      '5': 'Disruptor — Field punishes grouped enemy lineups',
    },
  },
  {
    name: 'Right-click carry draft',
    enemies: ['Phantom Assassin', 'Wraith King', 'Sniper', 'Vengeful Spirit', 'Crystal Maiden'],
    expected: {
      '1': 'Terrorblade / Sven — armor and blink considerations',
      '2': 'Ember Spirit / Storm Spirit — gap close vs squishy backline',
      '3': 'Axe / Centaur — Blade Mail vs PA, tanky initiators',
      '4': 'Spirit Breaker / Bounty Hunter — hunt the Sniper/CM',
      '5': 'Warlock / Undying — survivability vs physical',
    },
  },
  {
    name: 'Mobile gank draft',
    enemies: ['Ember Spirit', 'Storm Spirit', 'Spirit Breaker', 'Earthshaker', 'Oracle'],
    expected: {
      '1': 'Spectre / Medusa — hard to gank, scales',
      '2': 'Puck / Viper — lane-stable, Viper punishes divers',
      '3': 'Underlord / Axe — anti-mobility, AoE',
      '4': 'Tusk / Shadow Shaman — lock down divers',
      '5': 'Disruptor / Shadow Shaman — grip storm/ember jumps',
    },
  },
  {
    name: 'Illusion/summon flood',
    enemies: ['Chaos Knight', 'Phantom Lancer', 'Broodmother', 'Dark Seer', 'Dazzle'],
    expected: {
      '1': 'Sven / Medusa — cleave/AoE damage is premium',
      '2': 'Lina / Leshrac — AoE nukes clear the flood',
      '3': 'Axe / Bristleback — Blade Mail + culls illusions',
      '4': 'Sand King / Earthshaker style — AoE control',
      '5': 'Warlock — AoE zone vs flood',
    },
  },
];

/** Evaluation set: 10 fresh drafts. NO `expected` field and NO model tuning on
 *  these — they exist to measure how a candidate model generalizes beyond the
 *  4-draft regression set above. */
export const EVAL_CASES: { name: string; enemies: string[] }[] = [
  { name: 'E1 hard lockdown', enemies: ['Legion Commander', 'Bloodseeker', 'Silencer', 'Oracle', 'Dazzle'] },
  { name: 'E2 magic burst', enemies: ['Lina', 'Lion', 'Zeus', 'Tusk', 'Shadow Demon'] },
  { name: 'E3 split-push', enemies: ["Nature's Prophet", 'Tinker', 'Anti-Mage', 'Weaver', 'Shadow Shaman'] },
  { name: 'E4 dive', enemies: ['Storm Spirit', 'Slark', 'Nyx Assassin', 'Void Spirit', 'Disruptor'] },
  { name: 'E5 teamfight wombo', enemies: ['Enigma', 'Magnus', 'Faceless Void', 'Ember Spirit', 'Crystal Maiden'] },
  { name: 'E6 sustain grind', enemies: ['Necrophos', 'Abaddon', 'Viper', 'Dazzle', 'Undying'] },
  { name: 'E7 heavy magic immunities', enemies: ['Juggernaut', 'Lifestealer', 'Huskar', 'Omniknight', 'Dazzle'] },
  { name: 'E8 long-range poke', enemies: ['Sniper', 'Drow Ranger', 'Ancient Apparition', 'Shadow Demon', 'Shadow Shaman'] },
  { name: 'E9 temp control', enemies: ['Shadow Shaman', 'Lion', 'Rubick', 'Techies', 'Underlord'] },
  { name: 'E10 Illusion duo', enemies: ['Terrorblade', 'Naga Siren', 'Dark Seer', 'Treant Protector', 'Oracle'] },
];

export async function runLiveValidation(log: (s: string) => void = console.log): Promise<void> {
  const list = await getHeroes();
  const stats = await getHeroStats().catch(() => []);
  const heroes = mergeHeroes(list, stats);
  const heroById = new Map<number, Hero>(heroes.map((h) => [h.id, h]));
  log(`Loaded ${heroes.length} heroes\n`);

  for (const c of LIVE_CASES) {
    const ids: number[] = [];
    for (const n of c.enemies) {
      const h = heroes.find((x) => x.name === n);
      if (!h) throw new Error(`Unknown hero name in case "${c.name}": ${n}`);
      ids.push(h.id);
    }
    log('='.repeat(72));
    log(`DRAFT: ${c.name}`);
    log(`Enemies: ${c.enemies.join(', ')}\n`);

    const res = await getMatchupsMany(ids);
    const matchupByEnemy = new Map<number, MatchupRow[]>();
    const failed: number[] = [];
    for (const [id, v] of res) {
      if (Array.isArray(v)) matchupByEnemy.set(id, v);
      else failed.push(id);
    }
    if (failed.length > 0) {
      log(`  Matchup fetch failed for: ${failed.map((id) => heroById.get(id)?.name).join(', ')} — skipping case`);
      continue;
    }

    for (const lane of LANES) {
      // Rank comparison over the SAME candidate pool: run every model, then
      // build the union so we can see rank changes, not just "n/a".
      const run = (model: 'A' | 'M' | 'W') => scoreCandidates({ heroes, enemyIds: ids, matchupByEnemy, heroById }, lane, { model });
      const [topA, topM, topW] = [run('A'), run('M'), run('W')];
      const rankOf = (list: typeof topA, id: number) => {
        const i = list.findIndex((t) => t.hero.id === id);
        return i === -1 ? undefined : i + 1;
      };
      const scoreOf = (list: typeof topA, id: number) => list.find((t) => t.hero.id === id)?.finalScore;
      const byId = new Map(topA.map((t) => [t.hero.id, t]));
      for (const t of topM) if (!byId.has(t.hero.id)) byId.set(t.hero.id, t);
      for (const t of topW) if (!byId.has(t.hero.id)) byId.set(t.hero.id, t);

      const cell = (rank: number | undefined, score: number | undefined) =>
        rank !== undefined ? `#${String(rank).padStart(2)} ${score!.toFixed(2).padStart(5)}` : '   —      ';
      log(`  ${laneLabel(lane).toUpperCase()} — rank+score: A current / M median / W weak-link`);
      if (byId.size === 0) log('    (empty — no candidate passed coverage/role filters)');
      for (const t of byId.values()) {
        const usable = t.matchups.filter((m) => m.usable);
        const worst = [...usable].sort((x, y) => x.delta - y.delta)[0];
        const ds = t.deltaStats;
        const rA = rankOf(topA, t.hero.id);
        const rM = rankOf(topM, t.hero.id);
        const rW = rankOf(topW, t.hero.id);
        log(
          `    ${t.hero.name.padEnd(18)} A ${cell(rA, scoreOf(topA, t.hero.id))} M ${cell(rM, scoreOf(topM, t.hero.id))} W ${cell(rW, scoreOf(topW, t.hero.id))} | team ${t.teamScore.toFixed(2).padStart(6)} conf ${t.confidence.toFixed(2)} | mean ${ds.mean >= 0 ? '+' : ''}${ds.mean.toFixed(1)} median ${ds.median >= 0 ? '+' : ''}${ds.median.toFixed(1)} min ${ds.min >= 0 ? '+' : ''}${ds.min.toFixed(1)} max ${ds.max >= 0 ? '+' : ''}${ds.max.toFixed(1)} | worst ${worst ? `${heroById.get(worst.enemyId)?.name} ${fmtDelta(worst.delta)}` : '-'} | cov ${usable.length}/${t.matchups.length}`,
        );
      }
      const exp = c.expected[lane];
      if (exp) log(`    EXPECTED(daniil): ${exp}`);
      log('');
    }
  }

  // --- Evaluation set: rank-agreement statistics, no expectations, no tuning ---
  log('='.repeat(72));
  log('EVALUATION SET — 10 fresh drafts, rank comparison: A vs M vs W (no expectations)');
  // Metrics are computed per pair over the union lane pool. Semantics:
  //   sameTop1      — A#1 === M#1 (counted even when both lists are empty? no — only non-empty)
  //   top1Preserved — the A#1 hero is present anywhere in the M top-5
  //   overlapSum    — Σ |A∩M| over lanes (each list is exactly top-5)
  //   shiftSum      — Σ |Δrank| over heroes present in BOTH top-5s
  //   rho           — Spearman over shared top-5 heroes (ties = average ranks)
  const newPair = newPairStat;
  const statAM = newPair();
  const statAW = newPair();
  let rankShiftExamples = '';
  for (const ev of EVAL_CASES) {
    const ids: number[] = [];
    for (const n of ev.enemies) {
      const h = heroes.find((x) => x.name === n);
      if (!h) throw new Error(`Unknown hero name in eval case "${ev.name}": ${n}`);
      ids.push(h.id);
    }
    log(`\nEVAL ${ev.name}: ${ev.enemies.join(', ')}`);
    // No localStorage in node, so every run refetches — respect the OpenDota
    // rate limit with retries + backoff instead of skipping drafts.
    let matchupByEnemy = new Map<number, MatchupRow[]>();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const res = await getMatchupsMany(ids);
      matchupByEnemy = new Map<number, MatchupRow[]>();
      for (const [id, v] of res) if (Array.isArray(v)) matchupByEnemy.set(id, v);
      if (matchupByEnemy.size >= ids.length) break;
      if (attempt < 4) {
        log(`  matchup fetch incomplete (${matchupByEnemy.size}/${ids.length}) — retry ${attempt}/3 after 30s (rate limit)…`);
        await new Promise((r) => setTimeout(r, 30000));
      }
    }
    if (matchupByEnemy.size < ids.length) {
      log('  (matchup fetch failed after retries — skipped)');
      continue;
    }
    for (const lane of LANES) {
      const a = scoreCandidates({ heroes, enemyIds: ids, matchupByEnemy, heroById }, lane);
      const m = scoreCandidates({ heroes, enemyIds: ids, matchupByEnemy, heroById }, lane, { model: 'M' });
      const w = scoreCandidates({ heroes, enemyIds: ids, matchupByEnemy, heroById }, lane, { model: 'W' });
      accumulatePair(statAM, a, m);
      accumulatePair(statAW, a, w);
      // example log for the A/M pair only
      const byIdA = new Map(a.map((t) => [t.hero.id, t]));
      for (const t of m) {
        if (!byIdA.has(t.hero.id)) continue;
        const rA = a.findIndex((x) => x.hero.id === t.hero.id) + 1;
        const rM = m.indexOf(t) + 1;
        if (Math.abs(rA - rM) >= 2) {
          const line = `M moved ${t.hero.name} #${rA}→#${rM} in ${ev.name}/${laneLabel(lane)}`;
          if (!rankShiftExamples.includes(line)) rankShiftExamples += (rankShiftExamples ? '\n  ' : '  ') + line;
          break;
        }
      }
      const topA1 = a[0]?.hero.name ?? '—';
      const topM1 = m[0]?.hero.name ?? '—';
      log(`  ${laneLabel(lane).padEnd(10)} A#1 ${topA1.padEnd(18)} M#1 ${topM1.padEnd(18)} ${topA1 === topM1 ? 'same' : 'DIFF'}`);
    }
  }
  log('\nMETRIC TABLE over evaluation lanes (A vs M | A vs W):');
  const pct = (n: number, d: number) => `${n}/${d} (${Math.round((n / d) * 100)}%)`;
  log(`  Top-1 same                     ${pct(statAM.sameTop1, statAM.lanes)} | ${pct(statAW.sameTop1, statAW.lanes)}`);
  log(`  A#1 preserved in M top-5       ${pct(statAM.top1Preserved, statAM.lanes)} | ${pct(statAW.top1Preserved, statAW.lanes)}`);
  log(`  Top-5 overlap (avg heroes)     ${(statAM.overlapSum / statAM.lanes).toFixed(1)}/5 | ${(statAW.overlapSum / statAW.lanes).toFixed(1)}/5`);
  log(`  Mean |Δrank| (shared top-5)    ${(statAM.shiftSum / statAM.shiftHeroes).toFixed(2)} over ${statAM.shiftHeroes} heroes | ${(statAW.shiftSum / statAW.shiftHeroes).toFixed(2)} over ${statAW.shiftHeroes}`);
  log(`  Spearman ρ (shared top-5)      avg ${(statAM.rhoSum / statAM.rhoCount).toFixed(3)} over ${statAM.rhoCount} lanes | avg ${(statAW.rhoSum / statAW.rhoCount).toFixed(3)} over ${statAW.rhoCount}`);
  log(`  lanes with ≥2-rank movement    ${statAM.lanesWithShift}/${statAM.lanes} (A vs M; at most one example logged per lane)`);
  if (rankShiftExamples) log(rankShiftExamples);
}