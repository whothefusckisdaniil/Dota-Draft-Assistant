import type { ItemPrior } from './itemPrior';

/**
 * Build-phase prior (ТЗ №18). PURE and production-safe.
 *
 * Combines two INDEPENDENT sources into one row per (hero, position, item):
 *
 *   STRATZ  -> Hero + Position -> Item   (frequency, share, lift, timing)
 *   Valve   -> Hero + Item -> Phase      (categorical build labels)
 *
 * Three things this module deliberately does NOT do, because the data cannot
 * support them:
 *
 *  1. It never invents a POSITION for the Valve side. Valve itembuilds carry no
 *     position, so a phase prior is `Hero + Item`. Position-specific relevance
 *     exists only in the STRATZ layer, and a global phase is never presented as
 *     position-specific evidence.
 *  2. It never converts a Valve phase into minutes. `Late_Items` is a label, not
 *     "after minute 22". Phase and empirical purchase timing are two separate
 *     axes that happen to be comparable, not the same axis.
 *  3. It never reconstructs build ORDER. An unordered phase set plus an
 *     unordered timing histogram cannot yield "A -> B -> C".
 *
 * It is also not wired into the UI or the hero ranking. Nothing in the app
 * imports it yet.
 */

/** A Valve build phase, in Valve's own order. Categorical, not a time scale. */
export type ValvePhase =
  | 'Starting_Items' | 'Starting_Items_Secondary'
  | 'Early_Game' | 'Early_Game_Secondary'
  | 'Core_Items' | 'Core_Items_Secondary'
  | 'Mid_Items' | 'Late_Items' | 'Luxury' | 'Other_Items';

export const VALVE_PHASE_ORDER: ValvePhase[] = [
  'Starting_Items', 'Starting_Items_Secondary',
  'Early_Game', 'Early_Game_Secondary',
  'Core_Items', 'Core_Items_Secondary',
  'Mid_Items', 'Late_Items', 'Luxury', 'Other_Items',
];

/** Broad phase families, for readable output. Never used to infer time. */
export const PHASE_FAMILY: Record<string, 'starting' | 'early' | 'mid' | 'late' | 'other'> = {
  Starting_Items: 'starting',
  Starting_Items_Secondary: 'starting',
  Early_Game: 'early',
  Early_Game_Secondary: 'early',
  Core_Items: 'mid',
  Core_Items_Secondary: 'mid',
  Mid_Items: 'mid',
  Late_Items: 'late',
  Luxury: 'late',
  Other_Items: 'other',
};

/**
 * Research-only agreement check between a Valve phase and the empirical STRATZ
 * median purchase minute (§10).
 *
 * The boundaries are EXPLICIT research constants, not production rules and not
 * derived from minutes-per-phase. They exist to measure how often the two
 * sources point the same way; nothing in the app consumes the result.
 */
export const RESEARCH_AGREEMENT_BOUNDARIES = {
  /** median below this is "early" for comparison purposes. */
  earlyMedianMax: 15,
  /** median above this is "late". */
  lateMedianMin: 30,
} as const;

const EARLIEST_FAMILIES = new Set(['starting', 'early']);
const LATEST_FAMILIES = new Set(['late']);

