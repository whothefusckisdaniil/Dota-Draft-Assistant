/**
 * Phase / timing agreement (ТЗ №19 §19-§21).
 *
 * PURE DIAGNOSTIC. This decides nothing about ranking — it only reports whether
 * two independent sources point the same way about WHEN an item is bought.
 *
 * The boundaries below are RESEARCH CONSTANTS, measured in ТЗ №18 and
 * deliberately not promoted to production truth. They are named, exported and
 * isolated here precisely so a future change is a visible decision rather than
 * an accident buried in a scoring function.
 *
 * Measured behaviour of this rule on the current snapshot:
 * agreement 25 %, undecided 75 %, conflict 0 %. `undecided` is a valid, common
 * outcome and is never rounded into agreement to make a table look tidier.
 */

/**
 * Empirical purchase timing for one (hero, position, item), derived from the
 * STRATZ `byMinute` histogram. Declared here (not in buildPhasePrior) so the
 * agreement rule can depend on it without an import cycle.
 *
 * `status` is explicit: a cell with no purchases and a cell with no statistics
 * at all are different situations, and neither is silently filled in from a
 * global or neighbouring-position value.
 */
export type TimingEvidence =
  | {
      status: 'available';
      source: 'STRATZItemStats';
      value: {
        p25Minute: number;
        medianMinute: number;
        p75Minute: number;
        meanMinute: number;
        /** Share of purchase events in each exploratory bucket. */
        earlyShare: number;
        midShare: number;
        lateShare: number;
        veryLateShare: number;
        totalEvents: number;
      };
    }
  | { status: 'unavailable'; source: 'STRATZItemStats'; reason: TimingUnavailableReason };

/**
 * Deterministic reason codes (ТЗ §22), declared here so the agreement rule can
 * name them without importing the bundle module (which depends on this one).
 *
 * These are identifiers, not sentences: a UI may render them as text later, but
 * the scoring data never carries prose.
 */
export type TimingUnavailableReason =
  | 'no_stratz_cell' | 'zero_purchases' | 'empty_histogram';

/** Valve build phase, as authored by Valve. Categorical, never a time range. */
export type ValvePhase =
  | 'Starting_Items' | 'Starting_Items_Secondary'
  | 'Early_Game' | 'Early_Game_Secondary'
  | 'Core_Items' | 'Core_Items_Secondary'
  | 'Mid_Items' | 'Late_Items' | 'Luxury' | 'Other_Items';

/** Valve's own ordering. Used for stable display and sorting, not for time. */
export const VALVE_PHASE_ORDER: ValvePhase[] = [
  'Starting_Items', 'Starting_Items_Secondary',
  'Early_Game', 'Early_Game_Secondary',
  'Core_Items', 'Core_Items_Secondary',
  'Mid_Items', 'Late_Items', 'Luxury', 'Other_Items',
];

/** Coarse families, for the agreement rule and for readable output. */
export type PhaseFamily = 'starting' | 'early' | 'mid' | 'late' | 'other';

export const PHASE_FAMILY: Record<ValvePhase, PhaseFamily> = {
  Starting_Items: 'starting', Starting_Items_Secondary: 'starting',
  Early_Game: 'early', Early_Game_Secondary: 'early',
  Core_Items: 'mid', Core_Items_Secondary: 'mid',
  Mid_Items: 'mid',
  Late_Items: 'late', Luxury: 'late',
  Other_Items: 'other',
};

/**
 * RESEARCH boundaries. A STRATZ median below this is "clearly early" for the
 * purposes of this diagnostic; above the second, "clearly late". Chosen from
 * the ТЗ №18 distribution, and revisable — they are not gameplay constants.
 */
export const AGREEMENT_BOUNDARIES = {
  /** median strictly below this counts as clearly early */
  earlyMedianBelow: 15,
  /** median at or above this counts as clearly late */
  lateMedianAtOrAbove: 30,
} as const;

export type AgreementDecision = 'supported' | 'undecided' | 'conflicting' | 'unavailable';

export type AgreementReason =
  | 'no_phase' | 'no_timing' | 'not_decidable' | 'agreement' | 'conflict';

export interface AgreementResult {
  decision: AgreementDecision;
  reason: AgreementReason;
  /** Families Valve asserted, for display. Empty when unavailable. */
  families: PhaseFamily[];
  /** Why, in short deterministic terms — never a long prose sentence. */
  detail: string;
}

const EARLY_FAMILIES = new Set<PhaseFamily>(['starting', 'early']);
const LATE_FAMILIES = new Set<PhaseFamily>(['late']);

/**
 * Compare a Valve phase set against a STRATZ timing sample.
 *
 * Returns `undecided` whenever the two are not on opposite ends of the
 * boundaries — including the very common case where Valve says `Mid_Items` and
 * the median lands mid-range. Forcing a decision there would be inventing one.
 */
export function getPhaseAgreement(
  phases: readonly ValvePhase[],
  timing: { status: 'available' | 'unavailable'; value?: { medianMinute: number | null } },
): AgreementResult {
  const families = [...new Set(phases.map((p) => PHASE_FAMILY[p]).filter(Boolean))];

  if (phases.length === 0) {
    return { decision: 'unavailable', reason: 'no_phase', families: [], detail: 'valve_has_no_phase' };
  }
  if (timing.status !== 'available' || !timing.value || timing.value.medianMinute === null) {
    return { decision: 'unavailable', reason: 'no_timing', families, detail: 'stratz_has_no_timing' };
  }

  const { earlyMedianBelow, lateMedianAtOrAbove } = AGREEMENT_BOUNDARIES;
  const median = timing.value.medianMinute;
  const saysEarly = families.some((f) => EARLY_FAMILIES.has(f));
  const saysLate = families.some((f) => LATE_FAMILIES.has(f));
  const timingEarly = median < earlyMedianBelow;
  const timingLate = median >= lateMedianAtOrAbove;
  const label = families.join('+');

  if (saysEarly && timingEarly) {
    return { decision: 'supported', reason: 'agreement', families, detail: `valve_${label}_timing_early` };
  }
  if (saysLate && timingLate) {
    return { decision: 'supported', reason: 'agreement', families, detail: `valve_${label}_timing_late` };
  }
  if (saysEarly && timingLate) {
    return { decision: 'conflicting', reason: 'conflict', families, detail: `valve_${label}_timing_late` };
  }
  if (saysLate && timingEarly) {
    return { decision: 'conflicting', reason: 'conflict', families, detail: `valve_${label}_timing_early` };
  }
  return { decision: 'undecided', reason: 'not_decidable', families, detail: `valve_${label}_timing_mid` };
}
