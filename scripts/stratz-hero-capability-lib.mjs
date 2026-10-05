/**
 * Tri-state hero capability resolution (ТЗ §33).
 *
 * The §32 coverage numbers decide the shape of this whole module:
 *
 *   unitDamageType  411/868 ability rows resolved (47.4%)   3/127 heroes complete
 *   unitTargetTeam  284/868 ability rows resolved (32.7%)   0/127 heroes complete
 *
 * A capability may only be FALSE when every relevant ability is known and none
 * of them carries the property. With zero heroes fully covered on target team,
 * FALSE is essentially unreachable there, and that is a fact about the source
 * rather than a modelling choice: a FALSE we cannot support must stay UNKNOWN.
 *
 * TRUE needs only one confirmed observation, so the tri-state resolves to a
 * mix of TRUE and UNKNOWN. That asymmetry is the entire reason this is useful.
 */

/** §33 — three states, and no fourth. */
export const TRI = {
  TRUE: 'TRUE',
  FALSE: 'FALSE',
  UNKNOWN: 'UNKNOWN',
};

/**
 * Capability definitions, kept as data so the report and the tests cannot drift.
 *
 * `semantic` is an exact OpenDota label. `damaging` marks the dimensions whose
 * FALSE is meaningful for a hero profile; the target dimensions stay listed but
 * are reported separately, because §32.1 measured them on their own grain.
 */
export const CAPABILITIES = [
  { id: 'HAS_PHYSICAL_DAMAGE', dimension: 'unitDamageType', semantic: 'Physical', group: 'damage' },
  { id: 'HAS_MAGICAL_DAMAGE', dimension: 'unitDamageType', semantic: 'Magical', group: 'damage' },
  { id: 'HAS_PURE_DAMAGE', dimension: 'unitDamageType', semantic: 'Pure', group: 'damage' },
  { id: 'HAS_ENEMY_TARGETED', dimension: 'unitTargetTeam', semantic: 'Enemy', group: 'target' },
  { id: 'HAS_FRIENDLY_TARGETED', dimension: 'unitTargetTeam', semantic: 'Friendly', group: 'target' },
  { id: 'HAS_BOTH_TARGETED', dimension: 'unitTargetTeam', semantic: 'Both', group: 'target' },
];

/**
 * Resolve one capability for one hero.
 *
 * @param abilities  ability rows, either `{ ability: {...} }` or a bare ability
 * @param map        confirmed raw -> semantic mapping for the capability's OWN dimension
 * @param semantic   the OpenDota label this capability means
 * @param dimension  the STRATZ field this capability reads, e.g. `unitDamageType`
 *
 * The dimension is an explicit parameter on purpose. An earlier version walked a
 * fixed chain of candidate fields, so every capability read `unitDamageType`
 * first — which made target-team capabilities silently query the damage field
 * and produced a fabricated 100% agreement between HAS_MAGICAL_DAMAGE and
 * HAS_ENEMY_TARGETED. A capability must only ever read its own field.
 */
export function resolveCapability(abilities, map, semantic, dimension) {
  const rows = (abilities ?? []).map((a) => a?.ability ?? a).filter(Boolean);
  const total = rows.length;
  let known = 0;
  let hits = 0;
  for (const r of rows) {
    const raw = r?.stat?.[dimension] ?? r?.[dimension] ?? null;
    if (raw === null || raw === undefined) continue;
    const sem = map.get(String(raw)) ?? null;
    if (sem === null) continue; // value present, semantics unknown
    known += 1;
    if (sem === semantic) hits += 1;
  }
  if (hits > 0) return { state: TRI.TRUE, total, known, unknown: total - known, evidence: hits, semantic };
  if (known === total && total > 0) return { state: TRI.FALSE, total, known, unknown: 0, evidence: 0, semantic: null };
  return { state: TRI.UNKNOWN, total, known, unknown: total - known, evidence: 0, semantic: null };
}

/** §33 — the full tri-state profile for one hero, deterministic key order. */
export function heroCapabilityProfile(heroId, abilities, dimensionMaps, capabilities = CAPABILITIES) {
  const out = { heroId, capabilities: {} };
  for (const cap of [...capabilities].sort((a, b) => a.id.localeCompare(b.id))) {
    out.capabilities[cap.id] = resolveCapability(abilities, dimensionMaps[cap.dimension] ?? new Map(), cap.semantic, cap.dimension);
  }
  return out;
}

/** §33 — pool-wide state distribution per capability. */
export function capabilityDistribution(profiles, capabilityId) {
  const counts = { TRUE: 0, FALSE: 0, UNKNOWN: 0 };
  for (const p of profiles) {
    const c = p.capabilities?.[capabilityId];
    if (c && counts[c.state] !== undefined) counts[c.state] += 1;
  }
  return counts;
}

/** §33 — a signature string per hero, for measuring whether profiles actually differ. */
export function capabilitySignature(profile) {
  return Object.keys(profile.capabilities).sort().map((k) => `${k}=${profile.capabilities[k].state}`).join('|');
}

/**
 * §33 — redundancy between two capabilities over the pool.
 *
 * `identical` counts heroes where the two tri-states agree exactly, including
 * agreeing on UNKNOWN, which is the form of redundancy that matters here: two
 * features that are both UNKNOWN for a hero carry no distinguishing power.
 */
export function capabilityRedundancy(profiles, a, b) {
  let identical = 0;
  let distinguish = 0;
  let bothUnknown = 0;
  for (const p of profiles) {
    const sa = p.capabilities?.[a]?.state;
    const sb = p.capabilities?.[b]?.state;
    if (sa === sb) { identical += 1; if (sa === TRI.UNKNOWN) bothUnknown += 1; }
    else distinguish += 1;
  }
  const n = profiles.length || 1;
  return { a, b, identical, distinguish, bothUnknown, agreement: identical / n };
}