import { getItemPrior, type ItemPrior, type ItemPriorDataset } from './itemPrior';
import { histogramStats, histogramTotal } from './itemStats';
import {
  getPhaseAgreement,
  PHASE_FAMILY,
  VALVE_PHASE_ORDER,
  type AgreementResult,
  type PhaseFamily,
  type TimingEvidence,
  type TimingUnavailableReason,
  type ValvePhase,
} from './buildPhaseAgreement';
import type { ItemStatsDataset, ItemCatalogue } from '../types';

/**
 * Build Phase Prior (ТЗ §19) — a typed EVIDENCE BUNDLE for one
 * (hero, position, item) triple.
 *
 * ## The one rule this file exists to enforce
 *
 * **Absence of evidence is not a negative signal.** A `BuildPhasePrior` never
 * collapses its sources into one number, and never lets a missing source look
 * like a discouraging one. Concretely, §3 and §15:
 *
 *   - "Valve does not know this hero"        -> `valveHero: unavailable`
 *   - "Valve knows the hero, item not in it"  -> `valveItem: AVAILABLE with
 *                                                present: false`
 *
 * Those are opposite signals and they must never be confused. The second one is
 * real, measured negative evidence; the first one is simply ignorance.
 *
 * ## What this type deliberately does NOT contain
 *
 * No `finalScore`, no `combinedScore`, no `confidenceScore` (§9): with 75 % of
 * rows undecided, any blend would hide an arbitrary weight choice inside a
 * number. No enemy input (§10), no slots (§11), no ordering (§12).
 */

/** A value that is either present with a source, or explicitly unavailable. */
export type Evidence<T> =
  | { status: 'available'; source: string; value: T }
  | { status: 'unavailable'; source: string; reason: UnavailableReason };

/** Deterministic reason codes (§22). No prose lives in the data. */
export type UnavailableReason =
  // hero
  | 'no_build_file' | 'hero_key_mismatch'
  // item
  | 'hero_data_unavailable' | 'item_mapping_unresolved' | 'item_not_in_catalogue'
  // stratz
  | 'no_stratz_cell' | 'no_stats' | 'zero_purchases' | 'empty_histogram'
  // phase
  | 'no_phase' | 'no_timing';

export const VALVE_SOURCE = 'ValveItemBuild';
export const STRATZ_SOURCE = 'STRATZItemStats';
export const PRIOR_SOURCE = 'STRATZItemPrior';

/** §2 — does Valve have a build file for this hero at all? */
export type HeroEvidence =
  | { status: 'available'; source: string; heroKey: string; buildFile: string | null }
  | {
      status: 'unavailable';
      source: string;
      heroKey: string;
      reason: 'no_build_file' | 'hero_key_mismatch';
    };

/**
 * §3/§15 — is this item in the hero's Valve build?
 *
 * `present: false` is a REAL NEGATIVE: Valve authored a build for this hero and
 * the item is not in it. That is different from not knowing the hero at all.
 */
export type ItemEvidence =
  | {
      status: 'available';
      source: string;
      heroKey: string;
      value: { present: boolean; phases: ValvePhase[]; phaseFamilies: PhaseFamily[] };
    }
  | { status: 'unavailable'; source: string; reason: ItemUnavailableReason };

/**
 * Why item evidence is missing. Narrower than the general `UnavailableReason` on
 * purpose: an item can only go missing for an item-scoped reason, and the
 * compiler should reject anything else here (ТЗ §19.1 §8).
 */
export type ItemUnavailableReason =
  | 'hero_data_unavailable'
  | 'item_mapping_unresolved'
  | 'item_not_in_catalogue';

/** §4 — what Valve said about the phase, and whether timing corroborates it. */
export type PhaseEvidence =
  | {
      status: 'available';
      source: string;
      value: {
        phases: ValvePhase[];
        phaseFamilies: PhaseFamily[];
        /** false when the item sits in several phases: the label is fuzzy. */
        phaseExclusive: boolean;
        agreement: AgreementResult;
      };
    }
  | { status: 'unavailable'; source: string; reason: PhaseUnavailableReason };

/**
 * Why phase evidence is missing (ТЗ §19.1 §5, §8).
 *
 * The upstream cause is preserved verbatim. Collapsing
 * `item_mapping_unresolved` into `hero_data_unavailable` would report a broken
 * item identity as a missing hero — a different defect with a different fix.
 */
export type PhaseUnavailableReason =
  | 'no_phase'
  | 'no_timing'
  | 'hero_data_unavailable'
  | 'item_mapping_unresolved'
  | 'item_not_in_catalogue';

