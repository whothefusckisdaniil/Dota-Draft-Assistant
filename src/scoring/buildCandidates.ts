import { getItemPrior, type ItemPrior } from './itemPrior';
import {
  getBuildPhasePrior,
  type BuildPhasePrior,
  type ValveBuildData,
} from './buildPhasePrior';
import type { ItemCatalogue, ItemStatsDataset } from '../types';

/**
 * Build Candidate Engine — Level 1 (ТЗ §20).
 *
 * Turns two existing layers into a stable, ordered structure:
 *
 *     ItemPrior  +  BuildPhasePrior   ->   BuildCandidate[]
 *
 * ## What this layer adds: nothing
 *
 * No new mathematics. The candidate list IS the ItemPrior list, in ItemPrior
 * order; each entry simply carries its own evidence bundle. Specifically this
 * module does NOT (ТЗ §9):
 *
 *   - condition on the enemy draft,
 *   - combine evidence into a score of its own,
 *   - infer core / situational / counter status,
 *   - model inventory slots, consumption or build order,
 *   - rank on `purchaseWinRate` (a diagnostic, not a ranking signal).
 *
 * The one judgement it makes is a boundary, not a weight: candidates come from
 * STRATZ priors only. An item that Valve lists for a hero but that STRATZ never
 * observed on that lane is NOT promoted into the list — a build recommendation
 * must be backed by measured play.
 */

/** One item observed for one hero on one lane, with its evidence attached. */
export interface BuildCandidate {
  heroId: number;
  position: string;

  itemId: number;
  /**
   * Position in the ItemPrior ordering, starting at 1. This is a COPY of an
   * existing order, never a new judgement about quality.
   */
  rank: number;

  /** The exact object `getItemPrior()` returned — not recomputed, not rescored. */
  itemPrior: ItemPrior;
  /** The canonical evidence bundle, stored whole. */
  evidence: BuildPhasePrior;
}

export interface BuildCandidateInput {
  heroId: number;
  /** Lane as a string, matching the `itemStats` key shape. */
  position: string;

  heroes: { id: number; key: string }[];
  catalogue: ItemCatalogue;
  itemStats: ItemStatsDataset;
  valve: ValveBuildData;

  /**
   * Consumer-side cap. `undefined` means "everything"; there is deliberately NO
   * hidden default Top-N inside this module (ТЗ §7, §11).
   */
  limit?: number;
}

/**
 * Ordered build candidates for one hero on one lane.
 *
 * Pure and deterministic: same input, same array, same order. The order is
 * inherited from `getItemPrior()` (score desc, then purchases desc, then itemId
 * asc) — this function never re-sorts (ТЗ §5, §8).
 */
export function getBuildCandidates(input: BuildCandidateInput): BuildCandidate[] {
  const { heroId, position, limit } = input;

  // A negative cap is a caller bug, not something to silently reinterpret as 0.
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new RangeError(
      `getBuildCandidates: limit must be a non-negative integer, received ${String(limit)}`,
    );
  }

  const priors = getItemPrior(
    { items: input.catalogue, itemStats: input.itemStats },
    heroId,
    position,
  );
  if (priors.length === 0) return [];

  const lane = Number(position);
  const candidates = priors.map((prior, index) => ({
    heroId,
    position,
    itemId: prior.itemId,
    rank: index + 1,
    itemPrior: prior,
    evidence: getBuildPhasePrior({
      heroId,
      position: lane,
      itemId: prior.itemId,
      heroes: input.heroes,
      catalogue: input.catalogue,
      itemStats: input.itemStats,
      valve: input.valve,
    }),
  }));

  return limit === undefined ? candidates : candidates.slice(0, limit);
}
