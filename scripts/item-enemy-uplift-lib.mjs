/**
 * TZ No.37 — Item x Enemy uplift research math (pure functions).
 *
 * Feasibility + identifiability research for the enemy layer:
 *
 *   BASELINE    E[Item | MyHero, Position]  (same grain, same corpus)
 *   OBSERVED    P(Item | Enemy, MyHero, Position-composition)  (marginal enemy)
 *   UPLIFT      observed − composition-weighted expected, shrunk + interval
 *
 * Capabilities (No.35/No.36) are closed and NOT used here. No wins-as-cause,
 * no Hero x Position x Enemy primary grain, no enemy pairs, no scoring
 * formula, no production writes.
 *
 * All functions are pure and deterministic: no filesystem, no fetch, no
 * global random state. Seeded RNG (mulberry32) and Benjamini–Hochberg are
 * REUSED from the No.36 library by import — never re-implemented.
 */
import { mulberry32, benjaminiHochberg } from './capability-item-prior-lib.mjs';

export { mulberry32, benjaminiHochberg };

/** TZ Sec.6 — fixed permutation budget. */
export const N_PERMUTATIONS = 2000;
/** TZ Sec.6 — fixed seed (20261006 per the approved TZ). No Math.random() anywhere in this pipeline. */
export const RESEARCH_SEED = 20261006;
/** TZ Sec.6 — FDR level, ONE pool per analysis type across all strata. */
export const FDR_Q = 0.05;

/** TZ Sec.5 — support tiers, fixed BEFORE the run from the sparsity audit. */
export const SUPPORT = {
  /** N_exposed >= 100: primary inference. */
  PRIMARY: 100,
  /** 30 <= N < 100: exploratory, LOW_SUPPORT flag, never a finding. */
  EXPLORATORY: 30,
};

/** TZ Sec.2 — canonical grain decision, recorded verbatim for the report. */
export const GRAIN_DECISION = Object.freeze({
  unit: 'Match x PlayerSlot x Item x EnemyHero',
  value: '1 = item present in end-state inventory (item0-5 + backpack0-2), else 0',
  ownershipVsEverPurchased: 'ownership-at-end: end-state inventory presence, NOT ever-purchased',
  consumables: 'excluded from primary: stackable catalogue items and zero-cost consumables',
  upgrades: 'final itemId only; components never duplicated as separate 1s',
  mirrorMatches: 'same hero on both sides is a legal enemy observation (no exclusion)',
  incompleteSlots: 'fail-closed: slot without 5 enemies or without inventory is dropped, never imputed',
  neutralItems: 'neutral0Id excluded: not a purchase decision',
  purchaseEvents: 'one slot contributes at most ONE observation per (item x enemy): no event fan-out',
});

/**
 * TZ Sec.2 — slot observation builder.
 *
 * One Match x PlayerSlot yields up to FIVE (item x enemy) observations per
 * owned item — one per enemy hero. The SLOT is the independent unit; the
 * fan-out to enemies is recorded, never multiplied into fake purchase events.
 *
 * slot: { matchId, heroId, position, isRadiant, inventory: number[],
 *         foes: number[5] }.
 * Returns { observations: [{ matchId, heroId, position, enemyHeroId, itemId }],
 *           dropped: null | { reason } }.
 * Fail-closed: foes.length !== 5 or missing inventory drops the slot.
 */
export function slotObservations(slot) {
  const foes = slot?.foes ?? null;
  const inv = slot?.inventory ?? null;
  if (!Array.isArray(foes) || foes.length !== 5) {
    return { observations: [], dropped: { reason: 'ENEMY_RECONSTRUCTION_FAILED' } };
  }
  if (!Array.isArray(inv)) {
    return { observations: [], dropped: { reason: 'MISSING_INVENTORY' } };
  }
  // Deterministic dedupe + order: one observation per (enemy, item).
  const items = [...new Set(inv.filter((x) => Number.isFinite(x)))].sort((a, b) => a - b);
  const foesSorted = [...new Set(foes)].sort((a, b) => a - b);
  const observations = [];
  for (const enemyHeroId of foesSorted) {
    for (const itemId of items) {
      observations.push({ matchId: slot.matchId, heroId: slot.heroId, position: slot.position, enemyHeroId, itemId });
    }
  }
  return { observations, dropped: null };
}

