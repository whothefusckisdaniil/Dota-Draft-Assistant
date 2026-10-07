/**
 * ТЗ §35 — capability profile v2 after the §34 confirmation of `0 = NONE`
 * (pure functions).
 *
 * The §33 tri-state rule itself does not change. What changes is the input
 * domain: raw `0` (and target-team `4`) were UNKNOWN evidence, and after the
 * §34 audit they are *known* states. A NONE row now counts toward `known`,
 * which is exactly what makes FALSE reachable for heroes whose abilities are
 * all non-matching.
 *
 * The tri-state resolution is NOT copied here — §24 requires reuse. Every
 * profile/distribution/signature/redundancy call delegates to
 * `stratz-hero-capability-lib.mjs` with a bigger map. The §32 artifact is
 * merged in memory only; `confirmed-mappings.json` is never rewritten.
 *
 * No network I/O. No weights. No isUltimate/isTalent/duration/castRange/
 * dispellable/isInnate (§5). No wins/items/matchups (§18). Production
 * (`src/`, `public/data/`, `engine.ts`) is read-only at most.
 */
import {
  TRI, CAPABILITIES,
  resolveCapability, heroCapabilityProfile,
  capabilityDistribution, capabilitySignature, capabilityRedundancy,
} from './stratz-hero-capability-lib.mjs';

export { TRI, CAPABILITIES };

/**
 * §2 — zero semantics confirmed by the §34 audit
 * (`ZERO_SEMANTICS_CONFIRMED`, docs/zero-enum-research.md):
 *
 *   DAMAGE_TYPE_NONE           = 0  → 'None'
 *   DOTA_UNIT_TARGET_TEAM_NONE = 0  → 'None'
 *   DOTA_UNIT_TARGET_TEAM_CUSTOM=4  → 'Custom'
 *
 * Labels use the Title-case style of the §32 semantics. `'None'` and
 * `'Custom'` are not capability semantics, so NONE/CUSTOM rows can only ever
 * contribute to `known`, never to `hits` — by construction they can enable
 * FALSE but never TRUE.
 *
 * §2 also forbids extending the observed domain from the external enum:
 * `DAMAGE_TYPE_ALL = 7` and `HP_REMOVAL = 8` exist in Valve's table but are
 * absent from STRATZ, so they are deliberately NOT added.
 */
export const ZERO_SEMANTICS = {
  unitDamageType: { '0': 'None' },
  unitTargetTeam: { '0': 'None', '4': 'Custom' },
};

/**
 * §2/§8 — the raw values STRATZ actually uses, as fixed by §35 before the run.
 * A raw outside these sets must stop mapping completeness
 * (`UNMAPPED_RAW_VALUE`), not be silently absorbed as "unknown semantic".
 */
export const EXPECTED_RAW_DOMAIN = {
  unitDamageType: ['0', '1', '2', '4'],
  unitTargetTeam: ['0', '1', '2', '3', '4'],
};

/** §28 — verdicts. */
export const VERDICTS = {
  EXACT: 'CAPABILITY_EXACT',
  PARTIAL: 'CAPABILITY_PARTIAL',
  MARGINAL: 'CAPABILITY_MARGINAL',
};

/**
 * §3 — the runtime map: §32 CONFIRMED non-zero mappings + §34 confirmed zero
 * semantics, merged IN MEMORY.
 *
 * Pure: the artifact object and its nested arrays are never mutated. §32 wins
 * over the zero addition should the artifact ever map a zero itself — this
 * helper only ever *adds* entries. `zeroSemantics = {}` reproduces §33's
 * confirmed-only map exactly, which is how the baseline column of the §9
 * comparison table is generated from the same code path.
 *
 * Only entries with `validationStatus === 'CONFIRMED'` are admitted; an
 * UNKNOWN entry in `fields` can never leak into the runtime map.
 */
export function mergeConfirmedMappings(artifact, zeroSemantics = ZERO_SEMANTICS) {
  const out = {};
  for (const [field, rec] of Object.entries(artifact?.fields ?? {})) {
    const m = new Map();
    for (const e of rec.mapping ?? []) {
      if (e?.validationStatus === 'CONFIRMED') m.set(String(e.rawValue), e.semantic);
    }
    for (const [raw, sem] of Object.entries(zeroSemantics?.[field] ?? {})) {
      if (!m.has(raw)) m.set(raw, sem);
    }
    out[field] = m;
  }
  for (const [field, sems] of Object.entries(zeroSemantics ?? {})) {
    if (!out[field]) out[field] = new Map(Object.entries(sems));
  }
  return out;
}

/**
 * §6/§24 — the tri-state rule, delegated, never re-implemented:
 *
 *   TRUE      ≥1 row with a confirmed semantic equal to the capability
 *   FALSE     all rows known (NONE included) and no hit
 *   UNKNOWN   some row unresolved and no hit
 *
 * The only difference from §33 is that the map now contains the zero entries.
 */
