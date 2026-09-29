/**
 * Item-state source research (ТЗ №17). PURE, OFFLINE parsing of Valve game
 * data.
 *
 * The itembuild files are fetched straight from
 * `raw.githubusercontent.com/SteamDatabase/GameTracking-Dota2/master/game/dota/itembuilds/`
 * into /tmp for analysis; no fetch script is committed, because that data is
 * consumed ad hoc while researching and the fetches are documented in
 * docs/item-state-source-research.md rather than run in CI.
 *
 * NOT PRODUCTION. Nothing in src/ imports this.
 *
 * The central finding this module encodes: the game files prove that the engine
 * HAS fields for permanence, consumption, upgrade goals and neutral drops — but
 * the per-item VALUES for those fields are not available in any public mirror,
 * so every per-item state property stays `unknown` rather than being guessed.
 */

/** Build phases Valve authors in scripts/npc itembuilds. */
export const BUILD_PHASES = [
  'Starting_Items', 'Starting_Items_Secondary', 'Early_Game', 'Early_Game_Secondary',
  'Core_Items', 'Core_Items_Secondary', 'Mid_Items', 'Late_Items', 'Other_Items', 'Luxury',
];

/** Item-state axes. Every value is evidence-gated; `unknown` is the default. */
export const ITEM_STATE = {
  UNKNOWN: 'unknown',
  /** A purchased item whose effect does not end. */
  PERMANENT: 'permanent',
  /** A purchased item that can be consumed for an effect. */
  CONSUMABLE: 'consumable',
  /** A purchased item that upgrades into something else. */
  UPGRADABLE: 'upgradeable',
};

/** Authoritative engine field names, from the shipped `CDOTA_Item` class. */
export const ENGINE_FIELDS = {
  permanence: 'm_bPermanent',
  consumable: 'm_bCanBeConsumed',
  upgradeable: 'm_bIsUpgradeable',
  upgradeGoal: 'm_nUpgradeGoal',
  castOnPickup: 'm_bCastOnPickup',
  initialCharges: 'm_iInitialCharges',
  requiresCharges: 'm_bRequiresCharges',
  purchasable: 'm_bPurchasable',
  sellable: 'm_bSellable',
  droppable: 'm_bDroppable',
  recipe: 'm_bRecipe',
  neutralActiveDrop: 'm_bIsNeutralActiveDrop',
  neutralPassiveDrop: 'm_bIsNeutralPassiveDrop',
  canBeUsedOutOfInventory: 'm_bCanBeUsedOutOfInventory',
  // NOTE: there is deliberately no "m_iInventorySlots" — the engine class does
  // not expose an inventory-slot count, which is why slot semantics stay unknown.
};

/**
 * Parse one itembuilds KV file into `{ hero, phases: { phase: [items] } }`.
 * Returns null for a file with no `"itembuilds"` root.
 */
export function parseItemBuild(text) {
  if (typeof text !== 'string' || !text.includes('"itembuilds"')) return null;
  const hero = (text.match(/"hero"\s*"([a-z0-9_]+)"/) ?? [])[1] ?? null;
  const phases = {};
  const blocks = text.split(/"(#[A-Za-z_]+)"/);
  for (let i = 1; i < blocks.length - 1; i += 2) {
    const phase = blocks[i].replace('#DOTA_Item_Build_', '');
    const items = [...blocks[i + 1].matchAll(/"item"\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
    if (items.length) phases[phase] = items;
  }
  return { hero, phases };
}

/** Merge many parsed builds into `item -> Set(phase)`. */
export function aggregatePhases(builds) {
  const map = new Map();
  for (const b of builds) {
    if (!b) continue;
    for (const [phase, items] of Object.entries(b.phases)) {
      for (const it of items) {
        if (!map.has(it)) map.set(it, new Set());
        map.get(it).add(phase);
      }
    }
  }
  return map;
}

/**
 * What the build data can and cannot say about an item.
 *
 * Phase is a BUILD-PHASE hint authored by Valve, not a slot classification:
 * the Shard shares its phase set with ordinary late equipment, so phase cannot
 * distinguish slot semantics.
 */
export function phaseProfile(itemId, phaseMap) {
  const phases = phaseMap.get(itemId);
  if (!phases || phases.size === 0) {
    return { itemId, referenced: false, phases: [], phaseExclusive: false };
  }
  const list = [...phases].sort();
  return { itemId, referenced: true, phases: list, phaseExclusive: list.length === 1 };
}

/**
 * Per-item STATE properties. The engine class proves these fields exist; no
 * public mirror publishes their values, so every one of them is `unknown`.
 *
 * `slotBehavior` is permanently `unknown` in this source: the engine class has
 * no slot-count field, and no build file distinguishes a shard from a wand.
 */
export function itemStateFrom(_itemId) {
  return {
    slotBehavior: 'unknown',
    consumptionBehavior: 'unknown',
    permanence: 'unknown',
    upgradeTarget: null,
    charges: null,
    neutralDrop: 'unknown',
    purchasable: 'unknown',
    recipe: 'unknown',
    // Per ТЗ §9: absent metadata is `unknown`, never `false`.
    _evidence: 'field names proven from CDOTA_Item; values unavailable',
  };
}

/** Cross-source reconciliation for one item. */
export function reconcile(itemId, phaseMap, stratz) {
  const phase = phaseProfile(itemId, phaseMap);
  return {
    itemId,
    buildPhases: phase.phases,
    buildPhaseExclusive: phase.phaseExclusive,
    stratzQuality: stratz?.quality ?? null,
    stratzIsRecipe: stratz?.isRecipe ?? null,
    stratzInitialCharges: stratz?.initialCharges ?? null,
    stratzItemResult: stratz?.itemResult ?? null,
    slotBehavior: 'unknown',
    consumptionBehavior: 'unknown',
    conflict: false,
  };
}