/**
 * TZ Sec.3 — composition-weighted baseline for ONE (item, enemy) cell.
 *
 * exposed: [{ heroId, position }] — the slots that actually faced the enemy.
 * hpRate: Map 'heroId|position' -> ownership rate of the item in the SAME
 *         corpus (all enemies). Slots whose key is absent contribute nothing
 *         and are counted as uncovered (never imputed as 0).
 *
 * p_exp = mean over COVERED exposed slots of hpRate(key).
 * This is the anti-confound core: the baseline follows the EXPOSED
 * composition instead of a global item average.
 */
export function weightedBaseline(exposed, hpRate) {
  // Accept slot objects ({ heroId, position }), shorthand { hp }, or raw keys.
  const keyOf = (s) => (typeof s === 'string' ? s : (s?.hp ?? s?.key ?? `${s?.heroId}|${s?.position}`));
  let sum = 0;
  let covered = 0;
  for (const s of exposed ?? []) {
    const r = hpRate.get(keyOf(s));
    if (Number.isFinite(r)) {
      sum += r;
      covered += 1;
    }
  }
  const n = (exposed ?? []).length;
  return {
    expected: covered > 0 ? sum / covered : NaN,
    nExposed: n, n, nCovered: covered, covered,
  };
}

/** TZ Sec.4 — raw uplift components. lift is null (not 1, not Inf) when p_exp is 0. */
export function rawUplift(kExposed, nExposed, expected) {
  const observed = nExposed > 0 ? kExposed / nExposed : NaN;
  const delta = Number.isFinite(observed) && Number.isFinite(expected) ? observed - expected : NaN;
  const lift = Number.isFinite(observed) && expected > 0 ? observed / expected : null;
  return { observed, expected, delta, lift };
}

/**
 * TZ Sec.5 — empirical-Bayes Beta-Binomial shrinkage of the exposed rate
 * toward the composition-weighted baseline. Prior strength m0 is estimated
 * from the Hero x Position rate dispersion of THIS item (method of moments,
 * clamped to [8, 200] pseudo-observations). Posterior mean:
 *   p_shrunk = (K + a0) / (N + a0 + b0),  a0 = m0*p0, b0 = m0*(1-p0).
 */
export function hpPriorStrength(hpRates) {
  const rs = (hpRates ?? []).filter((r) => Number.isFinite(r) && r > 0 && r < 1);
  if (rs.length < 2) return { m0: 8, note: 'DEGENERATE_PRIOR' };
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  const variance = rs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / rs.length;
  const between = variance - (mean * (1 - mean)) / 50;
  if (!(between > 0)) return { m0: 200, note: 'HOMOGENEOUS_RATES' };
  return { m0: Math.min(200, Math.max(8, (mean * (1 - mean)) / between)), note: 'OK' };
}

export function shrinkRate(kExposed, nExposed, expected, m0) {
  if (!(nExposed > 0) || !Number.isFinite(expected)) {
    return { shrunk: NaN, shrunkDelta: NaN, a0: NaN, b0: NaN };
  }
  const p0 = Math.min(1 - 1e-9, Math.max(1e-9, expected));
  const a0 = m0 * p0;
  const b0 = m0 * (1 - p0);
  const shrunk = (kExposed + a0) / (nExposed + a0 + b0);
  return { shrunk, shrunkDelta: shrunk - expected, a0, b0 };
}

/**
 * TZ No.37 Sec.3 — production position gate (share >= 8%, games >= 500).
 * The SAME gate production uses: a Hero x Position cell is eligible only
 * when the positions catalogue shows it at >= 8% share AND >= 500 games.
 * Ineligible slots are dropped in buildSlots BEFORE they can reach
 * exposure, background rates, the weighted baseline or permutation strata.
 */
export function eligibleHpSet(positions) {
  const set = new Set();
  for (const [rawHero, entry] of Object.entries(positions ?? {})) {
    for (const [pos, cell] of Object.entries(entry?.positions ?? {})) {
      if ((cell?.share ?? 0) >= 0.08 && (cell?.games ?? 0) >= 500) set.add(`${rawHero}|${pos}`);
    }
  }
  return set;
}

/**
 * Slot-level gate check: null when the Hero x Position passes, otherwise
 * the fail-closed drop reason. A missing gate set is itself a failure —
 * the gate must never silently pass everything.
 */
export function positionGateDropReason(eligibleHp, heroId, position) {
  if (!(eligibleHp instanceof Set)) return 'POSITION_GATE_MISSING';
  return eligibleHp.has(`${heroId}|${position}`) ? null : 'POSITION_NOT_ELIGIBLE';
}

