/**
 * ТЗ §34 — zero-value semantic audit (pure functions).
 *
 * Question: can `STRATZ unitDamageType = 0` and `unitTargetTeam = 0/4` be read
 * through the named Valve enums without guessing?
 *
 * Two independent checks must both hold (§13):
 *   A — the authoritative Valve enum says what 0 means (NONE);
 *   B — the STRATZ raw-zero rows are behaviourally compatible with that meaning.
 * If B is violated, 0 stays SEMANTIC_UNKNOWN no matter what the enum says.
 *
 * This module never writes to the §32 mappings, never touches src/, and makes
 * no API calls: the research script feeds it cached rows only.
 */

/**
 * §1 — named Valve enums, quoted from the official Valve Developer Community
 * API page (developer.valvesoftware.com/wiki/API), as preserved by the Wayback
 * Machine capture of 2024-11-03. The page lists, verbatim:
 *
 *   DAMAGE_TYPES            DAMAGE_TYPE_NONE 0 / PHYSICAL 1 / MAGICAL 2 /
 *                           PURE 4 / ALL 7 / HP_REMOVAL 8 (deprecated)
 *   DOTA_UNIT_TARGET_TEAM   _NONE 0 / _FRIENDLY 1 / _ENEMY 2 / _BOTH 3 /
 *                           _CUSTOM 4
 *
 * The official Workshop Tools constants mirror corroborates the constant
 * NAMES (AbilityUnitDamageType, AbilityUnitTargetTeam sections exist); no
 * community enum tables are used.
 */
export const VALVE_ENUMS = {
  unitDamageType: {
    section: 'DAMAGE_TYPES',
    source: 'developer.valvesoftware.com/wiki/API (Valve Developer Community), capture 2024-11-03',
    values: { 0: 'NONE', 1: 'PHYSICAL', 2: 'MAGICAL', 4: 'PURE', 7: 'ALL', 8: 'HP_REMOVAL' },
  },
  unitTargetTeam: {
    section: 'DOTA_UNIT_TARGET_TEAM',
    source: 'developer.valvesoftware.com/wiki/API (Valve Developer Community), capture 2024-11-03',
    values: { 0: 'NONE', 1: 'FRIENDLY', 2: 'ENEMY', 3: 'BOTH', 4: 'CUSTOM' },
  },
};

/** §14 — the three states that must never be collapsed into one another. */
export const STATES = {
  ENUM_NONE: 'ENUM_NONE',
  ENUM_NAMED: 'ENUM_NAMED',
  FIELD_MISSING: 'FIELD_MISSING',
  SEMANTIC_UNKNOWN: 'SEMANTIC_UNKNOWN',
};

/** Row-level result of the §13B compatibility check. */
export const COMPAT = {
  COMPATIBLE: 'COMPATIBLE',
  CONFLICT: 'CONFLICT',
  INCONCLUSIVE: 'INCONCLUSIVE',
  FIELD_MISSING: 'FIELD_MISSING',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
};

/** §20 — audit verdicts. */
export const VERDICTS = {
  ZERO_SEMANTICS_CONFIRMED: 'ZERO_SEMANTICS_CONFIRMED',
  ZERO_SEMANTICS_PARTIAL: 'ZERO_SEMANTICS_PARTIAL',
  ZERO_SEMANTICS_UNKNOWN: 'ZERO_SEMANTICS_UNKNOWN',
  ZERO_SEMANTICS_CONFLICT: 'ZERO_SEMANTICS_CONFLICT',
};

/** OpenDota behavior is sometimes a bare string, sometimes an array. */
export function normalizeBehavior(behavior) {
  if (!behavior) return null;
  if (Array.isArray(behavior)) return behavior.length ? [...behavior] : null;
  if (typeof behavior === 'string' && behavior) return [behavior];
  return null;
}

/** OpenDota `target_type` is a comma-joined string: "Hero,Basic", "Tree". */
export function normalizeTargetTypes(targetType) {
  if (!targetType || typeof targetType !== 'string') return [];
  return targetType.split(',').map((t) => t.trim()).filter(Boolean);
}

