/**
 * Item metadata normalisation for the slot/consume model (ТЗ №16).
 *
 * PURE, OFFLINE, research-only. Nothing in src/ imports this.
 *
 * The central rule (§9) is that ABSENT metadata becomes `null`, and a `null`
 * becomes `unknown` — never `false`. "The source does not say this item frees a
 * slot" and "this item does not free a slot" are different claims, and only one
 * of them is supported by the data.
 *
 * Every shape below was read from a real `constants.items` response captured by
 * scripts/item-metadata-research.mjs. Nothing here is invented.
 */

/** Charge declaration status. */
export const CHARGE_STATE = {
  /** `initialCharges > 0` — the source states a charge count. */
  DECLARED: 'declared',
  /** `initialCharges === 0` — the source states there are no charges. */
  NO: 'no-charge',
  /** The field was absent — we do not know. */
  UNKNOWN: 'unknown',
};

/** How strong the evidence for a slot-semantics claim is. */
export const SLOT_EVIDENCE = {
  /** Nothing in the metadata speaks to slots. */
  NONE: 'none',
  /** `quality === 'consumable'` — a strong hint, still not a slot rule. */
  QUALITY_CONSUMABLE: 'quality-consumable',
  /** `quality === 'component'` — an ingredient, not a purchased build node. */
  QUALITY_COMPONENT: 'quality-component',
  /** Ordinary equipment quality (rare/epic/common/artifact). */
  QUALITY_RARE: 'quality-equipment',
};

/**
 * What the metadata lets us say about inventory slots.
 *
 * `UNKNOWN` is the only value the current source supports for slot occupancy.
 * `CONSUMED` exists as a name for the future, but nothing in the shipped
 * metadata proves it for any item, so nothing emits it today.
 */
export const SLOT_SEMANTICS = {
  UNKNOWN: 'unknown',
  /** Reserved: requires a source field that does not exist yet. */
  CONSUMED: 'consumed',
};

/** Whether a consumption/transformation link was found. */
export const CONSUMPTION_EVIDENCE = {
  /** No link in the source. Not the same as "no consumption happens". */
  ABSENT: 'absent',
};

/**
 * @typedef {Object} NormalizedItemMetadata
 * @property {number} id
 * @property {string} name
 * @property {string|null} displayName
 * @property {string|null} shortName
 * @property {number|null} cost        null when the source omitted it
 * @property {boolean|null} isRecipe
 * @property {boolean|null} needsComponents
 * @property {string|null} quality
 * @property {string[]|null} shopTags
 * @property {boolean|null} isPurchasable
 * @property {'stackable'|'non-stackable'|'unknown'} stackBehavior  separate from slots
 * @property {boolean|null} isPermanent
 * @property {boolean|null} isRequiresCharges
 * @property {{initial:number,state:string}|null} charges
 * @property {number|null} itemResult      product of this recipe, if stated
 * @property {number[]|null} componentIds  parts of this recipe, if stated
 * @property {{productId:number,componentIds:number[]}|null} recipe
 * @property {null} consumption   always null: no consumedBy/departsFrom exists
 * @property {string} slotSemantics
 * @property {string} slotEvidence
 */

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function bool(v) {
  return typeof v === 'boolean' ? v : null;
}
function chargeState(stat) {
  if (!stat || !('initialCharges' in stat)) return CHARGE_STATE.UNKNOWN;
  const n = num(stat.initialCharges);
  if (n === null) return CHARGE_STATE.UNKNOWN;
  return n > 0 ? CHARGE_STATE.DECLARED : CHARGE_STATE.NO;
}

export function normalizeItemMetadata(raw) {
  const stat = raw?.stat ?? null;
  const quality = typeof stat?.quality === 'string' ? stat.quality : null;
  const isRecipe = bool(stat?.isRecipe);
  const components = Array.isArray(raw?.components) ? raw.components : [];
  const itemResult = num(stat?.itemResult);

  // A recipe edge needs all three: the flag, the product and the parts.
  const recipe = isRecipe === true && itemResult !== null && components.length
    ? { productId: itemResult, componentIds: components.map((c) => c.componentId).sort((a, b) => a - b) }
    : null;

  let slotEvidence = SLOT_EVIDENCE.NONE;
  if (quality === 'consumable') slotEvidence = SLOT_EVIDENCE.QUALITY_CONSUMABLE;
  else if (quality === 'component') slotEvidence = SLOT_EVIDENCE.QUALITY_COMPONENT;
  else if (quality) slotEvidence = SLOT_EVIDENCE.QUALITY_RARE;

  return {
    id: num(raw?.id) ?? 0,
    name: raw?.displayName ?? raw?.name ?? '',
    displayName: raw?.displayName ?? null,
    shortName: raw?.shortName ?? null,
    cost: num(stat?.cost),
    isRecipe,
    needsComponents: bool(stat?.needsComponents),
    quality,
    shopTags: typeof stat?.shopTags === 'string' ? stat.shopTags.split(';').filter(Boolean) : null,
    isPurchasable: bool(stat?.isPurchasable),
    stackBehavior: stat && 'isStackable' in stat
      ? (stat.isStackable === true ? 'stackable' : 'non-stackable')
      : 'unknown',
    isPermanent: bool(stat?.isPermanent),
    isRequiresCharges: bool(stat?.isRequiresCharges),
    charges: stat && 'initialCharges' in stat
      ? { initial: num(stat.initialCharges) ?? 0, state: chargeState(stat) }
      : null,
    // itemResult and the parts are exposed individually as well as combined,
    // because "this recipe produces X" and "this recipe needs A+B" are
    // separately useful and a build engine may have only one of them.
    itemResult,
    componentIds: components.length ? components.map((c) => c.componentId).sort((a, b) => a - b) : null,
    recipe,
    consumption: null,
    // Slot occupancy is NOT in the source. quality is evidence about what an
    // item IS, not about inventory slots — so it informs `slotEvidence`
    // without ever upgrading `slotSemantics` past UNKNOWN.
    slotSemantics: SLOT_SEMANTICS.UNKNOWN,
    slotEvidence,
  };
}

/** productId -> { recipeId, componentIds }. */
export function buildRecipeGraph(rawItems) {
  const graph = new Map();
  for (const raw of rawItems) {
    const m = raw?.recipe ? raw : normalizeItemMetadata(raw);
    if (m?.recipe) graph.set(m.recipe.productId, { recipeId: m.id, componentIds: m.recipe.componentIds });
  }
  return graph;
}

/** The evidence attached to a normalized item, for reporting. */
export function slotSemanticsFor(normalized) {
  return { semantics: normalized.slotSemantics, evidence: normalized.slotEvidence };
}