/** TZ Sec.5 — tier gate. EXCLUDED cells never enter inference. */
export function supportTier(nExposed) {
  if (nExposed >= SUPPORT.PRIMARY) return 'PRIMARY';
  if (nExposed >= SUPPORT.EXPLORATORY) return 'EXPLORATORY_LOW_SUPPORT';
  return 'EXCLUDED';
}

/** TZ Sec.6 stability — deterministic split-half: even matchId -> A. */
export function splitHalf(matchId) {
  return Number(matchId) % 2 === 0 ? 'A' : 'B';
}

/**
 * TZ Sec.5 — Clopper–Pearson exact interval for the exposed ownership rate.
 * No normal approximation at small N.
 *
 * Direct binomial-tail inversion (no incomplete-beta machinery): lo is the
 * largest p with P(X >= k | p) >= alpha/2; hi is the smallest p with
 * P(X <= k | p) >= alpha/2. Log-domain summation keeps it exact for the
 * N <= low-thousands regime of this research; 120 bisection steps make the
 * bounds deterministic to ~1e-12.
 */
function binomTailGe(k, n, p) {
  if (p <= 0) return k <= 0 ? 1 : 0;
  if (p >= 1) return 1;
  const logP = Math.log(p);
  const logQ = Math.log(1 - p);
  // log pmf(0), then forward recurrence in log-domain.
  let logPmf = n * logQ;
  let tail = k === 0 ? 1 : 0;
  let pmf = Math.exp(logPmf);
  for (let x = 1; x <= n; x += 1) {
    pmf *= ((n - x + 1) / x) * (p / (1 - p));
    if (x >= k) {
      tail += pmf;
      if (pmf < 1e-16 * tail && x > k) break;
    }
  }
  return Math.min(1, tail);
}

function binomTailLe(k, n, p) {
  return 1 - binomTailGe(k + 1, n, p);
}

export function clopperPearson(k, n, alpha = 0.05) {
  if (!(n > 0) || !(k >= 0) || !(k <= n)) return { lo: NaN, hi: NaN };
  if (k === 0) return { lo: 0, hi: 1 - Math.pow(alpha / 2, 1 / n) };
  if (k === n) return { lo: Math.pow(alpha / 2, 1 / n), hi: 1 };
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 120; i += 1) {
    const mid = (lo + hi) / 2;
    if (binomTailGe(k, n, mid) >= alpha / 2) hi = mid;
    else lo = mid;
  }
  const loB = (lo + hi) / 2;
  lo = 0;
  hi = 1;
  for (let i = 0; i < 120; i += 1) {
    const mid = (lo + hi) / 2;
    if (binomTailLe(k, n, mid) >= alpha / 2) lo = mid;
    else hi = mid;
  }
  return { lo: loB, hi: (lo + hi) / 2 };
}

/**
 * TZ Sec.6 — Hero x Position-STRATIFIED permutation test for the
 * composition-adjusted gap (No.37 core audit fix: pooling exposed and
 * background slots of DIFFERENT Hero x Position strata into one shuffle let
 * the stratum composition leak into the null distribution).
 *
 * Input: ONE entry per Hero x Position stratum of the cell, in a
 * deterministic (sorted) order:
 *   { values: 0/1[], isExposed: bool[], baseline }
 * baseline = E[Item | that Hero, Position] from the corpus background, so
 * every stratum carries its own reference rate. Statistic (exactly the
 * composition-weighted gap equal to rawUplift().delta):
 *   stat = SUM_s (nE_s / totalE) * (meanE_s - baseline_s)
 * Permutations shuffle the exposed/background ASSIGNMENT ONLY inside each
 * stratum with that stratum's exposed count held fixed — the exposed
 * Hero x Position composition is invariant under the null BY CONSTRUCTION,
 * so composition can never leak into the p-value.
 * p = (#{|perm stat| >= |observed|} + 1) / (N + 1).
 *
 * Constant strata admit no shuffle: if EVERY stratum is constant every
 * permutation reproduces the observed gap, so p = 1 is returned WITHOUT
 * consuming rng draws (No.36 convention). Strata with no background
 * (nB_s = 0) contribute their fixed term only.
 */
export function upliftPermutationTest(strata, nPerms, rng) {
  return stratifiedPermutation(strata, nPerms, rng, false);
}

/**
 * Same test, plus exposedCounts: exposedCounts[perm][s] = number of exposed
 * slots in stratum s under permutation perm. The regression test asserts that
 * every row equals the OBSERVED per-stratum exposed counts — direct proof
 * that no draw ever moves a slot between Hero x Position strata (a pooled
 * implementation cannot satisfy this). Constant cells consume no draws and
 * return an empty trace.
 */
