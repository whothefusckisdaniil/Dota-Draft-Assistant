/**
 * OpenDota <-> STRATZ ability semantics (ТЗ §32).
 *
 * STRATZ returns `unitDamageType` and `unitTargetTeam` as bare integers with no
 * enum anywhere in its schema, which left them opaque in §31. dotaconstants
 * publishes the same abilities under the same key with named values
 * (`dmg_type: "Magical"`, `target_team: "Enemy"`).
 *
 * Everything here is PURE. Nothing in this file performs I/O, and nothing
 * decides a mapping on its own: `classifyMapping` only reports what the paired
 * observations show, including when they are inconsistent. An inconsistent
 * cross-table produces UNKNOWN, never a best guess.
 */

/** §18 — three validation states, none of which is a fallback to "probably". */
export const VALIDATION = {
  CONFIRMED: 'CONFIRMED',
  AMBIGUOUS: 'AMBIGUOUS',      // one raw -> several semantics
  NON_BIJECTIVE: 'NON_BIJECTIVE', // several raws -> one semantic
  UNKNOWN: 'UNKNOWN',          // no observations at all
};

/** §12 — fields read from OpenDota, kept separate and never combined. */
export const OD_FIELDS = ['dmg_type', 'target_team', 'target_type'];

/** Which STRATZ field each OpenDota field would validate. `unitTargetFlags` has no counterpart. */
export const FIELD_PAIRS = [
  { stratz: 'unitDamageType', opendota: 'dmg_type' },
  { stratz: 'unitTargetTeam', opendota: 'target_team' },
  { stratz: 'unitTargetFlags', opendota: null },
];

/**
 * Normalise one OpenDota ability record.
 *
 * `""` and a missing key are the same thing in this dataset (16 records), and
 * both mean "not stated" — kept as `null` rather than as the empty string, so a
 * blank cannot later be counted as a distinct semantic.
 */
export function normalizeOpenDotaAbility(key, rec) {
  if (!rec || typeof rec !== 'object') return { key, dmg_type: null, target_team: null, target_type: null };
  const pick = (f) => {
    const v = rec[f];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
  };
  return { key, dmg_type: pick('dmg_type'), target_team: pick('target_team'), target_type: pick('target_type') };
}

/** STRATZ ability as stored by the §31 research: properties nested under `stat`. */
function normalizeStratzAbility(a) {
  const stat = a?.stat ?? {};
  return {
    key: a?.name ?? null,
    unitDamageType: stat.unitDamageType ?? null,
    unitTargetTeam: stat.unitTargetTeam ?? null,
    unitTargetFlags: stat.unitTargetFlags ?? null,
  };
}

/**
 * §3 — exact-key join. No fuzzy matching, no case folding, no `contains`, no
 * hero-prefix guessing. A key that is not present is reported, never guessed.
 *
 * The STRATZ side is normalised here rather than in the caller, because the raw
 * GraphQL shape nests everything under `stat`. Reading the top level instead
 * yields all-null pairs and a cross-table of zero observations — which looks
 * exactly like "no mapping exists" rather than like a bug.
 */
export function exactAbilityJoin(stratzAbilities, opendotaAbilities) {
  const oda = new Map();
  for (const [k, v] of Object.entries(opendotaAbilities ?? {})) oda.set(k, normalizeOpenDotaAbility(k, v));
  const matched = [];
  const missingOpenDota = [];
  const duplicates = [];
  const seen = new Set();
  for (const a of stratzAbilities ?? []) {
    const name = a?.name;
    if (name === null || name === undefined) continue;
    if (seen.has(name)) { duplicates.push(name); continue; }
    seen.add(name);
    const rec = oda.get(name);
    if (!rec) { missingOpenDota.push(name); continue; }
    matched.push({ key: name, stratz: normalizeStratzAbility(a), opendota: rec });
  }
  return { matched, missingOpenDota, duplicates, matchedCount: matched.length };
}

/**
 * §5/§8 — paired observations for one field pair.
 *
 * Only abilities where BOTH sides have a value produce an observation; an
 * absent side is recorded as unknown and never imputed.
 */
export function buildValueCrossTable(pairs, stratzField, opendotaField) {
  const rows = pairs.filter((p) => p.stratz?.[stratzField] !== null && p.stratz?.[stratzField] !== undefined);
  const table = new Map();
  for (const p of rows) {
    const raw = String(p.stratz[stratzField]);
    const sem = p.opendota[opendotaField] ?? null;
    if (!table.has(raw)) table.set(raw, new Map());
    const inner = table.get(raw);
    inner.set(sem, (inner.get(sem) ?? 0) + 1);
  }
  const raws = [...table.keys()].sort((a, b) => Number(a) - Number(b));
  return {
    stratzField,
    opendotaField,
    observations: rows.length,
    skills: {
      raw: rows.filter((p) => p.opendota[opendotaField] != null).length,
      noSemantic: rows.filter((p) => p.opendota[opendotaField] == null).length,
    },
    entries: raws.map((raw) => {
      const inner = table.get(raw);
      const semantics = [...inner.keys()].sort();
      return {
        rawValue: raw,
        semantics,
        dominant: semantics[0] ?? null,
        ambiguous: semantics.filter((s) => s !== null).length > 1,
        count: [...inner.values()].reduce((a, b) => a + b, 0),
        breakdown: semantics.map((s) => ({ semantic: s, count: inner.get(s) })),
      };
    }),
  };
}
/**
 * §6 — classify one raw value from a cross-table.
 *
 * CONFIRMED requires exactly one non-null semantic AND that semantic appearing
 * under exactly one raw value. Both directions matter: an ambiguous forward
 * direction and a colliding reverse direction both disqualify the mapping, and
 * neither disqualifies the OTHER raw values from being usable.
 */