export function resolveTriStateV2(abilities, map, semantic, dimension) {
  return resolveCapability(abilities, map, semantic, dimension);
}

/** §24 — full six-capability profile for one hero (delegates). */
export function heroCapabilityProfileV2(heroId, abilities, dimensionMaps, capabilities = CAPABILITIES) {
  return heroCapabilityProfile(heroId, abilities, dimensionMaps, capabilities);
}

/** §24 — pool-wide state counts for one capability (delegates). */
export function capabilityDistributionV2(profiles, capabilityId) {
  return capabilityDistribution(profiles, capabilityId);
}

/** §24 — deterministic signature string (delegates). */
export function capabilitySignatureV2(profile) {
  return capabilitySignature(profile);
}

/** §24 — pairwise agreement including agreement-on-UNKNOWN (delegates). */
export function capabilityRedundancyV2(profiles, a, b) {
  return capabilityRedundancy(profiles, a, b);
}

/**
 * §8 — raw domain audit for one dimension.
 *
 * Buckets a row's raw value into:
 *   mapped     present in the runtime map (§32 confirmed + §34 zero)
 *   unknown    in the EXPECTED domain but not in the map (should be empty)
 *   unmapped   OUTSIDE the expected domain → status UNMAPPED_RAW_VALUE,
 *              which stops mapping completeness instead of counting as
 *              ordinary unknown semantic
 *   missing    field absent (`stat: null`) — never conflated with raw zero
 *
 * `observed` keeps the raw-value histogram for the report.
 */
export function domainAudit(raws, map, expectedRawDomain) {
  const observed = {};
  const unknown = {};
  const unmapped = {};
  let mapped = 0;
  let missing = 0;
  for (const r of raws ?? []) {
    if (r === null || r === undefined) { missing += 1; continue; }
    const k = String(r);
    observed[k] = (observed[k] ?? 0) + 1;
    if (map?.has(k)) { mapped += 1; continue; }
    if ((expectedRawDomain ?? []).includes(k)) unknown[k] = (unknown[k] ?? 0) + 1;
    else unmapped[k] = (unmapped[k] ?? 0) + 1;
  }
  const total = (raws ?? []).length;
  return {
    total,
    observed,
    mapped,
    unknown,
    unmapped,
    missing,
    mappedShare: total ? mapped / total : 0,
    status: Object.keys(unmapped).length ? 'UNMAPPED_RAW_VALUE' : 'COMPLETE',
  };
}

/**
 * §10 — hero-level completeness for ONE dimension: every ability row's raw
 * value for `dimension` resolves through the map. A hero with zero abilities
 * is not "complete".
 */
export function heroDimensionCoverage(abilities, map, dimension) {
  const rows = (abilities ?? []).map((a) => a?.ability ?? a).filter(Boolean);
  let known = 0;
  for (const r of rows) {
    const raw = r?.stat?.[dimension] ?? null;
    if (raw === null || raw === undefined) continue;
    if (map.has(String(raw))) known += 1;
  }
  return { known, total: rows.length, complete: rows.length > 0 && known === rows.length };
}

/**
 * §14 — false-capability availability: is FALSE actually an information
 * carrier now? `knownHeroes` (= TRUE + FALSE) is the denominator of "heroes
 * whose state is decided", reported against the full pool.
 */
export function falseAvailability(profiles, capabilityId) {
  const d = capabilityDistributionV2(profiles, capabilityId);
  const total = profiles.length;
  const share = (n) => (total ? n / total : 0);
  return {
    ...d,
    total,
    falseHeroes: d.FALSE,
    knownHeroes: d.TRUE + d.FALSE,
    trueShare: share(d.TRUE),
    falseShare: share(d.FALSE),
    unknownShare: share(d.UNKNOWN),
    knownShare: share(d.TRUE + d.FALSE),
  };
}

/**
 * §15 — distinct 2-feature signatures over the pool. The histogram keys are
 * `"<stateA>/<stateB>"` over the full 3×3 state space, so the report can show
 * whether a pair actually creates new hero groups (e.g. FALSE/FALSE did not
 * exist in §33).
 */
export function pairUniqueness(profiles, a, b) {
  const combos = {};
  for (const p of profiles) {
    const sa = p.capabilities?.[a]?.state ?? 'ABSENT';
    const sb = p.capabilities?.[b]?.state ?? 'ABSENT';
    const k = `${sa}/${sb}`;
    combos[k] = (combos[k] ?? 0) + 1;
  }
  return { a, b, distinct: Object.keys(combos).length, combos };
}

/**
 * §11 — group heroes by full-profile signature. Sorted by descending group
 * size, then by signature string, so the output is byte-stable; heroIds
 * inside a group are sorted too.
 */
