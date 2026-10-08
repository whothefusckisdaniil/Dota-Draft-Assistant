/**
 * Build assembly core — pure, no I/O, no network.
 *
 * The LAST research/design gate before the production engine. It organises
 * the two already-proven layers, nothing more:
 *
 *   ItemPrior (WHAT, STRATZ-measured) + BuildPhasePrior (WHEN/PHASE, Valve
 *   categorical evidence)  ->  assembled phase build for display.
 *
 * What this module deliberately does NOT do:
 *   - create candidates (only getBuildCandidates output enters assembleBuild);
 *   - interpret Valve phases as minutes/timing or as an exact purchase order;
 *   - order inside a phase by anything but the inherited ItemPrior rank;
 *   - build a component/upgrade dependency tree;
 *   - add situational/core/counter labels, enemy/capability/matchup signals,
 *     new weights, or any fallback to another position/hero/global build.
 *
 * Determinism: every sort has a full comparator ending in itemId; no
 * Object.entries() iteration order ever decides placement.
 */

/** Display phases, in canonical presentation order. Valve categorical phases. */
export const DISPLAY_PHASES = Object.freeze([
  'starting',
  'early',
  'core',
  'mid',
  'late',
  'luxury',
]);

/** Presentation caps per phase (§7). A cap, not a threshold: fewer -> shorter
 * phase; more -> top-N by canonical order. Never tuned on results. */
export const PHASE_CAPACITY = Object.freeze({
  starting: 3,
  early: 3,
  core: 5,
  mid: 3,
  late: 3,
  luxury: 3,
});

/** No phase evidence mapping to a display phase. Fail-closed bucket. */
export const NO_PHASE = 'NO_PHASE';

/** Items without a mappable phase land here: counted, never force-fitted. */
export const OVERFLOW_PHASE = 'overflow';

/** Canonical Valve-name -> display phase mapping.
 * Other_Items is ABSENT on purpose: it is Valve's miscellaneous bucket, not
 * a timed phase; force-fitting it into luxury/late would invent a claim
 * Valve never made. */
export const VALVE_TO_DISPLAY = Object.freeze({
  Starting_Items: 'starting',
  Starting_Items_Secondary: 'starting',
  Early_Game: 'early',
  Early_Game_Secondary: 'early',
  Core_Items: 'core',
  Core_Items_Secondary: 'core',
  Mid_Items: 'mid',
  Late_Items: 'late',
  Luxury: 'luxury',
});

const DISPLAY_ORDER = new Map(DISPLAY_PHASES.map((p, i) => [p, i]));
const VALVE_PHASE_ORDER = [
  'Starting_Items',
  'Starting_Items_Secondary',
  'Early_Game',
  'Early_Game_Secondary',
  'Core_Items',
  'Core_Items_Secondary',
  'Mid_Items',
  'Late_Items',
  'Luxury',
  'Other_Items',
];
const VALVE_ORDER = new Map(VALVE_PHASE_ORDER.map((p, i) => [p, i]));

/** Deterministic canonical phase for one candidate.
 * Reads candidate.evidence.phase (the BuildPhasePrior bundle) and nothing
 * else: no item names, no catalogue flags, no timing medians. Several Valve
 * phases -> earliest display phase wins (fixed rule, stated before results).
 * @returns {{ phase: string, reason: string | null }} */
export function canonicalDisplayPhase(candidate) {
  const phaseEv = candidate?.evidence?.phase;
  if (!phaseEv || phaseEv.status !== 'available') {
    return { phase: NO_PHASE, reason: phaseEv?.reason ?? 'no_phase_evidence' };
  }
  const names = [...(phaseEv.value?.phases ?? [])];
  const mapped = [];
  for (const name of names) {
    const display = VALVE_TO_DISPLAY[name];
    if (display !== undefined && !mapped.includes(display)) mapped.push(display);
  }
  if (mapped.length === 0) return { phase: NO_PHASE, reason: 'no_mapped_phase' };
  mapped.sort((a, b) => DISPLAY_ORDER.get(a) - DISPLAY_ORDER.get(b));
  return { phase: mapped[0], reason: null };
}
/** Build-level status codes. NO_BUILD_DATA = no valid ItemPrior (§12). */
export const ASSEMBLY_STATUS = Object.freeze({
  OK: 'OK',
  NO_BUILD_DATA: 'NO_BUILD_DATA',
});

