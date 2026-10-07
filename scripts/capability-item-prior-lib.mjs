/**
 * TZ No.36 — Capability x ItemPrior research math (pure functions).
 *
 * Controlled experiment: does the coarse hero capability profile (TZ No.35 v2)
 * separate the EXISTING ItemPrior distributions once position is stratified?
 *
 * All functions here are pure and deterministic: no filesystem, no fetch,
 * no global random state. The permutation RNG (mulberry32) always takes an
 * explicit seed — TZ fixes N = 2000, seed = 20261006.
 *
 * No enemy draft, no Hero x Enemy, no wins-as-cause, no new capability weights
 * (Sec.1). No production files are touched; this library only computes numbers.
 */

/** TZ Sec.7 — fixed permutation budget. */
export const N_PERMUTATIONS = 2000;
/** TZ Sec.7 — fixed seed. No Math.random() anywhere in this pipeline. */
export const RESEARCH_SEED = 20261006;
/** TZ Sec.10 — minimum Hero x Position cells per TRUE/FALSE group. */
export const MIN_GROUP_SUPPORT = 10;
/** TZ Sec.9 — FDR level, one BH pool per analysis type (not per position). */
export const FDR_Q = 0.05;

/**
 * Seeded 32-bit RNG (mulberry32). Returns () => float in [0, 1).
 * Same seed gives the same stream, byte-identical across runs and machines.
 */
export function mulberry32(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * TZ Sec.2 — production position gate (same thresholds as
 * POSITION_ELIGIBILITY / positionIntersection): share >= 8%, games >= 500.
 * Returns [{ heroId, position }] sorted by (position, heroId) so every
 * downstream traversal is order-stable.
 */
export function eligibleCells(positionsJson, { minShare = 0.08, minGames = 500 } = {}) {
  const out = [];
  for (const [rawHeroId, entry] of Object.entries(positionsJson ?? {})) {
    const heroId = Number(rawHeroId);
    if (!Number.isFinite(heroId)) continue;
    for (const [position, cell] of Object.entries(entry?.positions ?? {})) {
      if ((cell?.share ?? 0) >= minShare && (cell?.games ?? 0) >= minGames) {
        out.push({ heroId, position: String(position) });
      }
    }
  }
  out.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : a.heroId - b.heroId));
  return out;
}

/**
 * TZ Sec.5 — top-K membership over an ALREADY sorted id list.
 * No new ranking is invented: the caller passes getItemPrior() order.
 */
export function topKSet(sortedIds, k) {
  return new Set((sortedIds ?? []).slice(0, Math.max(0, k)));
}

/** abs(TRUE_rate - FALSE_rate). Pure arithmetic. */
export function differenceInRates(tHits, tN, fHits, fN) {
  if (!(tN > 0) || !(fN > 0)) return NaN;
  return Math.abs(tHits / tN - fHits / fN);
}

/** abs(meanTRUE - meanFALSE) over pre-aggregated sums. Pure arithmetic. */
export function differenceInMeans(tSum, tN, fSum, fN) {
  if (!(tN > 0) || !(fN > 0)) return NaN;
  return Math.abs(tSum / tN - fSum / fN);
}


/**
 * TZ Sec.5 — per-item TRUE/FALSE top-K rates inside ONE position stratum.
 *
 * cells:  [{ key, top: Set<itemId> }] in a fixed order (caller sorts by key).
 * labels: Map key -> 'TRUE' | 'FALSE'. UNKNOWN keys must already be removed —
 *         UNKNOWN is never coerced to FALSE (Sec.3, acceptance criteria).
 * universe: item ids to test, sorted ascending by the caller.
 *
 * Groups below MIN_GROUP_SUPPORT yield NaN rates and are flagged by the
 * caller as INSUFFICIENT_SUPPORT (Sec.10) — never silently tested.
 */
export function groupItemRates(cells, labels, universe) {
  const tIdx = [];
  const fIdx = [];
  for (let i = 0; i < cells.length; i += 1) {
    const lab = labels.get(cells[i].key);
    if (lab === 'TRUE') tIdx.push(i);
    else if (lab === 'FALSE') fIdx.push(i);
  }
  const nT = tIdx.length;
  const nF = fIdx.length;
  const supported = nT >= MIN_GROUP_SUPPORT && nF >= MIN_GROUP_SUPPORT;
  return (universe ?? []).map((itemId) => {
    if (!supported) {
      return { itemId, trueRate: NaN, falseRate: NaN, delta: NaN, nT, nF, tHits: 0, fHits: 0 };
    }
    let tHits = 0;
    for (const i of tIdx) if (cells[i].top.has(itemId)) tHits += 1;
    let fHits = 0;
    for (const i of fIdx) if (cells[i].top.has(itemId)) fHits += 1;
    return { itemId, trueRate: tHits / nT, falseRate: fHits / nF, delta: tHits / nT - fHits / nF, nT, nF, tHits, fHits };
  });
}

/**
 * TZ Sec.6 — mean ItemPrior.score per group, ONLY over cells where the item
 * row exists. A missing row is never score=0; cells without the item
 * contribute nothing to either sum. Support rule applied to the OBSERVED
 * cell counts of each group (Sec.10).
 *
 * cells: [{ key, scores: Map<itemId, score> }], labels/universe as above.
 */