export function stratifiedPermutationTrace(strata, nPerms, rng) {
  return stratifiedPermutation(strata, nPerms, rng, true);
}

function stratifiedPermutation(strata, nPerms, rng, trace) {
  const empty = {
    observed: NaN, p: NaN, nE: 0, nB: 0, perms: nPerms,
    ...(trace ? { exposedCounts: [] } : {}),
  };
  if (!Array.isArray(strata) || strata.length === 0) return empty;
  const stats = [];
  let totalE = 0;
  let total = 0;
  for (const s of strata) {
    const v = s?.values;
    const l = s?.isExposed;
    if (!Array.isArray(v) || !Array.isArray(l) || v.length !== l.length
      || v.length === 0 || !Number.isFinite(s?.baseline)) return empty;
    let nE = 0;
    for (let i = 0; i < v.length; i += 1) {
      if (v[i] !== 0 && v[i] !== 1) return empty;
      if (l[i]) nE += 1;
    }
    if (nE === 0) return empty;
    let eSum = 0;
    for (let i = 0; i < v.length; i += 1) if (l[i]) eSum += v[i];
    stats.push({ v, n: v.length, nE, meanE: eSum / nE, baseline: s.baseline });
    totalE += nE;
    total += v.length;
  }
  const nB = total - totalE;
  if (!(nB > 0)) return { ...empty, nE: totalE, nB: 0 };
  // Observed = composition-weighted gap (== rawUplift delta).
  let observed = 0;
  let constant = true;
  for (const st of stats) {
    observed += (st.nE / totalE) * (st.meanE - st.baseline);
    for (let i = 1; i < st.v.length; i += 1) {
      if (st.v[i] !== st.v[0]) {
        constant = false;
        break;
      }
    }
  }
  if (constant) {
    // Every stratum is constant: all permutations reproduce the observed gap.
    return {
      observed, p: 1, nE: totalE, nB, perms: nPerms,
      ...(trace ? { exposedCounts: [] } : {}),
    };
  }
  let ge = 0;
  const exposedCounts = trace ? [] : null;
  for (let r = 0; r < nPerms; r += 1) {
    let stat = 0;
    const counts = trace ? [] : null;
    for (const st of stats) {
      let sum = 0;
      if (st.n - st.nE === 0) {
        sum = st.meanE * st.nE; // nothing to shuffle in this stratum
      } else {
        const work = new Uint32Array(st.n);
        for (let i = 0; i < st.n; i += 1) work[i] = i;
        for (let i = 0; i < st.nE; i += 1) {
          const j = i + Math.floor(rng() * (st.n - i));
          const t = work[i];
          work[i] = work[j];
          work[j] = t;
        }
        for (let i = 0; i < st.nE; i += 1) sum += st.v[work[i]];
      }
      stat += (st.nE / totalE) * (sum / st.nE - st.baseline);
      if (counts) counts.push(st.nE); // stratum membership never changes
    }
    if (Math.abs(stat) >= Math.abs(observed) - 1e-12) ge += 1;
    if (exposedCounts) exposedCounts.push(counts);
  }
  const out = { observed, p: (ge + 1) / (nPerms + 1), nE: totalE, nB, perms: nPerms };
  if (exposedCounts) out.exposedCounts = exposedCounts;
  return out;
}

/**
 * TZ Sec.11 — verdict selector. Takes MEASURED counts, never raw tables, so
 * the mapping from evidence to verdict is itself unit-testable:
 *   FEASIBLE: primary coverage exists AND stable FDR-controlled signals exist
 *   SPOTTY:   signals exist but are unstable or exploratory-only
 *   SPARSE:   no primary cell reaches support (grain breaks before inference)
 *   ABSENT:   coverage is adequate and nothing survives FDR
 */
export const UPLIFT_VERDICTS = {
  FEASIBLE: 'ENEMY_UPLIFT_FEASIBLE',
  SPOTTY: 'ENEMY_UPLIFT_SPOTTY',
  SPARSE: 'ENEMY_UPLIFT_SPARSE',
  ABSENT: 'ENEMY_UPLIFT_ABSENT',
};

export function decideUpliftVerdict({ primaryCells = 0, stableHits = 0, exploratoryHits = 0 } = {}) {
  if (!(primaryCells > 0)) return UPLIFT_VERDICTS.SPARSE;
  if (stableHits > 0) return UPLIFT_VERDICTS.FEASIBLE;
  if (exploratoryHits > 0) return UPLIFT_VERDICTS.SPOTTY;
  return UPLIFT_VERDICTS.ABSENT;
}
