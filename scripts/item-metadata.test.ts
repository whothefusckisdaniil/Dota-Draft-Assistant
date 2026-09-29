/**
 * Item metadata contract tests (ТЗ №16 §16).
 *
 * The values are COPIED from real STRATZ `constants.items` responses captured by
 * scripts/item-metadata-research.mjs — not invented. Two matter most because
 * they encode findings rather than conventions:
 *   - a recipe carries BOTH components and itemResult, so the recipe graph is
 *     recoverable (Magic Wand: Magic Stick + Iron Branch + Iron Branch);
 *   - Aghanim's Scepter and Aghanim's Blessing differ in exactly ONE stat
 *     field (cost), so the consumption link is NOT in the metadata.
 */
import { describe, expect, it } from 'vitest';
import {
  CHARGE_STATE,
  SLOT_EVIDENCE,
  SLOT_SEMANTICS,
  buildRecipeGraph,
  normalizeItemMetadata,
  slotSemanticsFor,
} from './item-metadata.mjs';

/** Real STRATZ response shape for one item. */
function raw(over = {}, stat = {}) {
  return {
    id: 36,
    name: 'item_magic_wand',
    displayName: 'Magic Wand',
    shortName: 'magic_wand',
    isSupportFullItem: false,
    components: null,
    stat: {
      isRecipe: false, needsComponents: true, upgradeItem: null, upgradeRecipe: null,
      itemResult: null, behavior: 1374394788, cost: 460, quality: 'consumable',
      shopTags: 'int;agi;str;charges;regen_mana', isSellable: true, isDroppable: true,
      isPurchasable: true, isSideShop: true, isStackable: true, isPermanent: false,
      isHideCharges: false, isRequiresCharges: true, isDisplayCharges: true,
      isSupport: true, stockMax: 0, initialCharges: 16, initialStock: 0, stockTime: 0,
      neutralItemDropTime: null, neutralItemTier: null, ...stat,
    },
    ...over,
  };
}

describe('normalizeItemMetadata — real field normalization (§16 A)', () => {
  it('keeps every field the research proved exists', () => {
    const m = normalizeItemMetadata(raw());
    expect(m.id).toBe(36);
    expect(m.displayName).toBe('Magic Wand');
    expect(m.cost).toBe(460);
    expect(m.isRecipe).toBe(false);
    expect(m.itemResult).toBeNull();
    expect(m.charges).toEqual({ initial: 16, state: CHARGE_STATE.DECLARED });
  });

  it('does not invent a consumption link the source does not state (§9)', () => {
    const m = normalizeItemMetadata(raw());
    expect(m.consumption).toBeNull();
    expect(m.slotSemantics).toBe(SLOT_SEMANTICS.UNKNOWN);
  });

  it('marks a zero-charge item as no-charge, not as unknown', () => {
    const m = normalizeItemMetadata(raw({ id: 145, name: 'item_bfury' },
      { initialCharges: 0, isStackable: false, isRequiresCharges: false }));
    expect(m.charges).toEqual({ initial: 0, state: CHARGE_STATE.NO });
  });
});

describe('missing optional metadata stays unknown, never false (§16 B, §9)', () => {
  it('treats an absent `stat` block as no metadata at all', () => {
    const m = normalizeItemMetadata({ id: 1, name: 'item_x', displayName: 'X' });
    expect(m.cost).toBeNull();
    expect(m.isRecipe).toBeNull();
    expect(m.charges).toBeNull();
    expect(m.consumption).toBeNull();
    expect(m.slotSemantics).toBe(SLOT_SEMANTICS.UNKNOWN);
  });

  it('does not coerce a null quality into "not a consumable"', () => {
    const m = normalizeItemMetadata(raw({ id: 2 }, { quality: null }));
    expect(m.quality).toBeNull();
    expect(m.slotSemantics).not.toBe(SLOT_SEMANTICS.CONSUMED);
  });

  it('keeps isRecipe null when the source omits it', () => {
    const m = normalizeItemMetadata({ ...raw(), stat: { cost: 100 } });
    expect(m.isRecipe).toBeNull();
  });
});

describe('stackable and stockMax say nothing about slots (§16 C, D)', () => {
  it('isStackable does not change slot semantics', () => {
    const a = normalizeItemMetadata(raw({ id: 1 }, { isStackable: true, isRequiresCharges: false, initialCharges: 0 }));
    const b = normalizeItemMetadata(raw({ id: 2 }, { isStackable: false, isRequiresCharges: false, initialCharges: 0 }));
    expect(a.slotSemantics).toBe(b.slotSemantics);
  });

  it('stockMax does not change slot semantics', () => {
    const a = normalizeItemMetadata(raw({ id: 1 }, { stockMax: 0, isRequiresCharges: false, initialCharges: 0 }));
    const b = normalizeItemMetadata(raw({ id: 2 }, { stockMax: 8, isRequiresCharges: false, initialCharges: 0 }));
    expect(a.slotSemantics).toBe(b.slotSemantics);
  });

  it('records stackability as a SEPARATE axis', () => {
    const m = normalizeItemMetadata(raw({}, { isStackable: true, isRequiresCharges: false, initialCharges: 0 }));
    expect(m.stackBehavior).toBe('stackable');
    expect(m.slotSemantics).toBe(SLOT_SEMANTICS.UNKNOWN);
  });
});