export function meanObservedItemScore(cells, labels, universe) {
  const tIdx = [];
  const fIdx = [];
  for (let i = 0; i < cells.length; i += 1) {
    const lab = labels.get(cells[i].key);
    if (lab === 'TRUE') tIdx.push(i);
    else if (lab === 'FALSE') fIdx.push(i);
  }
  return (universe ?? []).map((itemId) => {
    let tSum = 0;
    let tN = 0;
    for (const i of tIdx) {
      const s = cells[i].scores.get(itemId);
      if (Number.isFinite(s)) {
        tSum += s;
        tN += 1;
      }
    }
    let fSum = 0;
    let fN = 0;
    for (const i of fIdx) {
      const s = cells[i].scores.get(itemId);
      if (Number.isFinite(s)) {
        fSum += s;
        fN += 1;
      }
    }
    if (tN < MIN_GROUP_SUPPORT || fN < MIN_GROUP_SUPPORT) {
      return { itemId, meanT: NaN, meanF: NaN, delta: NaN, nT: tN, nF: fN };
    }
    return { itemId, meanT: tSum / tN, meanF: fSum / fN, delta: tSum / tN - fSum / fN, nT: tN, nF: fN };
  });
}

/**
 * Draw a uniform random k-subset of {0..n-1} via partial Fisher-Yates.
 * Consumes exactly k RNG draws.
 */
export function randomSubset(rng, n, k) {
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i += 1) idx[i] = i;
  const take = Math.max(0, Math.min(k, n));
  for (let i = 0; i < take; i += 1) {
    const j = i + Math.floor(rng() * (n - i));
    const tmp = idx[i];
    idx[i] = idx[j];
    idx[j] = tmp;
  }
  return idx.slice(0, take);
}


/**
 * TZ Sec.7-8 — within-position permutation test for a two-group difference.
 *
 * values: number[] aligned with isTrue (one entry per stratum cell).
 * isTrue: boolean[] — TRUE group membership (FALSE = complement; UNKNOWN
 *         entries must already be excluded by the caller).
 * nPerms: permutation budget (TZ fixes 2000). rng: seeded stream.
 *
 * Null: the label carries no information. Labels are shuffled INSIDE the
 * single stratum, preserving the position distribution by construction.
 * Test statistic: abs(meanTRUE - meanFALSE) — the same form serves top-K
 * rates (0/1 values) and observed scores.
 * p = (#{shuffled >= observed} + 1) / (N + 1). No normal approximation.
 *
 * Constant vectors short-circuit to p = 1 WITHOUT consuming RNG draws, so
 * universal/never-bought items cost nothing and cannot disturb the stream.
 * Degenerate input (empty group) returns NaN — never a fabricated p-value.
 */
export function permutationTest(values, isTrue, nPerms, rng) {
  const n = values.length;
  let nT = 0;
  for (const b of isTrue) if (b) nT += 1;
  const nF = n - nT;
  if (!(nT > 0) || !(nF > 0) || n !== isTrue.length) {
    return { observed: NaN, p: NaN, nT, nF, perms: nPerms };
  }
  let total = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) return { observed: NaN, p: NaN, nT, nF, perms: nPerms };
    total += v;
  }
  let tSum = 0;
  for (let i = 0; i < n; i += 1) if (isTrue[i]) tSum += values[i];
  const observed = Math.abs(tSum / nT - (total - tSum) / nF);
  let constant = true;
  for (let i = 1; i < n; i += 1) {
    if (values[i] !== values[0]) {
      constant = false;
      break;
    }
  }
  if (constant) return { observed: 0, p: 1, nT, nF, perms: nPerms };
  let ge = 0;
  for (let r = 0; r < nPerms; r += 1) {
    const pick = randomSubset(rng, n, nT);
    let s = 0;
    for (const i of pick) s += values[i];
    const stat = Math.abs(s / nT - (total - s) / nF);
    if (stat >= observed - 1e-12) ge += 1;
  }
  return { observed, p: (ge + 1) / (nPerms + 1), nT, nF, perms: nPerms };
}

/**
 * TZ Sec.9 — Benjamini-Hochberg FDR over ONE analysis type's full hypothesis
 * pool (all positions together, never per-position).
 * entries: [{ key, p }] with finite p. Returns [{ key, p, q }] in the INPUT
 * order; rank ties are broken by key so the correction is deterministic.
 * Monotone step-up: q[i] = min over j>=i of p[j]*m/j, capped at 1.
 */
export function benjaminiHochberg(entries) {
  const m = entries.length;
  if (m === 0) return [];
  const order = entries.map((_, i) => i).sort((a, b) => {
    const dp = entries[a].p - entries[b].p;
    if (dp !== 0) return dp;
    const ka = String(entries[a].key);
    const kb = String(entries[b].key);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const q = new Array(m);
  let running = 1;
  for (let r = m - 1; r >= 0; r -= 1) {
    const i = order[r];
    const v = (entries[i].p * m) / (r + 1);
    if (v < running) running = v;
    q[i] = Math.min(running, 1);
  }
  return entries.map((e, i) => ({ ...e, q: q[i] }));
}