const UNIT_TARGET_TYPES = new Set(['Hero', 'Basic', 'Creep', 'Building', 'Courier', 'Mechanical']);
const NON_UNIT_TARGET_TYPES = new Set(['Tree']);

/**
 * §14 — the raw value vs the named enum, with no data and no behaviour.
 *
 * FIELD_MISSING and ENUM_NONE are different states: a field that was not
 * returned is not a value of 0, and a value of 0 is not a missing field.
 */
export function semanticState(dimension, raw, enums = VALVE_ENUMS) {
  if (raw === null || raw === undefined) return { state: STATES.FIELD_MISSING, enumName: null };
  const values = enums[dimension]?.values ?? {};
  const name = values[String(raw)];
  if (name === undefined) return { state: STATES.SEMANTIC_UNKNOWN, enumName: null };
  if (name === 'NONE') return { state: STATES.ENUM_NONE, enumName: 'NONE' };
  return { state: STATES.ENUM_NAMED, enumName: name };
}

/**
 * §10/§11/§13B — is one raw-zero row compatible with the enum's NONE?
 *
 * Input: { dimension, raw, damage?, behavior?, targetType?, externalLabel? }
 *
 *   unitDamageType:
 *     CONFLICT    positive STRATZ damage, or a non-empty external dmg_type label
 *     COMPATIBLE  damage known-zero, or no damage signal at all (a candidate:
 *                 §3 buckets the evidence strength separately)
 *   unitTargetTeam:
 *     CONFLICT    external target_team label, or Unit Target behaviour aimed at
 *                 team-bound units (Hero/Basic/...)
 *     COMPATIBLE  behaviour present and no Unit Target at all
 *     INCONCLUSIVE  Unit Target aimed at non-unit types (Tree), Unit Target with
 *                 no type declared, or no behaviour available
 *
 * A missing raw value returns FIELD_MISSING — never confused with raw 0.
 * A non-zero raw value returns NOT_APPLICABLE: this check is about zeros only.
 */
export function classifyZeroCompatibility(e) {
  const { dimension, raw } = e;
  if (raw === null || raw === undefined) return COMPAT.FIELD_MISSING;
  if (Number(raw) !== 0) return COMPAT.NOT_APPLICABLE;

  const label = e.externalLabel;
  const hasLabel = label !== null && label !== undefined && label !== ''
    && !(Array.isArray(label) && label.length === 0);
  if (hasLabel) return COMPAT.CONFLICT; // second source names a semantics for this row

  if (dimension === 'unitDamageType') {
    const d = e.damage;
    if (Array.isArray(d)) {
      return d.some((v) => typeof v === 'number' && v > 0) ? COMPAT.CONFLICT : COMPAT.COMPATIBLE;
    }
    if (typeof d === 'number') return d > 0 ? COMPAT.CONFLICT : COMPAT.COMPATIBLE;
    return COMPAT.COMPATIBLE; // no damage signal: not contradicted (§3 buckets it)
  }

  if (dimension === 'unitTargetTeam') {
    const behavior = normalizeBehavior(e.behavior);
    if (!behavior) return COMPAT.INCONCLUSIVE;
    if (!behavior.includes('Unit Target')) return COMPAT.COMPATIBLE;
    const types = normalizeTargetTypes(e.targetType);
    if (!types.length) return COMPAT.INCONCLUSIVE;
    if (types.some((t) => UNIT_TARGET_TYPES.has(t))) return COMPAT.CONFLICT;
    return COMPAT.INCONCLUSIVE; // Tree-only edge, or no unit type declared
  }

  return COMPAT.INCONCLUSIVE;
}


/** Share of `count/denominator` in percent, one decimal; null when denominator is 0. */
function share(count, denominator) {
  return denominator ? Math.round((1000 * count) / denominator) / 10 : null;
}

function bucket(count, denominator) {
  return { count, denominator, pct: share(count, denominator) };
}

/**
 * §3 — evidence split for raw-zero damage rows, every percentage over an
 * explicit denominator (the raw-zero row count).
 */