export function signatureGroups(profiles) {
  const bySig = new Map();
  for (const p of profiles) {
    const s = capabilitySignatureV2(p);
    if (!bySig.has(s)) bySig.set(s, []);
    bySig.get(s).push(p.heroId);
  }
  const groups = [...bySig.entries()].map(([signature, ids]) => ({
    signature,
    count: ids.length,
    heroIds: [...ids].sort((x, y) => String(x).localeCompare(String(y))),
  }));
  groups.sort((x, y) => y.count - x.count || x.signature.localeCompare(y.signature));
  return groups;
}

/**
 * §35.1 — group concentration: the stronger diagnostic of discrimination.
 *
 * `groups` is the `signatureGroups()` output (sorted largest-first, so
 * `groups[0]` is the largest group). All helpers are pure and totalHeroes
 * is the pool size, not the grouped count, so shares stay comparable.
 */
export function largestSignatureShare(groups, totalHeroes) {
  if (!totalHeroes) return 0;
  return (groups?.[0]?.count ?? 0) / totalHeroes;
}

export function topKSignatureShare(groups, totalHeroes, k) {
  if (!totalHeroes || !(k > 0)) return 0;
  return (groups ?? []).slice(0, k).reduce((s, g) => s + (g?.count ?? 0), 0) / totalHeroes;
}

/**
 * §17 — hero × production-position cells with a COMPLETE capability profile.
 *
 * A cell exists under the production position gate (`share ≥ 8%`,
 * `games ≥ 500` — docs/position-model.md, POSITION_ELIGIBILITY). This is a
 * read-only measurement: nothing here changes eligibility, and the position
 * model itself is untouched. "Complete" = all six capabilities decided
 * (no UNKNOWN).
 */
export function positionIntersection(profiles, positionsJson, { minShare = 0.08, minGames = 500 } = {}) {
  const out = {
    cells: 0,
    completeCells: 0,
    incompleteCells: 0,
    knownCapabilities: 0,
    unknownCapabilities: 0,
    heroesWithoutPositionData: [],
  };
  for (const p of profiles) {
    const entry = positionsJson?.[String(p.heroId)];
    if (!entry) {
      out.heroesWithoutPositionData.push(p.heroId);
      continue;
    }
    for (const cell of Object.values(entry.positions ?? {})) {
      if ((cell?.share ?? 0) < minShare || (cell?.games ?? 0) < minGames) continue;
      out.cells += 1;
      const states = Object.values(p.capabilities ?? {});
      const unknown = states.filter((s) => s?.state === TRI.UNKNOWN).length;
      out.knownCapabilities += states.length - unknown;
      out.unknownCapabilities += unknown;
      if (unknown === 0) out.completeCells += 1;
      else out.incompleteCells += 1;
    }
  }
  return out;
}

/**
 * §28 (with the §35.1 correction) — the verdict over four metrics:
 *
 *   rowCoverage            share of ability rows whose raw value is mapped,
 *                          worst of the two dimensions
 *   completeShare          heroes complete on BOTH dimensions / pool
 *   distinctSignatureShare distinct full signatures / pool — a DIVERSITY
 *                          diagnostic, not a standalone measure of
 *                          discrimination quality (see §35.1: the same
 *                          distinct count can hide a 74.8% mega-group, so
 *                          group concentration — largest/top-k share — is
 *                          the stronger diagnostic)
 *   neverFalse             capabilities that can never be FALSE for any hero
 *
 * CAPABILITY_EXACT     domain almost fully known AND profiles substantially
 *                      diverse (≥50% distinct signatures, no capability
 *                      locked out of FALSE). The ≥50% bar is a diversity
 *                      gate, NOT a claim that it proves discrimination —
 *                      it has no independent justification as a quality
 *                      measure yet, so EXACT also requires full coverage.
 * CAPABILITY_PARTIAL   domain usable, but some heroes/features stay unknown
 *                      or diversity stays moderate
 * CAPABILITY_MARGINAL  coverage good yet profiles barely diversify, or
 *                      features still cannot express negatives
 *
 * Sanity anchor: §33's measured numbers (rowCoverage 0.474, neverFalse 4)
 * fall through to MARGINAL, matching the §33 verdict.
 *
 * Back-compat: the input field keeps its historical name `signatureShare`
 * (callers pass the distinct count share); it is only *interpreted* as
 * `distinctSignatureShare` per §35.1. No new concentration thresholds are
 * introduced — the verdict stays deliberately conservative.
 */
export function capabilityVerdictV2({ rowCoverage, completeShare, signatureShare, neverFalse }) {
  const distinctSignatureShare = signatureShare;
  if (rowCoverage >= 0.95 && completeShare >= 0.9 && distinctSignatureShare >= 0.5 && neverFalse === 0) {
    return VERDICTS.EXACT;
  }
  if (rowCoverage >= 0.8 && distinctSignatureShare >= 0.25 && neverFalse <= 3) {
    return VERDICTS.PARTIAL;
  }
  return VERDICTS.MARGINAL;
}


