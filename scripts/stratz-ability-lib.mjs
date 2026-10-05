/**
 * STRATZ ability graph — pure helpers (ТЗ §30).
 *
 * The audit asks whether STRATZ exposes a complete machine-readable
 * `Hero -> Ability` graph AND enough semantics to replace the failed
 * OpenDota/Valve control source. These helpers are the evidence rules; none of
 * them turns a name or a description into a mechanic.
 *
 * Three states, and `not_present` is never inferred:
 *   available  — the source carries a typed signal for this feature
 *   unknown    — the source has no signal; absence is NOT a negative answer
 *   not_available — the field does not exist in the schema at all
 */

/** §13/§17 — the three states, kept distinct. */
export const STATE = {
  AVAILABLE: 'available',
  UNKNOWN: 'unknown',
  NOT_AVAILABLE: 'not_present',
};

/** §4/§11 — scalar fields the audit probes for, by intended meaning. */
export const WANTED_ABILITY_FIELDS = [
  'id', 'name', 'uri', 'language', 'stat', 'attributes', 'isTalent',
];
export const WANTED_STAT_FIELDS = [
  'isUltimate', 'isInnate', 'isGrantedByScepter', 'hasScepterUpgrade',
  'isGrantedByShard', 'hasShardUpgrade', 'dispellable', 'duration', 'damage',
  'castRange', 'unitDamageType', 'unitTargetTeam', 'unitTargetFlags',
];

/** §5 — the control flags STRATZ DECLARES on ModifierType. */
export const MODIFIER_CONTROL_FLAGS = [
  'isStun', 'isRoot', 'isSilence', 'isMute', 'isDisarm', 'isHex',
  'isShackle', 'isBreak', 'isMovementSlow', 'isAttackSlow', 'isTaunt',
  'isKnockback', 'isSleep', 'isCyclone', 'isBlind', 'isEthereal',
];

/** §11 — upgrade provenance, taken only from typed booleans. */
export const UPGRADE_FIELDS = {
  shard: 'hasShardUpgrade',
  scepter: 'hasScepterUpgrade',
};

/** Normalise a hero record. Absent fields stay null rather than defaulting. */
export function normalizeHero(hero) {
  if (!hero || typeof hero !== 'object') return null;
  if (hero.id === undefined || hero.id === null) return null;
  return {
    id: Number(hero.id),
    name: hero.name ?? null,
    displayName: hero.displayName ?? null,
    gameVersionId: hero.gameVersionId ?? null,
  };
}

/** Normalise an ability, keeping nulls distinct from false. */
export function normalizeAbility(ability) {
  if (!ability || typeof ability !== 'object') return null;
  if (ability.id === undefined || ability.id === null) return null;
  return {
    id: Number(ability.id),
    name: ability.name ?? null,
    isTalent: ability.isTalent ?? null,
    stat: ability.stat ?? null,
    attributes: Array.isArray(ability.attributes) ? ability.attributes : [],
  };
}

/** Normalise a modifier, keeping nulls distinct from false. */
export function normalizeModifier(mod) {
  if (!mod || typeof mod !== 'object') return null;
  if (mod.id === undefined || mod.id === null) return null;
  const flags = {};
  for (const f of MODIFIER_CONTROL_FLAGS) flags[f] = mod[f] ?? null;
  return { id: Number(mod.id), name: mod.name ?? null, flags };
}

/** §10 — the Hero -> Ability join, per hero. */
export function resolveHeroAbilities(hero, heroAbilities) {
  const abilities = [];
  const seen = new Set();
  let duplicates = 0;
  for (const link of heroAbilities ?? []) {
    const a = normalizeAbility(link?.ability ?? link);
    if (!a) continue;
    if (seen.has(a.id)) { duplicates += 1; continue; }
    seen.add(a.id);
    abilities.push({ ...a, slot: link?.slot ?? null });
  }
  return { heroId: Number(hero?.id), abilityCount: abilities.length, abilities, duplicateLinks: duplicates };
}

/** §17 — a schema field that is absent reports NOT_AVAILABLE, never throws. */
export function semanticFieldCoverage(declaredFields, wantedFields) {
  const declared = new Set(declaredFields ?? []);
  return (wantedFields ?? []).map((f) => ({
    field: f,
    state: declared.has(f) ? STATE.AVAILABLE : STATE.NOT_AVAILABLE,
  }));
}

/**
 * §4/§8 — upgrade provenance, from TYPED booleans only.
 *
 * "can stun with a shard" and "the base ability stuns" are different facts, so
 * the provenance travels with the evidence instead of being collapsed into a
 * bare boolean.
 */
export function upgradeProvenance(ability) {
  const stat = ability?.stat ?? {};
  const out = [];
  for (const [kind, field] of Object.entries(UPGRADE_FIELDS)) {
    if (stat[field] === true) out.push(kind);
    else if (stat[field] === false) out.push(`no_${kind}`);
  }
  if (stat.isTalent === true) out.push('talent');
  if (stat.isInnate === true) out.push('innate');
  return out.sort();
}

/**
 * §6/§8 — a control feature's evidence, and ONLY from a typed modifier flag.
 *
 * A modifier NAME or DESCRIPTION is never evidence: §12 forbids turning
 * "hex" in a string into hex = true.
 */
export function featureEvidence(heroId, ability, modifiers) {
  const evidence = [];
  for (const m of modifiers ?? []) {
    for (const flag of MODIFIER_CONTROL_FLAGS) {
      if (m?.flags?.[flag] === true) {
        evidence.push({
          heroId: heroId ?? null,
          abilityId: ability?.id ?? null,
          abilityName: ability?.name ?? null,
          feature: flag.replace(/^is/, '').toLowerCase(),
          source: 'stratz',
          field: `ModifierType.${flag}`,
          value: m.id,
          status: STATE.AVAILABLE,
        });
      }
    }
  }
  return evidence;
}

/**
 * Coverage over the modifier constants: DECLARED in schema vs actually POPULATED
 * in data.
 *
 * Both inputs are required. A field the schema does not declare is
 * `not_present`; a field the schema declares but that never returns a boolean is
 * `unknown` — which is the honest state, and the one that decides the verdict.
 */
export function modifierFlagCoverage(modifiers, declaredFields) {
  const rows = modifiers ?? [];
  const declared = new Set(declaredFields ?? []);
  return MODIFIER_CONTROL_FLAGS.map((f) => {
    const trueCount = rows.filter((m) => m?.flags?.[f] === true).length;
    const populated = rows.some((m) => typeof m?.flags?.[f] === 'boolean');
    return {
      field: f,
      state: !declared.has(f) ? STATE.NOT_AVAILABLE
        : trueCount > 0 ? STATE.AVAILABLE
          : populated ? STATE.UNKNOWN : STATE.UNKNOWN,
      trueCount,
    };
  });
}