/** §8 — the bundle. Five independent signals, no score. */
export interface BuildPhasePrior {
  heroId: number;
  position: number;
  itemId: number;

  /** §6 — the existing ItemPrior, reused, never re-derived. */
  itemPrior: Evidence<Pick<ItemPrior, 'score' | 'purchases' | 'heroGames' | 'purchaseEventsPerGame' | 'eventShare' | 'lift'>>;
  /** §5 — from the existing STRATZ histogram. */
  timing: TimingEvidence;
  /** §2 */
  valveHero: HeroEvidence;
  /** §3/§14 */
  valveItem: ItemEvidence;
  /** §4 */
  phase: PhaseEvidence;
}

/** The minimum this function needs; keeps the module testable and pure. */
/**
 * The pinned Valve itembuild snapshot, as consumed by the evidence model.
 *
 * Named and exported so downstream layers (build candidates, research) reuse
 * THIS shape instead of re-declaring a look-alike that could drift from it.
 */
export interface ValveBuildData {
  /** `npc_dota_hero_*` -> the phases Valve authored for that hero. */
  heroes: Record<string, { buildFile?: string | null; phases: Record<string, string[]> }>;
  source?: { repository?: string; sourceCommit?: string };
}

export interface BuildPhasePriorInput {
  heroId: number;
  position: number;
  itemId: number;
  heroes: { id: number; key: string }[];
  catalogue: ItemCatalogue;
  itemStats: ItemStatsDataset;
  valve: ValveBuildData;
}

/** §13 — the join is on the stored authoritative key. No slug, no alias. */
function valveHeroEvidence(input: BuildPhasePriorInput, heroKey: string): HeroEvidence {
  const build = input.valve.heroes[heroKey];
  if (!build) {
    return { status: 'unavailable', source: VALVE_SOURCE, heroKey, reason: 'no_build_file' };
  }
  return { status: 'available', source: VALVE_SOURCE, heroKey, buildFile: build.buildFile ?? null };
}

/** §14 — exact `dname` identity. A duplicated dname resolves to nothing. */
function resolveValveItemName(catalogue: ItemCatalogue, itemId: number): string | null {
  let found: string | null = null;
  for (const entry of Object.values(catalogue)) {
    if (entry.id !== itemId) continue;
    if (found !== null) return null; // ambiguous identity
    found = entry.dname;
  }
  return found;
}

/** §5 — timing from the EXISTING histogram; never recomputed, never filled in. */
function buildTiming(
  itemStats: ItemStatsDataset, heroId: number, position: string, itemId: number,
): TimingEvidence {
  const cell = itemStats[heroId]?.[position]?.[itemId];
  if (!cell) return { status: 'unavailable', source: STRATZ_SOURCE, reason: 'no_stratz_cell' };
  if (!cell.purchases || cell.purchases <= 0) {
    return { status: 'unavailable', source: STRATZ_SOURCE, reason: 'zero_purchases' };
  }
  if (histogramTotal(cell.byMinute) <= 0) {
    return { status: 'unavailable', source: STRATZ_SOURCE, reason: 'empty_histogram' };
  }
  const s = histogramStats(cell.byMinute);
  if (s.medianMinute === null || s.p25Minute === null || s.p75Minute === null || s.meanMinute === null) {
    return { status: 'unavailable', source: STRATZ_SOURCE, reason: 'empty_histogram' };
  }
  return {
    status: 'available',
    source: STRATZ_SOURCE,
    value: {
      p25Minute: s.p25Minute,
      medianMinute: s.medianMinute,
      p75Minute: s.p75Minute,
      meanMinute: s.meanMinute,
      earlyShare: s.earlyShare,
      midShare: s.midShare,
      lateShare: s.lateShare,
      veryLateShare: s.veryLateShare,
      totalEvents: s.total,
    },
  };
}

/** §6 — reuse `getItemPrior` verbatim. The formula is not duplicated here. */
function buildPriorEvidence(input: BuildPhasePriorInput): BuildPhasePrior['itemPrior'] {
  // The read-only slice getItemPrior() actually needs — no cast, no `as never`.
  const dataset: ItemPriorDataset = {
    items: input.catalogue,
    itemStats: input.itemStats,
  };
  const prior = getItemPrior(dataset, input.heroId, String(input.position))
    .find((p) => p.itemId === input.itemId);

  if (!prior) return { status: 'unavailable', source: PRIOR_SOURCE, reason: 'no_stratz_cell' };
  return {
    status: 'available',
    source: PRIOR_SOURCE,
    value: {
      score: prior.score,
      purchases: prior.purchases,
      heroGames: prior.heroGames,
      purchaseEventsPerGame: prior.purchaseEventsPerGame,
      eventShare: prior.eventShare,
      lift: prior.lift,
    },
  };
}

