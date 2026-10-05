/**
 * Enemy control taxonomy — pure helpers (ТЗ §29).
 *
 * The question this file exists to answer is NOT "which heroes stun". It is:
 *
 *   can a control profile be derived MACHINE-READABLY, for the whole hero
 *   pool, without a hand-written hero list?
 *
 * The answer depends entirely on evidence discipline, so the rules are strict:
 *
 *  - Evidence must name a concrete source field. `"looks like a stun"` and
 *    `"Magic Missile"` are not evidence; the key `bolt_stun_duration` is.
 *  - `unknown` NEVER becomes `not_present`. A hero whose abilities carry no
 *    marker is unknown, not clean. The audit found a canonical stun (Lion's
 *    Impale) with NO marker at all, so "no marker" demonstrably means "not
 *    measured", not "does not do it".
 *  - Deterministic. No Math.random, no Date.now, order-independent output.
 */

/** §7 — the three states, kept distinct. */
export const FEATURE = {
  AVAILABLE: 'available',
  NOT_PRESENT: 'not_present',
  UNKNOWN: 'unknown',
};

/** §1 — the families under audit. Hex stays composite, never merged away. */
export const CATEGORIES = [
  'stun', 'root', 'leash', 'silence', 'mute', 'disarm', 'hex', 'break',
  'slow', 'fear_taunt', 'forced_movement',
];

/** §14 — Hex implies these, but as DERIVED effects with their own provenance. */
export const HEX_DERIVED = ['silence', 'mute', 'disarm'];

/**
 * §8 — upgrade provenance, recognised from the attribute key itself.
 *
 * A marker on a shard ability is not a base capability; collapsing the two would
 * let a hero look permanently stun-capable in drafts where it is not.
 */
export const UPGRADE_PATTERNS = [
  { kind: 'shard', re: /(^|_)(shard)(_|$)/ },
  { kind: 'scepter', re: /(^|_)(scepter)(_|$)/ },
  { kind: 'talent', re: /(^|_)(talents?|special_bonus)(_|$)/ },
  { kind: 'facet', re: /(^|_)(facet)(_|$)/ },
  { kind: 'upgrade', re: /(^|_)(upgrade|enhanced)(_|$)/ },
];

/**
 * §13 — FALSE-POSITIVE GUARDS.
 *
 * These keys contain a control word but describe the OPPOSITE relationship:
 * resisting, tolerating, or BEING SUBJECT TO control rather than applying it.
 * Treating them as evidence would mark exactly the heroes that are immune.
 */
export const RESISTANCE_MARKERS = [
  /resist/i,
  /unslowable/i,
  /immune/i,
  /^castable_while_/i,
  /_penalty$/i,
  /stack_count$/i,
  /^min_/i,
  /^max_(slow|root|stun)$/i,
  /_resist_/i,
];

/**
 * §5 — APPLICATION patterns, anchored and exact.
 *
 * A key is evidence of APPLICATION only if it reads "this ability applies X".
 * Anything else containing a control word is deliberately left unresolved: it
 * may describe resistance, or an unrelated numeric parameter.
 */
const APPLICATION = [
  { category: 'stun', re: /(^|_)stun(s)?(_duration|_radius|_delay|_damage)?$|^stuns?$|^ministun(_duration)?$|^wheel_stun$|^magic_missile_stun$/ },
  { category: 'root', re: /(^|_)roots?$|^root_(duration|damage|delay|base_duration|per_target|heroes_on_cast)$|^does_root$/ },
  { category: 'silence', re: /(^|_)silence_(duration|radius)$|^applies_silence$|^stacks_for_silence$/ },
  { category: 'mute', re: /^does_mute$/ },
  { category: 'disarm', re: /^disarm_duration$/ },
  { category: 'hex', re: /^hex_(chance|duration)$|_hex$|^poison_touch_hex$/ },
  { category: 'leash', re: /(^|_)leash_(duration|radius|increase|limit_multiplier|start|radius_buffer)$|^base_leash_pull$|^bear_attack_leash_range$|^cast_around_self_and_leash$/ },
  { category: 'break', re: /^does_break$|(^|_)break_(distance|duration|range|on_attack|move_cap)$|^chain_break_distance$|^max_distance_break$/ },
  { category: 'fear_taunt', re: /^fear_(duration|duration_max|duration_min|aoe)$|^taunt_(duration|radius)$|^ricochet_fear_duration$/ },
  { category: 'slow', re: /^slow(_duration|_amount|_radius|_pct|_min|_max|_aoe)?$|^move_slow$|^movement_slow$/ },
];