export function classifyMapping(table, rawValue) {
  const entry = table.entries.find((e) => e.rawValue === String(rawValue));
  if (!entry) return { rawValue: String(rawValue), semantic: null, validationStatus: VALIDATION.UNKNOWN };
  const named = entry.semantics.filter((s) => s !== null);
  if (named.length === 0) {
    return { rawValue: String(rawValue), semantic: null, validationStatus: VALIDATION.UNKNOWN, observations: entry.count };
  }
  if (named.length > 1) {
    return { rawValue: String(rawValue), semantic: null, validationStatus: VALIDATION.AMBIGUOUS, observations: entry.count, candidates: named };
  }
  const semantic = named[0];
  const owners = table.entries.filter((e) => e.semantics.includes(semantic)).map((e) => e.rawValue);
  const status = owners.length === 1 ? VALIDATION.CONFIRMED : VALIDATION.NON_BIJECTIVE;
  return {
    rawValue: String(rawValue),
    semantic: status === VALIDATION.CONFIRMED ? semantic : null,
    validationStatus: status,
    observations: entry.count,
    ...(status === VALIDATION.NON_BIJECTIVE ? { alsoSeenUnder: owners.filter((r) => r !== String(rawValue)) } : {}),
  };
}

/** §6 — the full mapping for a field, one record per raw value (§14 provenance shape). */
export function buildMapping(table) {
  return table.entries.map((e) => classifyMapping(table, e.rawValue));
}

/**
 * §9 — deterministic split by sorted ability key. No shuffle, no RNG, so a
 * re-run always validates on the same half.
 */
export function splitDeterministically(pairs) {
  const sorted = [...(pairs ?? [])].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  return { a: sorted.slice(0, mid), b: sorted.slice(mid) };
}

/**
 * §9 — out-of-sample validation.
 *
 * The mapping is derived on A and only then applied to B. A raw value is only
 * CONFIRMED if it was consistent on A *and* B agrees, and a value that is
 * consistent on A but contradicted on B is reported as a CONFLICT rather than
 * quietly kept.
 */
export function validateMapping(pairsA, pairsB, stratzField, opendotaField) {
  const tableA = buildValueCrossTable(pairsA, stratzField, opendotaField);
  const derived = buildMapping(tableA);
  const tableB = buildValueCrossTable(pairsB, stratzField, opendotaField);
  const results = [];
  for (const m of derived) {
    const inB = tableB.entries.find((e) => e.rawValue === m.rawValue);
    const seenB = inB ? inB.semantics.filter((s) => s !== null) : [];
    let status = m.validationStatus;
    if (m.validationStatus === VALIDATION.CONFIRMED) {
      if (seenB.length === 0) status = m.observations ? VALIDATION.CONFIRMED : VALIDATION.UNKNOWN;
      else if (seenB.length === 1 && seenB[0] === m.semantic) status = VALIDATION.CONFIRMED;
      else status = VALIDATION.AMBIGUOUS;
    }
    results.push({
      ...m,
      // A mapping that did not survive validation must not keep its semantic:
      // a caller reading `.semantic` would otherwise consume a mapping this
      // very function rejected.
      semantic: status === VALIDATION.CONFIRMED ? m.semantic : null,
      validationStatus: status,
      outOfSample: seenB.length === 1 && seenB[0] === m.semantic ? 'AGREES' : seenB.length === 0 ? 'NO_OBSERVATIONS' : 'CONFLICT',
    });
  }
  // A raw value that only ever appears in B could not be mapped from A at all.
  // Reporting it is the difference between "no mapping" and "not looked at".
  const derivedRaws = new Set(derived.map((m) => m.rawValue));
  const bOnly = tableB.entries.filter((e) => !derivedRaws.has(e.rawValue));
  return {
    derivedOnA: derived,
    results,
    bOnlyValues: bOnly.map((e) => e.rawValue),
    aRaws: tableA.entries.map((e) => e.rawValue),
    bRaws: tableB.entries.map((e) => e.rawValue),
    tableA,
    tableB,
  };
}
/**
 * §32.1 — per-DIMENSION hero coverage.
 *
 * The first version of the hero diagnostic kept a single `known` counter that
 * was incremented for a mapped damage type AND a mapped target team, while
 * `unknown` was incremented only when damage was unmapped. A hero line like
 * `known 3 unmapped 4` therefore mixed two property dimensions and read like
 * an ability coverage ratio when it was not one.
 *
 * Here each dimension is counted on its own ability rows, so `known + unknown`
 * equals the ability count per dimension, and the denominator is the ability
 * count rather than a count of property observations.
 */
export function heroDimensionCoverage(abilities, dimensionMaps) {
  const rows = (abilities ?? []).map((a) => a?.ability ?? a).filter(Boolean);
  const total = rows.length;
  const dimensions = {};
  for (const [name, map] of Object.entries(dimensionMaps ?? {})) {
    let known = 0;
    let noValue = 0;
    const semantics = new Map();
    for (const r of rows) {
      const raw = r?.stat?.[name] ?? r?.[name] ?? null;
      const sem = raw === null ? null : map.get(String(raw)) ?? null;
      if (sem) {
        known += 1;
        semantics.set(sem, (semantics.get(sem) ?? 0) + 1);
      } else if (raw === null) {
        noValue += 1;
      }
    }
    dimensions[name] = {
      total,
      known,
      // "unknown", not "unmapped": for raw 0 there is no mapping to begin with,
      // rather than a mapping that exists and was left unresolved.
      unknown: total - known,
      noValue,
      coverage: total ? known / total : null,
      semantics: [...semantics.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    };
  }
  return { abilityCount: total, dimensions };
}