/**
 * §7 — the evidence bundle for one (hero, position, item).
 *
 * Lazy by construction: it touches only the cells it needs, so no Cartesian
 * product of heroes x positions x items is ever materialised (§23).
 */
export function getBuildPhasePrior(input: BuildPhasePriorInput): BuildPhasePrior {
  const { heroId, position, itemId } = input;
  const hero = input.heroes.find((h) => h.id === heroId);
  const heroKey = hero?.key ?? `npc_dota_hero_unknown_${heroId}`;

  const itemPrior = buildPriorEvidence(input);
  const timing = buildTiming(input.itemStats, heroId, String(position), itemId);
  const valveHero = valveHeroEvidence(input, heroKey);

  // §3: hero unknown -> item evidence UNAVAILABLE, never "absent".
  let valveItem: ItemEvidence;
  if (valveHero.status !== 'available') {
    valveItem = { status: 'unavailable', source: VALVE_SOURCE, reason: 'hero_data_unavailable' };
  } else {
    const valveName = resolveValveItemName(input.catalogue, itemId);
    if (valveName === null) {
      const inCatalogue = Object.values(input.catalogue).some((e) => e.id === itemId);
      valveItem = {
        status: 'unavailable',
        source: VALVE_SOURCE,
        reason: inCatalogue ? 'item_mapping_unresolved' : 'item_not_in_catalogue',
      };
    } else {
      // §16/§17: keep every phase Valve authored; dedupe, never pick one.
      const build = input.valve.heroes[heroKey];
      const phases = [...new Set(
        Object.entries(build.phases)
          .filter(([, names]) => names.includes(valveName))
          .map(([phase]) => phase)
          .filter((p): p is ValvePhase => (VALVE_PHASE_ORDER as string[]).includes(p)),
      )].sort((a, b) => VALVE_PHASE_ORDER.indexOf(a) - VALVE_PHASE_ORDER.indexOf(b));

      valveItem = {
        status: 'available',
        source: VALVE_SOURCE,
        heroKey,
        value: {
          present: phases.length > 0,
          phases,
          phaseFamilies: [...new Set(phases.map((p) => PHASE_FAMILY[p]))],
        },
      };
    }
  }

  // §5/§19.1: the UPSTREAM reason is preserved. A failed item mapping is not a
  // missing hero, and reporting it as one would hide a different defect.
  let phase: PhaseEvidence;
  if (valveItem.status !== 'available') {
    phase = { status: 'unavailable', source: VALVE_SOURCE, reason: valveItem.reason };
  } else if (valveItem.value.phases.length === 0) {
    // The hero IS known and the item simply is not in the build: a real,
    // measured negative — distinct from "Valve does not know this hero" (§3).
    phase = { status: 'unavailable', source: VALVE_SOURCE, reason: 'no_phase' };
  } else {
    phase = {
      status: 'available',
      source: VALVE_SOURCE,
      value: {
        phases: valveItem.value.phases,
        phaseFamilies: valveItem.value.phaseFamilies,
        phaseExclusive: valveItem.value.phases.length === 1,
        agreement: getPhaseAgreement(valveItem.value.phases, timing),
      },
    };
  }

  return { heroId, position, itemId, itemPrior, timing, valveHero, valveItem, phase };
}

/**
 * §10 (ТЗ §19.1) — the CANONICAL Valve name <-> item id mapping.
 *
 * It lives here, next to the evidence model that consumes it, so there is
 * exactly one implementation. Valve itembuilds use internal names
 * (`item_bfury`) and the catalogue's `dname` holds the same string, so the join
 * is exact: no fuzzy matching, no normalisation, no fallback. An unmapped name
 * is reported, never guessed.
 */
export interface ValveItemMap {
  /** @returns the canonical id, or null when the name is unknown/ambiguous. */
  resolve: (valveName: string) => number | null;
  size: number;
}

export function buildValveItemMap(catalogue: Record<number, { id: number; dname: string }>): ValveItemMap {
  const byDname = new Map<string, number>();
  const ambiguous = new Set<string>();
  for (const entry of Object.values(catalogue)) {
    if (byDname.has(entry.dname)) ambiguous.add(entry.dname);
    byDname.set(entry.dname, entry.id);
  }
  return {
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
 * Map every Valve item name for one hero onto canonical ids.
 *
 * Recipes are kept OUT of the item namespace: a recipe is not a buildable item,
 * and the catalogue deliberately contains none.
 */
export function mapHeroItems(
  valveHero: { phases: Record<string, string[]> } | undefined,
  map: ValveItemMap,
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
