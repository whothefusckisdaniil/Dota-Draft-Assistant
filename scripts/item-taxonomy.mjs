/**
 * Deterministic item taxonomy research (ТЗ №15 Part A).
 *
 * PURE and OFFLINE. Reads no files, makes no requests, and — critically —
 * hardcodes no item ids. Every rule below is a function of metadata that ships
 * in public/data/items.json, plus one evidence flag derived from the shipped
 * item-stats.json.
 *
 * The two axes are kept SEPARATE on purpose (ТЗ №15 §9): "what kind of entity
 * is this" and "what does it do to an inventory slot" are different questions,
 * and the dataset only answers the first one properly. Anything the metadata
 * cannot support is reported as `unknown` instead of being guessed.
 *
 * NOT PRODUCTION CODE. Nothing in src/ imports this.
 */

/** What kind of entity an item is. Derived from metadata only. */
export const ITEM_CLASS = {
  /** Bought from the shop, unlimited stock, not a charge item. The default
   *  build node — but note this says nothing about slots (§ slotBehavior). */
  REGULAR: 'regular',
  /** Carries charges (`isStackable: true`). Whether those charges share an
   *  inventory slot is NOT known — see SLOT_BEHAVIOR. */
  STACKABLE: 'stackable',
  /** Bought for 0 gold (wards, River Vials). */
  ZERO_COST: 'zero-cost',
  /** `isPurchasable: false` — not shop-bought; obtained in game (neutral
   *  consumables). Still a real purchase event, so still a real prior. */
  NOT_SHOP_BOUGHT: 'not-shop-bought',
  /** `isRecipe: true` in the source metadata. Never a build node. */
  RECIPE: 'recipe',
};

/**
 * Whether the item holds charges. A property of the item ALONE, and strictly
 * separate from slot behaviour: a stackable item may occupy a slot, share one,
 * or occupy none, and `isStackable` does not say which.
 */
export const STACK_BEHAVIOR = {
  STACKABLE: 'stackable',
  NON_STACKABLE: 'non-stackable',
};

/**
 * How many times an item can be bought in a game. A PURCHASE constraint, not a
 * slot: `stockMax: 1` bounds how many events a hero can generate, and says
 * nothing about where the item lives.
 */
export const PURCHASE_CONSTRAINT = {
  /** `stockMax: 0` — no per-game purchase cap. */
  UNLIMITED: 'unlimited',
  /** `stockMax > 0` — capped at that many purchases per game. */
  LIMITED: 'limited',
};

/**
 * What an item does to the 6-slot inventory.
 *
 * There is exactly ONE member, and that is the point. The persisted metadata
 * carries no field describing slot occupancy, charge consumption, or whether a
 * slot is freed on use. Inferring "permanent" from "not stackable and
 * unlimited" would convert MISSING metadata into ASSERTED gameplay behaviour —
 * the exact failure this taxonomy exists to prevent. Until an authoritative
 * source says otherwise, the honest answer is `unknown` for every item.
 */
export const SLOT_BEHAVIOR = {
  UNKNOWN: 'unknown',
};

/** Whether the item could ever be a node in a proposed build. */
export const BUILD_CANDIDATE = {
  /** Observed as a real purchase event somewhere in the dataset. */
  YES: 'yes',
  /** Never purchased: a recipe ingredient, a removed item, or dead content. */
  NO: 'no',
  /** No statistics available to judge with. */
  UNKNOWN: 'unknown',
};

function requireField(entry, field) {
  const v = entry?.[field];
  if (v === undefined || v === null) {
    throw new Error(`classifyItem: item ${entry?.id ?? '?'} is missing metadata field "${field}"`);
  }
  return v;
}

/**
 * Classify one catalogue entry.
 *
 * @param {object} entry an items.json record
 * @param {{ observedPurchases?: boolean }} evidence
 *        `observedPurchases` — does this item appear anywhere in item-stats.json?
 *        Supplied by the caller from the shipped dataset, never assumed.
 */
export function classifyItem(entry, { observedPurchases } = {}) {
  const cost = requireField(entry, 'cost');
  const isPurchasable = requireField(entry, 'isPurchasable') === true;
  const isStackable = requireField(entry, 'isStackable') === true;
  const stockMax = requireField(entry, 'stockMax') ?? 0;

  let itemClass;
  if (!isPurchasable) itemClass = ITEM_CLASS.NOT_SHOP_BOUGHT;
  else if (isStackable) itemClass = ITEM_CLASS.STACKABLE;
  else if (cost === 0) itemClass = ITEM_CLASS.ZERO_COST;
  else itemClass = ITEM_CLASS.REGULAR;

  // NOTE: `isRecipe` is deliberately NOT consulted — the generator already drops
  // recipes before writing items.json, so the field is absent by design. The
  // ITEM_CLASS.RECIPE member exists for a future schema that persists it.

  // Stack and purchase constraints are real, sourced facts.
  const stackBehavior = isStackable ? STACK_BEHAVIOR.STACKABLE : STACK_BEHAVIOR.NON_STACKABLE;
  const purchaseConstraint = stockMax > 0 ? PURCHASE_CONSTRAINT.LIMITED : PURCHASE_CONSTRAINT.UNLIMITED;

  // Slot behaviour is NOT derived from any of the above. The metadata has no
  // field that speaks to inventory slots, so every item stays `unknown` until
  // an authoritative source provides one.
  const slotBehavior = SLOT_BEHAVIOR.UNKNOWN;

  let buildCandidate;
  if (observedPurchases === true) buildCandidate = BUILD_CANDIDATE.YES;
  else if (observedPurchases === false) buildCandidate = BUILD_CANDIDATE.NO;
  else buildCandidate = BUILD_CANDIDATE.UNKNOWN;

  return {
    itemId: entry.id,
    name: entry.name,
    dname: entry.dname,
    cost,
    itemClass,
    stackBehavior,
    purchaseConstraint,
    slotBehavior,
    buildCandidate,
    /** Raw per-game purchase cap. 0 means unlimited — not a slot constraint. */
    stockMax,
    /**
     * Everything the persisted metadata CANNOT tell a future slot model.
     * Kept as data so a build engine reads the gap instead of assuming it away.
     */
    unresolved: [
      'how many inventory slots the item occupies',
      'whether the item frees its slot when consumed or used',
      'how many charges it starts with and how many it consumes',
      'whether charges share a slot with each other',
      'whether it is a permanent upgrade once consumed',
      'which item consumes it, if any',
    ],
  };
}

/** Classify the whole catalogue. */
export function classifyCatalogue(items, observedIds) {
  const observed = observedIds instanceof Set ? observedIds : new Set(observedIds ?? []);
  const out = [];
  for (const entry of Object.values(items)) {
    out.push(classifyItem(entry, { observedPurchases: observed.has(entry.id) }));
  }
  return out;
}

/** Every item id that appears in at least one item-stats cell. */
export function collectObservedItemIds(itemStats) {
  const ids = new Set();
  for (const byPosition of Object.values(itemStats ?? {})) {
    for (const byItem of Object.values(byPosition ?? {})) {
      for (const id of Object.keys(byItem)) ids.add(Number(id));
    }
  }
  return ids;
}