export function damageEvidenceSummary(rows) {
  const list = rows ?? [];
  const total = list.length;
  let positive = 0;
  let zero = 0;
  let unknown = 0;
  for (const r of list) {
    const d = r?.damage;
    if (Array.isArray(d)) {
      if (d.some((v) => typeof v === 'number' && v > 0)) positive += 1;
      else zero += 1;
    } else if (typeof d === 'number') {
      if (d > 0) positive += 1;
      else zero += 1;
    } else {
      unknown += 1;
    }
  }
  return {
    total,
    damage_known_positive: bucket(positive, total),
    damage_known_zero: bucket(zero, total),
    damage_unknown: bucket(unknown, total),
  };
}

/**
 * §7 — evidence split for raw-zero target-team rows: how the behaviour of the
 * row itself lines up with the NONE hypothesis.
 */
export function targetEvidenceSummary(rows) {
  const list = rows ?? [];
  const total = list.length;
  let nonUnit = 0;
  let unitConflict = 0;
  let unknown = 0;
  for (const r of list) {
    const c = classifyZeroCompatibility({
      dimension: 'unitTargetTeam',
      raw: 0,
      behavior: r?.behavior ?? null,
      targetType: r?.targetType ?? null,
      externalLabel: r?.externalLabel ?? null,
    });
    if (c === COMPAT.COMPATIBLE) nonUnit += 1;
    else if (c === COMPAT.CONFLICT) unitConflict += 1;
    else unknown += 1;
  }
  return {
    total,
    non_unit_target: bucket(nonUnit, total),
    unit_target_conflict: bucket(unitConflict, total),
    inconclusive: bucket(unknown, total),
  };
}

/**
 * §9 — first `n` rows sorted by the stable key, no randomness anywhere.
 * Input order never matters; the sort happens on a copy.
 */
export function deterministicSample(rows, n, keyOf = (r) => String(r?.abilityKey ?? '')) {
  const sorted = [...(rows ?? [])].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  return sorted.slice(0, Math.max(0, n));
}

/**
 * §6 — hero concentration of a row set: is zero a systemic default or a
 * pattern concentrated in specific families?
 */
export function heroConcentration(rows, topN = 20) {
  const byHero = new Map();
  for (const r of rows ?? []) {
    const id = r?.heroId ?? null;
    const cur = byHero.get(id) ?? { heroId: id, displayName: r?.displayName ?? null, count: 0 };
    cur.count += 1;
    byHero.set(id, cur);
  }
  const heroes = [...byHero.values()]
    .sort((a, b) => b.count - a.count || String(a.heroId).localeCompare(String(b.heroId)));
  return { heroesAffected: heroes.length, top: heroes.slice(0, topN) };
}

/**
 * §20 — the verdict over the three independent checks: raw-zero damage,
 * raw-zero target team, and raw-4 target team.
 *
 * Each check is `{ conflicts, compatible, inconclusive, total }`:
 *   conflict       → row data contradicts the named enum meaning
 *   pass           → at least one compatible row and no conflict
 *   not evaluable  → nothing compatible and nothing conflicting
 */
export function zeroVerdict(checks) {
  const parts = [checks.damageZero, checks.targetZero, checks.targetFour].filter(Boolean);
  if (parts.some((c) => (c.conflicts ?? 0) > 0)) return VERDICTS.ZERO_SEMANTICS_CONFLICT;
  const passing = parts.filter((c) => (c.compatible ?? 0) > 0);
  if (parts.length && passing.length === parts.length) return VERDICTS.ZERO_SEMANTICS_CONFIRMED;
  if (passing.length > 0) return VERDICTS.ZERO_SEMANTICS_PARTIAL;
  return VERDICTS.ZERO_SEMANTICS_UNKNOWN;
}

/** Aggregate row-level classifications into the shape `zeroVerdict` expects. */
export function summarizeClassifications(classifications) {
  const out = { conflicts: 0, compatible: 0, inconclusive: 0, total: classifications.length };
  for (const c of classifications) {
    if (c === COMPAT.CONFLICT) out.conflicts += 1;
    else if (c === COMPAT.COMPATIBLE) out.compatible += 1;
    else out.inconclusive += 1;
  }
  return out;
}

