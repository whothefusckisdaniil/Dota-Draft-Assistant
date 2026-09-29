/**
 * Pure helpers for ТЗ §24 — position validation on parsed public matches.
 *
 * No network, no filesystem, no side effects, so the maths can be unit-tested.
 *
 * The vocabulary here is deliberately careful: we can measure how often two
 * FIELDS agree. We cannot measure accuracy, because neither `lane_role` nor
 * `position_est` is ground truth — one is parsed, the other is computed.
 */

/** The project's own position labels (src/config.ts). For reporting only. */
export const PROJECT_POSITIONS = {
  1: 'Carry', 2: 'Mid', 3: 'Offlane', 4: 'Soft Support', 5: 'Hard Support',
};

const asPos = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** §6 — a value is a valid position only if it is an integer in 1..5. */
export function isValidPosition(v) {
  const n = asPos(v);
  return n !== null && Number.isInteger(n) && n >= 1 && n <= 5;
}

/** §6 — describe a value without ever normalising it into a valid position. */
export function describeValue(v) {
  const n = asPos(v);
  if (n === null) return 'missing';
  if (!Number.isInteger(n)) return `non_integer(${n})`;
  if (n < 1 || n > 5) return `out_of_range(${n})`;
  return `valid(${n})`;
}

/** §4/§8 — how many player rows carry each field. */
export function fieldCoverage(rows, field) {
  let present = 0;
  let valid = 0;
  for (const r of rows) {
    const v = r?.[field];
    if (v != null) present += 1;
    if (isValidPosition(v)) valid += 1;
  }
  return { total: rows.length, present, valid, ratio: rows.length ? present / rows.length : 0 };
}

/** §5 — confusion matrix over rows where BOTH fields exist. */
export function confusionMatrix(rows, a = 'lane_role', b = 'position_est') {
  const pairs = new Map();
  let both = 0, same = 0, onlyA = 0, onlyB = 0, neither = 0;
  for (const r of rows) {
    const av = asPos(r?.[a]);
    const bv = asPos(r?.[b]);
    if (av !== null && bv !== null) {
      both += 1;
      if (av === bv) same += 1;
      const k = `${av}|${bv}`;
      pairs.set(k, (pairs.get(k) ?? 0) + 1);
    } else if (av !== null) onlyA += 1;
    else if (bv !== null) onlyB += 1;
    else neither += 1;
  }
  return {
    matrix: Object.fromEntries([...pairs.entries()].sort((x, y) => y[1] - x[1])),
    total: rows.length, both, same, onlyA, onlyB, neither,
    // FIELD AGREEMENT, never "accuracy": there is no ground truth to score against.
    agreement: both > 0 ? same / both : null,
  };
}

/** §10 — is a match structurally sane (10 players, 5 per team)? */
export function teamStructure(players) {
  const radiant = players.filter((p) => p.player_slot < 128);
  const dire = players.filter((p) => p.player_slot >= 128);
  return {
    total: players.length,
    radiant: radiant.length,
    dire: dire.length,
    sane: players.length === 10 && radiant.length === 5 && dire.length === 5,
  };
}

/** Value counts for one field, outliers bucketed separately (never dropped). */
export function valueDistribution(rows, field) {
  const out = { valid: {}, outliers: {}, missing: 0 };
  for (const r of rows) {
    const d = describeValue(r?.[field]);
    if (d === 'missing') { out.missing += 1; continue; }
    if (d.startsWith('valid(')) {
      const n = Number(d.slice(6, -1));
      out.valid[n] = (out.valid[n] ?? 0) + 1;
    } else {
      out.outliers[d] = (out.outliers[d] ?? 0) + 1;
    }
  }
  return out;
}

/** §13 — how ambiguous is a hero's position signal? */
export function heroAmbiguity(rows, heroIds, a = 'lane_role', b = 'position_est') {
  return heroIds.map((id) => {
    const sub = rows.filter((r) => r.hero_id === id);
    const av = [...new Set(sub.map((r) => asPos(r?.[a])).filter((v) => isValidPosition(v)))].sort();
    const bv = [...new Set(sub.map((r) => asPos(r?.[b])).filter((v) => isValidPosition(v)))].sort();
    return {
      heroId: id,
      n: sub.length,
      laneRoleValues: av,
      positionEstValues: bv,
      // "conflicts" = heroes observed on more than one position by a field.
      laneRoleAmbiguous: av.length > 1,
      positionEstAmbiguous: bv.length > 1,
    };
  }).sort((x, y) => y.n - x.n);
}

/** §14 — compare a numeric distribution between two halves of the corpus. */
export function distributionDelta(first, second) {
  const keys = [...new Set([...Object.keys(first), ...Object.keys(second)])].sort((a, b) => Number(a) - Number(b));
  const totalF = Object.values(first).reduce((s, v) => s + v, 0);
  const totalS = Object.values(second).reduce((s, v) => s + v, 0);
  return keys.map((k) => ({
    value: Number(k),
    shareFirst: totalF ? (first[k] ?? 0) / totalF : null,
    shareSecond: totalS ? (second[k] ?? 0) / totalS : null,
    delta: totalF && totalS ? (first[k] ?? 0) / totalF - (second[k] ?? 0) / totalS : null,
  }));
}