export function classifyPhaseAgreement(
  phases: ValvePhase[],
  medianMinute: number | null,
): PhaseAgreement {
  if (phases.length === 0) {
    return { type: 'unknown', details: 'no Valve phase for this (hero, item)' };
  }
  if (medianMinute === null) {
    return { type: 'unknown', details: 'no STRATZ timing histogram for this (hero, position, item)' };
  }
  const families = [...new Set(phases.map((p) => PHASE_FAMILY[p]).filter(Boolean))];
  const { earlyMedianMax, lateMedianMin } = RESEARCH_AGREEMENT_BOUNDARIES;

  const saysEarly = families.some((f) => EARLIEST_FAMILIES.has(f));
  const saysLate = families.some((f) => LATEST_FAMILIES.has(f));
  const timingEarly = medianMinute < earlyMedianMax;
  const timingLate = medianMinute >= lateMedianMin;

  if (saysEarly && timingEarly) {
    return { type: 'agreement', details: `Valve ${families.join('/')} and STRATZ median ${medianMinute.toFixed(0)}m both early` };
  }
  if (saysLate && timingLate) {
    return { type: 'agreement', details: `Valve ${families.join('/')} and STRATZ median ${medianMinute.toFixed(0)}m both late` };
  }
  // A conflict is the two sources landing on OPPOSITE ends. Anything between
  // the boundaries is simply not decisive, and is reported as such rather than
  // rounded into agreement.
  if (saysEarly && timingLate) {
    return { type: 'conflict', details: `Valve says ${families.join('/')} but STRATZ median is ${medianMinute.toFixed(0)}m (late)` };
  }
  if (saysLate && timingEarly) {
    return { type: 'conflict', details: `Valve says ${families.join('/')} but STRATZ median is ${medianMinute.toFixed(0)}m (early)` };
  }
  return { type: 'unknown', details: `Valve ${families.join('/')} vs STRATZ median ${medianMinute.toFixed(0)}m: neither boundary is decisive` };
}

export interface BuildPhasePriorInput {
  heroId: number;
  position: number;
  /** STRATZ priors for that (hero, position), already ordered. */
  priors: ItemPrior[];
  catalogue: Record<number, CatalogEntry>;
  valve: ValvePhaseData;
  /** Valve keys its files by `npc_dota_hero_<name>`; supplied, not derived. */
  valveHeroKey: string | null;
}

/**
 * Join STRATZ priors with Valve phase evidence for one (hero, position) (§7).
 *
 * The join is on `hero` and `item` only. No enemy, and no position on the Valve
 * side — Valve itembuilds carry no position, so a phase prior is `Hero + Item`
 * and must not be presented as position-specific evidence (§21).
 */
export function getBuildPhasePrior(input: BuildPhasePriorInput): {
  rows: BuildPhasePrior[];
  valveReport: ValveMappingReport;
  valveSource: string;
} {
  const map = buildValveItemMap(input.catalogue);
  const valveHero = input.valveHeroKey ? input.valve.heroes[input.valveHeroKey] : undefined;
  const { byItem, report } = mapHeroItems(valveHero, map);
  const valveSource = input.valve.source?.repository
    ? `${input.valve.source.repository}@${(input.valve.source.sourceCommit ?? '').slice(0, 10)}`
    : 'valve-itembuilds';

  const rows = input.priors.map((prior) => {
    const phases = byItem.get(prior.itemId) ?? [];
    const timing = {
      p25: prior.p25PurchaseMinute,
      median: prior.medianPurchaseMinute,
      p75: prior.p75PurchaseMinute,
    };
    const row: BuildPhasePrior = {
      heroId: input.heroId,
      position: input.position,
      itemId: prior.itemId,
      itemName: prior.itemName,
      itemPrior: prior,
      timing,
    };
    if (phases.length > 0) {
      row.valve = {
        phases,
        phaseFamilies: [...new Set(phases.map((p) => PHASE_FAMILY[p]).filter(Boolean))],
        source: valveSource,
        phaseExclusive: phases.length === 1,
      };
      row.phaseAgreement = classifyPhaseAgreement(phases, timing.median);
    } else {
      // No Valve opinion. NOT a fallback, NOT "this item is wrong for the hero".
      row.phaseAgreement = { type: 'unknown', details: 'no Valve phase for this (hero, item)' };
    }
    return row;
  });

  return { rows, valveReport: report, valveSource };
}

export interface ValvePhaseData {
  /** `npc_dota_hero_bane` -> { phases: { Mid_Items: ['item_magic_wand', ...] } } */
  heroes: Record<string, { author?: string | null; sourceFile?: string; phases: Record<string, string[]> }>;
  source?: { repository?: string; path?: string; sourceCommit?: string; isOfficialValveApi?: boolean };
}