function rankOf(c) {
  const r = c?.rank;
  return Number.isInteger(r) && r > 0 ? r : Number.MAX_SAFE_INTEGER;
}

function scoreOf(c) {
  const s = c?.itemPrior?.score ?? c?.score;
  return typeof s === 'number' && Number.isFinite(s) ? s : Number.NEGATIVE_INFINITY;
}

function phaseProvenance(c) {
  const ev = c?.evidence?.phase;
  if (!ev) return { status: 'unavailable', reason: 'no_phase_evidence', phases: [] };
  if (ev.status !== 'available') {
    return {
      status: ev.status,
      ...(ev.source === undefined ? {} : { source: ev.source }),
      reason: ev.reason ?? 'unknown',
      phases: [],
    };
  }
  const phases = [...(ev.value?.phases ?? [])].sort((a, b) =>
    (VALVE_ORDER.get(a) ?? Number.MAX_SAFE_INTEGER) -
      (VALVE_ORDER.get(b) ?? Number.MAX_SAFE_INTEGER) ||
    (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0),
  );
  const familyOrder = ['starting', 'early', 'mid', 'late', 'other'];
  const phaseFamilies = [...(ev.value?.phaseFamilies ?? [])].sort((a, b) =>
    familyOrder.indexOf(a) - familyOrder.indexOf(b) ||
    (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0),
  );
  const agreement = ev.value?.agreement;
  return {
    status: 'available',
    source: ev.source ?? 'ValveItemBuild',
    phases,
    phaseFamilies,
    phaseExclusive: ev.value?.phaseExclusive === true,
    ...(agreement === undefined ? {} : {
      agreement: {
        decision: agreement.decision,
        reason: agreement.reason,
        families: [...(agreement.families ?? [])].sort((a, b) =>
          familyOrder.indexOf(a) - familyOrder.indexOf(b) ||
          (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0),
        ),
        detail: agreement.detail,
      },
    }),
  };
}

function comparePhaseEvidence(a, b) {
  const ae = a?.evidence?.phase;
  const be = b?.evidence?.phase;
  const available = (ev) =>
    ev?.status === 'available' &&
    (ev.value?.phases ?? []).some((name) => VALVE_TO_DISPLAY[name] !== undefined);
  const aAvailable = available(ae);
  const bAvailable = available(be);
  if (aAvailable !== bAvailable) return aAvailable ? -1 : 1;
  if (!aAvailable) return 0;
  const aExclusive = ae.value?.phaseExclusive === true;
  const bExclusive = be.value?.phaseExclusive === true;
  if (aExclusive !== bExclusive) return aExclusive ? -1 : 1;
  const aSupported = ae.value?.agreement?.decision === 'supported';
  const bSupported = be.value?.agreement?.decision === 'supported';
  if (aSupported !== bSupported) return aSupported ? -1 : 1;
  return 0;
}

function displayPhaseOrder(candidate) {
  const phase = canonicalDisplayPhase(candidate).phase;
  return DISPLAY_ORDER.get(phase) ?? Number.MAX_SAFE_INTEGER;
}

function compareCandidates(a, b) {
  return comparePhaseEvidence(a, b) ||
    displayPhaseOrder(a) - displayPhaseOrder(b) ||
    rankOf(a) - rankOf(b) ||
    scoreOf(b) - scoreOf(a) ||
    a.itemId - b.itemId;
}

/** Assemble one hero/position build from the getBuildCandidates() dataset
 * (§4-§8, §12). Pure: accepts that layer's output (or same-shape doubles) —
 * never calls it, never I/O, never invents candidates. Order inside a phase
 * is PRESENTATION order (ItemPrior rank), never a purchase sequence (§6). */
