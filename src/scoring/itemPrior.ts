import type { Dataset } from '../data/dataset';
import {
  eventShare,
  histogramStats,
  positionLift,
  purchaseEventsPerGame,
  purchaseWinRate,
  scoreEventShare,
  scoreLift,
  scoreRawIntensity,
  smoothedIntensity,
} from './itemStats';

/**
 * One item's prior for one hero on one lane (ТЗ №14).
 *
 * This is a STATISTICAL PRIOR, not a recommendation. It deliberately has no
 * `isCore` / `isSituational` / `isCounter` flag: classification is a later
 * stage, and adding a boolean here would freeze a guess into a contract.
 */
export interface ItemPrior {
  itemId: number;
  /** Canonical metadata from items.json. */
  itemName: string;
  itemDname: string;
  itemImage: string;
  itemCost: number;

  /** Raw counts, preserved so nothing downstream has to re-derive them. */
  purchases: number;
  heroGames: number;
  wins: number;

  /**
   * purchases / heroGames. Purchase EVENTS, so >1 is normal and expected.
   * NOT a "percent of games that bought this".
   */
  purchaseEventsPerGame: number;
  /** purchases / total purchase events of this hero on this lane. */
  eventShare: number;

  /** Population intensity of this item on this lane, across ALL heroes. */
  baselineIntensity: number;
  smoothedIntensity: number;
  /** smoothedIntensity / baselineIntensity. 1 = buys it like the average hero. */
  lift: number;

  /** 0.6·log1p(ev/game) + 0.2·log1p(eventShare) + 0.2·log2(lift) */
  score: number;

  /** wins / purchases. A diagnostic, NOT a causal effect (§15 of ТЗ №13). */
  purchaseWinRate: number;

  /** All approximate — the source histogram is bucketed by minute. */
  medianPurchaseMinute: number | null;
  p25PurchaseMinute: number | null;
  p75PurchaseMinute: number | null;

  /** Exploratory 0-10 / 10-20 / 20-30 / 30+ shares of the timing histogram. */
  earlyPurchaseShare: number;
  midPurchaseShare: number;
  latePurchaseShare: number;
  veryLatePurchaseShare: number;

  /** Raw histogram, kept for future build-order work. */
  byMinute: Record<number, number>;
  /** purchase-events copy index -> count. NOT a per-game count. */
  instances: Record<number, number>;
}

/** §4 — fixed by ТЗ №14. Do not tune without a re-run of the research. */
export const ITEM_PRIOR_PARAMS = {
  /** PSEUDO-games of shrinkage pull toward the lane baseline. */
  alpha: 100,
  /** Keeps lift finite for an item nobody buys on that lane. */
  liftSmoothing: 0.01,
  wIntensity: 0.6,
  wEventShare: 0.2,
  wLift: 0.2,
} as const;

/** Lane-level population aggregate: how strongly each item is bought on a
 *  lane by ALL heroes, and how many hero-games that lane covers in total. */
interface LaneAggregate {
  eventsByItem: Map<number, number>;
  totalHeroGames: number;
}

/**
 * Population aggregates, computed once per Dataset instance.
 *
 * Without this, every `getItemPrior` call would walk all 127 heroes x 5 lanes x
 * ~25 items to rebuild the same baselines — the O(H*P*I) blow-up §21 warns
 * about. `WeakMap` keyed on the Dataset so a reloaded dataset never serves
 * stale aggregates and nothing is retained once the dataset is dropped.
 */
const baselineCache = new WeakMap<ItemPriorDataset, Map<string, LaneAggregate>>();

function buildBaselines(dataset: ItemPriorDataset): Map<string, LaneAggregate> {
  const byPosition = new Map<string, LaneAggregate>();
  for (const heroPositions of Object.values(dataset.itemStats)) {
    for (const [pos, byItem] of Object.entries(heroPositions)) {
      let agg = byPosition.get(pos);
      if (!agg) {
        agg = { eventsByItem: new Map<number, number>(), totalHeroGames: 0 };
        byPosition.set(pos, agg);
      }
      // heroGames is a per-(hero, position) constant repeated on every cell, so
      // it must be counted ONCE per hero-position, not once per item.
      const firstCell = Object.values(byItem)[0];
      if (firstCell && Number.isFinite(firstCell.heroGames) && firstCell.heroGames > 0) {
        agg.totalHeroGames += firstCell.heroGames;
      }
      for (const [itemId, cell] of Object.entries(byItem)) {
        const id = Number(itemId);
        const events = Number.isFinite(cell.purchases) ? cell.purchases : 0;
        agg.eventsByItem.set(id, (agg.eventsByItem.get(id) ?? 0) + events);
      }
    }
  }
  return byPosition;
}

function baselinesFor(dataset: ItemPriorDataset): Map<string, LaneAggregate> {
  let cached = baselineCache.get(dataset);
  if (!cached) {
    cached = buildBaselines(dataset);
    baselineCache.set(dataset, cached);
  }
  return cached;
}