/** Catalogue entry, the minimum needed to resolve a Valve item name. */
export interface CatalogEntry {
  id: number;
  dname: string;
  name: string;
}

/** How the Valve/STRATZ phases relate, when they are comparable at all. */
export type PhaseAgreement =
  | { type: 'agreement'; details: string }
  | { type: 'conflict'; details: string }
  | { type: 'unknown'; details: string };

export interface BuildPhasePrior {
  heroId: number;
  position: number;
  itemId: number;
  itemName: string;
  /** The STRATZ prior this row is built on, unchanged. */
  itemPrior: ItemPrior;
  /**
   * Valve evidence for (hero, item). `undefined` means Valve has no opinion —
   * NOT "the item is bad", and never back-filled from another hero.
   */
  valve?: {
    phases: ValvePhase[];
    phaseFamilies: string[];
    source: string;
    /** false when the item appears in several phases, i.e. the label is fuzzy. */
    phaseExclusive: boolean;
  };
  timing: {
    p25: number | null;
    median: number | null;
    p75: number | null;
  };
  phaseAgreement?: PhaseAgreement;
}

/**
 * Deterministic Valve-name -> canonical itemId map.
 *
 * Valve itembuilds use internal names (`item_bfury`), and the catalogue's
 * `dname` holds the same string, so the join is exact. There is no fuzzy
 * matching, no normalisation and no fallback: an unmapped name is reported, not
 * guessed (§4).
 */
export function buildValveItemMap(catalogue: Record<number, CatalogEntry>) {
  const byDname = new Map<string, number>();
  const ambiguous = new Set<string>();
  for (const entry of Object.values(catalogue)) {
    if (byDname.has(entry.dname)) ambiguous.add(entry.dname);
    byDname.set(entry.dname, entry.id);
  }
  return {
    /** @returns the canonical id, or null when the name is not in the catalogue. */
    resolve: (valveName: string): number | null => {
      if (ambiguous.has(valveName)) return null;
      const id = byDname.get(valveName);
      return id === undefined ? null : id;
    },
    size: byDname.size,
  };
}

export interface ValveMappingReport {
  resolved: number;
  /** Valve names with no catalogue entry. Reported, never dropped silently. */
  unresolved: string[];
  /** `item_recipe_*` and similar: real Valve entities, deliberately not items. */
  recipeLike: string[];
}

/**
 * Map every Valve item name for one hero onto canonical ids (§4, §5).
 * Valve recipes are kept OUT of the item namespace: a recipe is not a buildable
 * item, and the catalogue does not contain recipes by design.
 */
export function mapHeroItems(
  valveHero: ValvePhaseData['heroes'][string] | undefined,
  map: ReturnType<typeof buildValveItemMap>,
): { byItem: Map<number, ValvePhase[]>; report: ValveMappingReport } {
  const byItem = new Map<number, ValvePhase[]>();
  const report: ValveMappingReport = { resolved: 0, unresolved: [], recipeLike: [] };
  if (!valveHero) return { byItem, report };

  for (const [phase, names] of Object.entries(valveHero.phases)) {
    for (const name of names) {
      if (/^item_recipe_/.test(name)) {
        if (!report.recipeLike.includes(name)) report.recipeLike.push(name);
        continue;
      }
      const id = map.resolve(name);
      if (id === null) {
        if (!report.unresolved.includes(name)) report.unresolved.push(name);
        continue;
      }
      report.resolved += 1;
      const list = byItem.get(id) ?? [];
      if (!list.includes(phase as ValvePhase)) list.push(phase as ValvePhase);
      byItem.set(id, list);
    }
  }
  for (const list of byItem.values()) {
    list.sort((a, b) => VALVE_PHASE_ORDER.indexOf(a) - VALVE_PHASE_ORDER.indexOf(b));
  }
  return { byItem, report };
}