export function assembleBuild(heroId, position, candidates) {
  const posKey = String(position);
  const emptyPhases = () => Object.fromEntries(DISPLAY_PHASES.map((p) => [p, []]));

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return {
      heroId, position: posKey, status: ASSEMBLY_STATUS.NO_BUILD_DATA,
      phases: emptyPhases(), overflow: [],
      stats: {
        candidateCount: 0, uniqueCount: 0, droppedByDedupe: 0,
        droppedWrongCell: 0, overflowCount: 0, droppedByCapacity: 0,
        emptyPhases: [...DISPLAY_PHASES],
      },
    };
  }

  let droppedWrongCell = 0;
  let droppedByDedupe = 0;
  const byItem = new Map();
  for (const c of candidates) {
    if (c?.heroId !== heroId || String(c?.position) !== posKey || !Number.isInteger(c?.itemId)) {
      droppedWrongCell += 1;
      continue;
    }
    const prev = byItem.get(c.itemId);
    if (prev === undefined) {
      byItem.set(c.itemId, c);
    } else {
      droppedByDedupe += 1;
      if (compareCandidates(c, prev) < 0) byItem.set(c.itemId, c);
    }
  }

  const buckets = new Map(DISPLAY_PHASES.map((p) => [p, []]));
  const overflow = [];
  for (const c of byItem.values()) {
    const { phase, reason } = canonicalDisplayPhase(c);
    const item = {
      itemId: c.itemId,
      phase,
      itemPriorRank: rankOf(c) === Number.MAX_SAFE_INTEGER ? null : rankOf(c),
      itemPriorScore: scoreOf(c) === Number.NEGATIVE_INFINITY ? null : scoreOf(c),
      phaseEvidence: phaseProvenance(c),
      phaseReason: reason,
    };
    if (phase === NO_PHASE) overflow.push(item);
    else buckets.get(phase).push(item);
  }

  const byRank = (a, b) =>
    (a.itemPriorRank ?? Number.MAX_SAFE_INTEGER) - (b.itemPriorRank ?? Number.MAX_SAFE_INTEGER) ||
    (b.itemPriorScore ?? Number.NEGATIVE_INFINITY) - (a.itemPriorScore ?? Number.NEGATIVE_INFINITY) ||
    a.itemId - b.itemId;
  for (const list of buckets.values()) list.sort(byRank);
  overflow.sort(byRank);

  let droppedByCapacity = 0;
  const phases = {};
  for (const p of DISPLAY_PHASES) {
    const list = buckets.get(p);
    if (list.length > PHASE_CAPACITY[p]) {
      droppedByCapacity += list.length - PHASE_CAPACITY[p];
      phases[p] = list.slice(0, PHASE_CAPACITY[p]);
    } else {
      phases[p] = list;
    }
  }

  const emptyList = DISPLAY_PHASES.filter((p) => phases[p].length === 0);
  return {
    heroId, position: posKey,
    status: byItem.size === 0 ? ASSEMBLY_STATUS.NO_BUILD_DATA : ASSEMBLY_STATUS.OK,
    phases, overflow,
    stats: {
      candidateCount: candidates.length, uniqueCount: byItem.size,
      droppedByDedupe, droppedWrongCell, overflowCount: overflow.length,
      droppedByCapacity, emptyPhases: emptyList,
    },
  };
}