/** Population intensity of one item on one lane, across every hero. */
function baselineIntensity(agg: LaneAggregate | undefined, itemId: number): number {
  if (!agg || agg.totalHeroGames <= 0) return 0;
  return (agg.eventsByItem.get(itemId) ?? 0) / agg.totalHeroGames;
}

/**
 * Ordered item priors for one hero on one lane (ТЗ №14).
 *
 * Pure: same inputs always produce the same array, and nothing outside the
 * passed dataset is read. No enemy draft, no build order, no top-N cut — the
 * consumer decides how many it wants.
 *
 * Returns `[]` for an unknown hero or an unpopulated lane (§8). It never falls
 * back to another lane and never invents data from OpenDota role tags: a
 * missing position means "we do not know", and a future consumer must be able
 * to tell that apart from "this hero buys nothing here".
 */
/**
 * The read-only slice `getItemPrior` needs (ТЗ §19.1 §4).
 *
 * Declared here so callers holding a narrower object — a research fixture, a
 * subset snapshot — can call it without a cast. `Dataset` satisfies it
 * structurally, so existing callers are unaffected.
 */
export type ItemPriorDataset = Pick<Dataset, 'items' | 'itemStats'>;

export function getItemPrior(dataset: ItemPriorDataset, heroId: number, position: string): ItemPrior[] {
  const byItem = dataset.itemStats[heroId]?.[position];
  if (!byItem) return [];

  const items = Object.entries(byItem);
  if (items.length === 0) return [];

  const agg = baselinesFor(dataset).get(position);
  const heroPositionTotalPurchases = items.reduce(
    (sum, [, cell]) => sum + (Number.isFinite(cell.purchases) ? cell.purchases : 0),
    0,
  );

  const priors: ItemPrior[] = [];

  for (const [rawItemId, cell] of items) {
    const itemId = Number(rawItemId);

    // §9: a stats row without catalogue metadata is a broken contract, not
    // something to silently drop. The dataset validator gates this upstream.
    const entry = dataset.items[itemId];
    if (!entry) {
      throw new Error(
        `ItemPrior: item ${itemId} has statistics for hero ${heroId} position ${position} but no entry in items.json`,
      );
    }

    const heroGames = cell.heroGames;
    // §7: no games means no evidence. Skipping is the honest answer; falling
    // back to a neighbouring lane would fabricate a profile that never existed.
    if (!Number.isFinite(heroGames) || heroGames <= 0) continue;

    const purchases = Number.isFinite(cell.purchases) ? cell.purchases : 0;
    const base = baselineIntensity(agg, itemId);
    const smoothed = smoothedIntensity(purchases, heroGames, base, ITEM_PRIOR_PARAMS.alpha);
    const lift = positionLift(smoothed, base, ITEM_PRIOR_PARAMS.liftSmoothing);
    const eventsPerGame = purchaseEventsPerGame(purchases, heroGames);
    const share = eventShare(purchases, heroPositionTotalPurchases);
    const timing = histogramStats(cell.byMinute);

    const score =
      ITEM_PRIOR_PARAMS.wIntensity * scoreRawIntensity(eventsPerGame) +
      ITEM_PRIOR_PARAMS.wEventShare * scoreEventShare(share) +
      ITEM_PRIOR_PARAMS.wLift * scoreLift(lift);

    priors.push({
      itemId,
      itemName: entry.name,
      itemDname: entry.dname,
      itemImage: entry.image,
      itemCost: entry.cost,

      purchases,
      heroGames,
      // Sanitised, not passed through: `purchaseWinRate` tolerates a bad `wins`
      // but the raw field is part of the public contract, and §7 requires every
      // emitted number to be finite.
      wins: Number.isFinite(cell.wins) ? cell.wins : 0,

      purchaseEventsPerGame: eventsPerGame,
      eventShare: share,

      baselineIntensity: base,
      smoothedIntensity: smoothed,
      lift,

      score,

      purchaseWinRate: purchaseWinRate(cell.wins, purchases),

      medianPurchaseMinute: timing.medianMinute,
      p25PurchaseMinute: timing.p25Minute,
      p75PurchaseMinute: timing.p75Minute,

      earlyPurchaseShare: timing.earlyShare,
      midPurchaseShare: timing.midShare,
      latePurchaseShare: timing.lateShare,
      veryLatePurchaseShare: timing.veryLateShare,

      byMinute: cell.byMinute,
      instances: cell.instances,
    });
  }

  // §14: deterministic. score desc, then the stronger evidence, then a stable
  // id tiebreak so two runs can never differ by map iteration order.
  priors.sort((a, b) =>
    b.score - a.score || b.purchases - a.purchases || a.itemId - b.itemId,
  );
  return priors;
}

