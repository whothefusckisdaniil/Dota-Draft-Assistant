/**
 * Ability property helpers (ТЗ §31).
 *
 * The audit exists because schema availability, data population and analytical
 * usefulness are three DIFFERENT claims. Measured on 868 STRATZ abilities:
 *
 *   dispellable        866/868  STRING enum YES/NO/NONE   -> semantics self-evident
 *   isInnate           866/868  boolean                  -> semantics self-evident
 *   unitDamageType     866/868  INTEGER {0,1,2,4}       -> NO enum type in schema
 *   unitTargetTeam     866/868  INTEGER {0,1,2,3,4}     -> NO enum type in schema
 *   unitTargetFlags    866/868  INTEGER bitmask, 13 vals-> NO bit docs in schema
 *   damage              28/868  ARRAY of ints           -> 97% unknown
 *   castRange          349/868  ARRAY of ints           -> 60% unknown
 *   duration           866/868  MIXED array/string      -> heterogeneous
 *
 * The fields with the richest semantics are the least discriminative, and the
 * most discriminative-looking fields carry NO authoritative mapping. Nothing
 * here invents one: a feature whose meaning depends on interpreting a bare
 * integer is reported `unknown`, never `true` and never `available`.
 */

/** §22 — four confidence states, kept distinct. */
export const CONFIDENCE = {
  SCHEMA_ONLY: 'SCHEMA_ONLY',
  PARTIALLY_POPULATED: 'PARTIALLY_POPULATED',
  FULLY_POPULATED: 'FULLY_POPULATED',
  UNINFORMATIVE: 'UNINFORMATIVE',
};

/** §3 — candidate fields. `isUltimate`/`isTalent` excluded on purpose (§7 of #30.1). */
export const PROPERTY_FIELDS = [
  'damage', 'unitDamageType', 'duration', 'castRange',
  'unitTargetTeam', 'unitTargetFlags', 'dispellable', 'isInnate',
];

/** Fields whose meaning is a bare integer with no enum declared in the schema. */
export const SEMANTICALLY_OPAQUE = new Set([
  'unitDamageType', 'unitTargetTeam', 'unitTargetFlags', 'spellImmunity',
]);

/** A scalar and a 1-element array are different values; keep the source shape. */
function stableKey(v) {
  return Array.isArray(v) ? `[${v.join(',')}]`
    : (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v));
}

/**
 * Preserve source shape, drop non-abilities. `null` is stored, never defaulted.
 *
 * The properties live under `ability.stat`, NOT at the top level of the ability.
 * Reading them from the top level silently yields all-nulls: every coverage
 * number comes out 0/868 while the source is in fact fully populated. A test
 * pins the real nested shape.
 */
export function normalizeAbilityProperties(ability) {
  if (!ability || typeof ability !== 'object') return null;
  if (ability.id === undefined || ability.id === null) return null;
  const stat = ability.stat ?? {};
  const out = { id: Number(ability.id), name: ability.name ?? null };
  for (const f of PROPERTY_FIELDS) out[f] = stat[f] ?? null;
  return out;
}

/**
 * §3/§20 — population audit for one field.
 *
 * `null` is counted apart from `false` and from `0`: a field that was not
 * returned is not a negative value, and `damage = 0` is not "no damage".
 */
export function valueCoverage(rows, field) {
  const values = (rows ?? []).map((r) => r?.[field]);
  const nonNull = values.filter((v) => v !== null && v !== undefined);
  const nulls = values.length - nonNull.length;
  const distinct = [...new Set(nonNull.map(stableKey))].sort();
  return {
    field,
    total: values.length,
    nonNull: nonNull.length,
    null: nulls,
    nullPct: values.length ? (100 * nulls) / values.length : null,
    distinct: distinct.length,
    falsy: nonNull.filter((v) => v === false || v === 0 || v === '').length,
    isBoolean: nonNull.length > 0 && nonNull.every((v) => typeof v === 'boolean'),
    isArray: nonNull.length > 0 && nonNull.every(Array.isArray),
    isNumeric: nonNull.length > 0 && nonNull.every((v) => typeof v === 'number'),
    values: distinct,
  };
}