/** Structural invariants for one assembled build (§16). Empty = valid. */
export function validateAssembledBuild(build, candidateIds) {
  const violations = [];
  const allowed = candidateIds === undefined ? null : new Set(candidateIds);
  const seen = new Set();
  if (!build || !build.phases || typeof build.phases !== 'object') {
    return ['phases_not_object'];
  }
  if (!Array.isArray(build.overflow)) violations.push('overflow_not_array');
  for (const phase of Object.keys(build.phases)) {
    if (!DISPLAY_ORDER.has(phase)) violations.push(`phase_invalid:${phase}`);
  }
  for (const phase of DISPLAY_PHASES) {
    if (Array.isArray(build.phases[phase]) &&
      build.phases[phase].length > PHASE_CAPACITY[phase]) {
      violations.push(`phase_capacity:${phase}`);
    }
  }
  const compareItems = (a, b) => {
    const rankDifference =
      (a.itemPriorRank ?? Number.MAX_SAFE_INTEGER) -
      (b.itemPriorRank ?? Number.MAX_SAFE_INTEGER);
    if (rankDifference !== 0) return rankDifference;
    const aScore = Number.isFinite(a.itemPriorScore)
      ? a.itemPriorScore
      : Number.NEGATIVE_INFINITY;
    const bScore = Number.isFinite(b.itemPriorScore)
      ? b.itemPriorScore
      : Number.NEGATIVE_INFINITY;
    if (aScore !== bScore) return bScore > aScore ? 1 : -1;
    return a.itemId - b.itemId;
  };
  for (const p of DISPLAY_PHASES) {
    const list = build?.phases?.[p];
    if (!Array.isArray(list)) {
      violations.push(`phase_not_array:${p}`);
      continue;
    }
    for (let i = 0; i < list.length; i += 1) {
      const it = list[i];
      if (!it || typeof it !== 'object') {
        violations.push(`item_invalid:${p}:${i}`);
        continue;
      }
      if (seen.has(it.itemId)) violations.push(`duplicate:${it.itemId}`);
      seen.add(it.itemId);
      if (it.phase !== p) violations.push(`phase_mismatch:${it.itemId}`);
      if (!Number.isInteger(it.itemId)) violations.push(`item_id_invalid:${p}:${i}`);
      if (!Number.isInteger(it.itemPriorRank) || it.itemPriorRank < 1) {
        violations.push(`rank_invalid:${it.itemId}`);
      }
      const evidencePhases = it.phaseEvidence?.phases;
      if (!it.phaseEvidence || it.phaseEvidence.status !== 'available') {
        violations.push(`phase_evidence_missing:${it.itemId}`);
      } else if (!Array.isArray(evidencePhases) ||
        !evidencePhases.some((name) => VALVE_TO_DISPLAY[name] !== undefined)) {
        violations.push(`phase_evidence_unmapped:${it.itemId}`);
      } else if (canonicalDisplayPhase({
        evidence: { phase: { status: 'available', value: { phases: evidencePhases } } },
      }).phase !== p) {
        violations.push(`phase_not_canonical:${it.itemId}`);
      }
      if (allowed && !allowed.has(it.itemId)) violations.push(`outside_candidates:${it.itemId}`);
      if (i > 0 && list[i - 1] && compareItems(list[i - 1], it) > 0) {
        violations.push(`rank_order:${p}`);
      }
    }
  }
  for (const it of Array.isArray(build?.overflow) ? build.overflow : []) {
    if (!it || typeof it !== 'object') {
      violations.push('overflow_item_invalid');
      continue;
    }
    if (seen.has(it.itemId)) violations.push(`duplicate:${it.itemId}`);
    seen.add(it.itemId);
    if (it.phase !== NO_PHASE) violations.push(`overflow_phase:${it.itemId}`);
    const overflowEvidence = it.phaseEvidence;
    const overflowHasMappedPhase = Array.isArray(overflowEvidence?.phases) &&
      overflowEvidence.phases.some((name) => VALVE_TO_DISPLAY[name] !== undefined);
    if (!overflowEvidence ||
      !['available', 'unavailable'].includes(overflowEvidence.status) ||
      overflowEvidence.status === 'available' &&
        (!Array.isArray(overflowEvidence.phases) || overflowHasMappedPhase)) {
      violations.push(`overflow_evidence_mismatch:${it.itemId}`);
    }
    if (!Number.isInteger(it.itemId)) violations.push(`item_id_invalid:overflow:${it.itemId}`);
    if (allowed && !allowed.has(it.itemId)) violations.push(`outside_candidates:${it.itemId}`);
  }
  for (let i = 1; i < (build?.overflow?.length ?? 0); i += 1) {
    if (build.overflow[i - 1] && build.overflow[i] &&
      compareItems(build.overflow[i - 1], build.overflow[i]) > 0) {
      violations.push('rank_order:overflow');
      break;
    }
  }
  return violations;
}