describe('recipe semantics (§16 E)', () => {
  const recipeRaw = {
    id: 35, name: 'item_recipe_magic_wand', displayName: 'Magic Wand Recipe', shortName: '',
    components: [{ index: 1, componentId: 34 }, { index: 2, componentId: 16 }, { index: 3, componentId: 16 }],
    stat: { isRecipe: true, needsComponents: true, itemResult: 36, cost: 0, quality: null },
  };

  it('marks a real recipe: isRecipe + itemResult + components', () => {
    const m = normalizeItemMetadata(recipeRaw);
    expect(m.isRecipe).toBe(true);
    expect(m.recipe).toEqual({ productId: 36, componentIds: [16, 16, 34] });
  });

  it('leaves recipe null for a normal product item', () => {
    expect(normalizeItemMetadata(raw()).recipe).toBeNull();
  });

  it('leaves recipe null when the flag is set but nothing links it', () => {
    const m = normalizeItemMetadata({ ...recipeRaw, stat: { isRecipe: true, itemResult: null }, components: null });
    expect(m.recipe).toBeNull();
  });
});

describe('consumption relation (§16 F)', () => {
  it('stays null for Scepter and Blessing — real responses differ only in cost', () => {
    const common = { isStackable: false, isRequiresCharges: false, initialCharges: 0, isPermanent: false, quality: 'rare' };
    const scepter = normalizeItemMetadata(raw({ id: 108, name: 'item_ultimate_scepter', displayName: "Aghanim's Scepter" }, { ...common, cost: 4200 }));
    const blessing = normalizeItemMetadata(raw({ id: 271, name: 'item_ultimate_scepter_2', displayName: "Aghanim's Blessing" }, { ...common, cost: 5800 }));
    expect(scepter.consumption).toBeNull();
    expect(blessing.consumption).toBeNull();
    expect(slotSemanticsFor(scepter).evidence).toBe(SLOT_EVIDENCE.QUALITY_RARE);
    expect(slotSemanticsFor(scepter).semantics).toBe(SLOT_SEMANTICS.UNKNOWN);
  });
});

describe('charge relation (§16 G)', () => {
  it('records declared charges from initialCharges', () => {
    const m = normalizeItemMetadata(raw({}, { initialCharges: 3, isRequiresCharges: false }));
    expect(m.charges).toEqual({ initial: 3, state: CHARGE_STATE.DECLARED });
  });

  it('does not treat isPermanent as a charge declaration', () => {
    const m = normalizeItemMetadata(raw({}, { initialCharges: 0, isRequiresCharges: false, isPermanent: true }));
    expect(m.charges).toEqual({ initial: 0, state: CHARGE_STATE.NO });
  });

  it('isRequiresCharges is reported but never upgrades slot semantics', () => {
    const m = normalizeItemMetadata(raw({}, { isRequiresCharges: true, initialCharges: 0 }));
    expect(m.isRequiresCharges).toBe(true);
    expect(m.slotSemantics).toBe(SLOT_SEMANTICS.UNKNOWN);
  });
});

describe('recipe graph (§16 H)', () => {
  const recipeRaw = {
    id: 35, name: 'item_recipe_magic_wand', displayName: 'Magic Wand Recipe', shortName: '',
    components: [{ index: 1, componentId: 34 }, { index: 2, componentId: 16 }],
    stat: { isRecipe: true, itemResult: 36, cost: 0 },
  };

  it('links a product to its recipe and parts', () => {
    const g = buildRecipeGraph([recipeRaw, normalizeItemMetadata(raw())]);
    expect(g.get(36)).toEqual({ recipeId: 35, componentIds: [16, 34] });
  });

  it('returns an empty map when the source has no recipes', () => {
    expect(buildRecipeGraph([normalizeItemMetadata(raw())]).size).toBe(0);
  });
});

describe('no hero- or item-specific rules (§16 I, J)', () => {
  it('classifies two identically-shaped items identically', () => {
    const a = normalizeItemMetadata(raw({ id: 1, name: 'item_aaa', displayName: 'Alpha' }));
    const b = normalizeItemMetadata(raw({ id: 2, name: 'item_bbb', displayName: 'Beta' }));
    const strip = (m) => ({ ...m, id: 0, name: '', displayName: null });
    expect(strip(a)).toEqual(strip(b));
  });

  it('never branches on the item name', () => {
    // A hardcoded "Aghanim's Scepter" rule would make these differ.
    const fake = normalizeItemMetadata(raw({ id: 999, name: 'item_fake', displayName: "Aghanim's Scepter" }, { cost: 4200, quality: 'rare' }));
    const real = normalizeItemMetadata(raw({ id: 108, name: 'item_ultimate_scepter', displayName: "Aghanim's Scepter" }, { cost: 4200, quality: 'rare' }));
    expect(fake.slotSemantics).toBe(real.slotSemantics);
    expect(fake.recipe).toBe(real.recipe);
  });

  it('is insensitive to field order', () => {
    const a = normalizeItemMetadata(raw({ id: 1 }, { cost: 100, quality: 'epic' }));
    const b = normalizeItemMetadata(raw({ id: 1 }, { quality: 'epic', cost: 100 }));
    expect(a).toEqual(b);
  });
});