/** §5/§6 — frequency table for a categorical field, nulls kept separate. */
export function categoricalDistribution(rows, field) {
  const counts = new Map();
  let nulls = 0;
  for (const r of rows ?? []) {
    const v = r?.[field];
    if (v === null || v === undefined) { nulls += 1; continue; }
    const k = stableKey(v);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const known = [...counts.values()].reduce((a, b) => a + b, 0);
  return {
    field,
    total: (rows ?? []).length,
    nulls,
    unknown: (rows ?? []).length - known,
    known,
    entries: [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([value, count]) => ({ value, count, share: known ? count / known : null })),
  };
}

/** §8/§9/§20 — numeric distribution. Non-numeric values are never coerced. */
export function numericDistribution(rows, field) {
  const all = rows ?? [];
  const vals = all.map((r) => r?.[field]).filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!vals.length) return { field, n: 0, min: null, max: null, percentiles: {}, bins: [] };
  const sorted = [...vals].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const EDGES = [300, 600, 900];
  const LABELS = ['0', '0 < x <= 300', '300-600', '600-900', '900+'];
  const bins = [{ label: LABELS[0], count: sorted.filter((v) => v === 0).length }];
  for (let i = 0; i < EDGES.length; i += 1) {
    const lo = EDGES[i - 1] ?? 0;
    const hi = EDGES[i];
    bins.push({ label: LABELS[i + 1], count: sorted.filter((v) => v > lo && v <= hi).length });
  }
  bins.push({ label: LABELS[4], count: sorted.filter((v) => v > 900).length });
  return {
    field,
    n: sorted.length,
    null: all.length - all.filter((r) => typeof r?.[field] === 'number').length,
    unknown: all.length - sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    percentiles: { p10: at(0.1), p25: at(0.25), p50: at(0.5), p75: at(0.75), p90: at(0.9) },
    bins,
  };
}

/**
 * §12/§13 — a share with an EXPLICIT known denominator.
 *
 * A share divides by abilities whose field is KNOWN, not by all abilities. An
 * unknown is never folded into the denominator and never becomes a negative.
 */
export function shareWithDenominator(numerator, denominator) {
  return { numerator, denominator, share: denominator > 0 ? numerator / denominator : null };
}

/**
 * §11/§24 — a hero's aggregate profile; deterministic and order-independent.
 *
 * `spec.opaque` marks a feature whose meaning depends on interpreting a bare
 * integer. Such a feature is reported SCHEMA_ONLY even when values are present:
 * a number we cannot interpret is not a feature.
 */
export function heroFeatureProfile(heroId, abilities, features) {
  const rows = (abilities ?? []).map(normalizeAbilityProperties).filter(Boolean);
  const out = { heroId, abilityCount: rows.length, features: {} };
  for (const name of Object.keys(features ?? {}).sort()) {
    const spec = features[name];
    const known = rows.filter((r) => spec.known(r));
    const hits = known.filter((r) => spec.select(r));
    out.features[name] = {
      ...shareWithDenominator(hits.length, known.length),
      known: known.length,
      unknown: rows.length - known.length,
      state: spec.opaque || known.length === 0 ? CONFIDENCE.SCHEMA_ONLY
        : hits.length > 0 ? CONFIDENCE.FULLY_POPULATED : CONFIDENCE.UNINFORMATIVE,
    };
  }
  return out;
}

/** §15 — a feature-vector signature, for measuring how much heroes actually differ. */
export function profileSignature(profile) {
  return Object.keys(profile?.features ?? {}).sort()
    .map((k) => `${k}=${profile.features[k].numerator}/${profile.features[k].denominator}`)
    .join('|');
}

/**
 * §22 / §31.1 — confidence from three INDEPENDENT axes.
 *
 * This used to be decided in the research script from `distinct > 1` alone,
 * which reported `duration` as FULLY_POPULATED while the document said
 * UNINFORMATIVE: 34 distinct values, but 127/127 heroes come out the same.
 * Distinctness is not discrimination. The classification is now pure, lives
 * here, and is unit-tested.
 *
 * @param coverage      from `valueCoverage`
 * @param discrimination `{ heroesWith, heroesWithout }` counts over the pool
 * @param opaque        true when meaning needs an unpublished integer mapping
 */
export function fieldConfidence(coverage, discrimination, opaque = false) {
  if (!coverage || coverage.nonNull === 0) return CONFIDENCE.SCHEMA_ONLY;
  if (opaque) return CONFIDENCE.PARTIALLY_POPULATED;
  // Populated, but the derived feature does not separate a single hero pair.
  if (!discrimination || discrimination.heroesWith === 0 || discrimination.heroesWithout === 0) {
    return CONFIDENCE.UNINFORMATIVE;
  }
  if (coverage.nullPct > 50) return CONFIDENCE.PARTIALLY_POPULATED;
  return CONFIDENCE.FULLY_POPULATED;
}

/** §16 — hero-set overlap between two features. Defined only for booleans. */
export function featureOverlap(profiles, a, b) {
  const rows = profiles ?? [];
  let both = 0; let onlyA = 0; let onlyB = 0; let neither = 0;
  for (const p of rows) {
    const ha = (p.features?.[a]?.numerator ?? 0) > 0;
    const hb = (p.features?.[b]?.numerator ?? 0) > 0;
    if (ha && hb) both += 1;
    else if (ha) onlyA += 1;
    else if (hb) onlyB += 1;
    else neither += 1;
  }
  const aCount = both + onlyA;
  const bCount = both + onlyB;
  const union = aCount + bCount - both;
  return { a, b, both, onlyA, onlyB, neither, heroesWithA: aCount, heroesWithB: bCount, jaccard: union > 0 ? both / union : null };
}