/**
 * §5 — classify ONE attribute key.
 *
 * Returns null for resistance markers and for control-looking keys that match
 * no application pattern. `null` means "no usable evidence here" — never
 * "this ability lacks the mechanic".
 */
export function classifyAbilityEvidence(attribKey) {
  if (typeof attribKey !== 'string' || !attribKey) return null;
  if (RESISTANCE_MARKERS.some((re) => re.test(attribKey))) return null;
  for (const { category, re } of APPLICATION) {
    if (re.test(attribKey)) return { category, evidence: `attrib.key="${attribKey}"`, attribKey };
  }
  return null;
}

/** §8 — provenance of an ability, read from its key. */
export function upgradeKindOf(abilityKey) {
  const k = String(abilityKey ?? '');
  for (const { kind, re } of UPGRADE_PATTERNS) if (re.test(k)) return kind;
  return 'base';
}

/**
 * §6 — evidence for one ability, with provenance retained.
 *
 * No arbitrary strings: every `evidence` value cites the exact source field.
 */
export function parseAbilityEvidence({ heroId, abilityKey, attrib = [] } = {}) {
  const kind = upgradeKindOf(abilityKey);
  const seen = new Set();
  const evidence = [];
  for (const a of attrib) {
    const hit = classifyAbilityEvidence(a?.key);
    // The same attrib key can appear twice in one record; without this a
    // duplicated source field would silently become duplicated evidence.
    const sig = hit ? `${hit.category}|${hit.attribKey}` : null;
    if (!hit || seen.has(sig)) continue;
    seen.add(sig);
    evidence.push({ ...hit, abilityKey, heroId, upgrade: kind });
  }
  return { heroId: heroId ?? null, abilityKey: abilityKey ?? null, upgrade: kind, evidence };
}

/** §14 — hex implies silence/mute/disarm, recorded as DERIVED, not as independent proof. */
export function mergeDerivedEffects(evidence) {
  const out = [];
  for (const e of evidence ?? []) {
    out.push(e);
    if (e.category === 'hex') {
      for (const d of HEX_DERIVED) out.push({ ...e, category: d, derived: true, derivedFrom: e.category });
    }
  }
  return out;
}

function dedupeStrings(list) {
  return [...new Set(list.filter((x) => x !== null && x !== undefined))];
}

/**
 * §7 — aggregate one hero.
 *
 * A feature is `available` if any ability carries evidence. It is NEVER
 * `not_present` from silence: the audit proves absence of a marker does not mean
 * absence of the mechanic, so absence would be a false negative.
 */
export function aggregateHeroFeatures(heroId, abilityEvidence = []) {
  const merged = mergeDerivedEffects(abilityEvidence.flatMap((a) => a.evidence ?? []));
  const features = {};
  for (const category of CATEGORIES) {
    const hits = merged.filter((e) => e.category === category);
    features[category] = {
      status: hits.length ? FEATURE.AVAILABLE : FEATURE.UNKNOWN,
      abilities: dedupeStrings(hits.map((e) => e.abilityKey)).sort(),
      derivedAbilities: dedupeStrings(hits.filter((e) => e.derived).map((e) => e.abilityKey)).sort(),
      evidence: hits.map((e) => `${e.evidence} [${e.upgrade}]${e.derived ? ` derived-from=${e.derivedFrom}` : ''}`).sort(),
    };
  }
  return { heroId, features, abilityCount: abilityEvidence.length };
}

/** §7 — the invariant, in one place so a test can pin it. */
export function validateFeatureState(state) {
  return state === FEATURE.AVAILABLE || state === FEATURE.NOT_PRESENT || state === FEATURE.UNKNOWN;
}

/** §10 — coverage across the hero pool. */
export function coverageSummary(heroFeatures = [], abilityTotals = {}) {
  const heroes = heroFeatures;
  const perCategory = {};
  for (const c of CATEGORIES) {
    const available = heroes.filter((h) => h.features?.[c]?.status === FEATURE.AVAILABLE).length;
    perCategory[c] = { heroesAvailable: available, heroesUnknown: heroes.length - available };
  }
  return {
    heroesTotal: heroes.length,
    abilitiesTotal: abilityTotals.total ?? 0,
    abilitiesClassified: abilityTotals.classified ?? 0,
    heroesWithAnyFeature: heroes.filter((h) => CATEGORIES.some((c) => h.features?.[c]?.status === FEATURE.AVAILABLE)).length,
    perCategory,
  };
}