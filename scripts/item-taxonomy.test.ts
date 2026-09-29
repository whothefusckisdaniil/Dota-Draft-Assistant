/**
 * Item taxonomy tests (ТЗ №15 §29).
 *
 * The point of these is that classification must follow from METADATA, never
 * from a list of known item ids. Each case below uses a synthetic entry, so a
 * future refactor that starts pattern-matching on `dname` would fail here
 * instead of silently working only for the items someone remembered to add.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILD_CANDIDATE,
  ITEM_CLASS,
  PURCHASE_CONSTRAINT,
  SLOT_BEHAVIOR,
  STACK_BEHAVIOR,
  classifyCatalogue,
  classifyItem,
  collectObservedItemIds,
} from './item-taxonomy.mjs';

/** A minimal but complete items.json record. */
function entry(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'Item',
    dname: 'item_x',
    shortName: 'x',
    cost: 1000,
    isPurchasable: true,
    isStackable: false,
    isSideShop: false,
    stockMax: 0,
    isSupportFullItem: false,
    image: '',
    components: [],
    ...over,
  };
}

describe('classifyItem — item class from metadata only (§1, §9)', () => {
  it('classifies an ordinary shop item as regular', () => {
    expect(classifyItem(entry()).itemClass).toBe(ITEM_CLASS.REGULAR);
  });

  it('classifies a charge item as stackable', () => {
    expect(classifyItem(entry({ isStackable: true, stockMax: 5 })).itemClass).toBe(ITEM_CLASS.STACKABLE);
  });

  it('classifies a 0-gold shop item separately from a charge item', () => {
    expect(classifyItem(entry({ cost: 0 })).itemClass).toBe(ITEM_CLASS.ZERO_COST);
  });

  it('classifies a non-shop-bought item (neutral consumable) on isPurchasable', () => {
    const r = classifyItem(entry({ isPurchasable: false, isStackable: true, cost: 0 }));
    expect(r.itemClass).toBe(ITEM_CLASS.NOT_SHOP_BOUGHT);
  });

  it('never consults the item name or dname (§10)', () => {
    // Same metadata, wildly different names -> same class. A name-based rule
    // would classify these differently and is therefore forbidden.
    const a = classifyItem(entry({ name: 'Battle Fury', dname: 'item_bfury' }));
    const b = classifyItem(entry({ name: 'Quartz Pouch', dname: 'item_pouch' }));
    expect(a.itemClass).toBe(b.itemClass);
    expect(a.slotBehavior).toBe(b.slotBehavior);
  });
});

describe('classifyItem — stack/purchase axes (§2, corrected by §15.1)', () => {
  it('gives a non-stackable, uncapped item plain stack + purchase behaviour', () => {
    const r = classifyItem(entry({ stockMax: 0 }));
    expect(r.stackBehavior).toBe(STACK_BEHAVIOR.NON_STACKABLE);
    expect(r.purchaseConstraint).toBe(PURCHASE_CONSTRAINT.UNLIMITED);
  });

  it('reports a charge item as stackable', () => {
    expect(classifyItem(entry({ isStackable: true })).stackBehavior).toBe(STACK_BEHAVIOR.STACKABLE);
  });

  it('carries the raw stockMax through for downstream reasoning', () => {
    expect(classifyItem(entry({ stockMax: 8 })).stockMax).toBe(8);
  });
});

describe('slotBehavior — absence of metadata is never a gameplay claim (§15.1)', () => {
  it('A. non-stackable + unlimited is STILL unknown, not "permanent"', () => {
    // Regression: this combination was previously reported as
    // `slotBehavior: "permanent"`, which asserted gameplay behaviour the
    // metadata never states.
    const r = classifyItem(entry({ isStackable: false, stockMax: 0 }));
    expect(r.slotBehavior).toBe(SLOT_BEHAVIOR.UNKNOWN);
  });

  it('B. isStackable describes STACK behavior, never slot behavior', () => {
    const r = classifyItem(entry({ isStackable: true, stockMax: 0 }));
    expect(r.stackBehavior).toBe(STACK_BEHAVIOR.STACKABLE);
    expect(r.slotBehavior).toBe(SLOT_BEHAVIOR.UNKNOWN);
  });

  it('C. stockMax is a purchase constraint, not a slot constraint', () => {
    const r = classifyItem(entry({ stockMax: 1 }));
    expect(r.purchaseConstraint).toBe(PURCHASE_CONSTRAINT.LIMITED);
    expect(r.slotBehavior).toBe(SLOT_BEHAVIOR.UNKNOWN);
  });

  it('D. stockMax 0 means unlimited purchases, still unknown slots', () => {
    const r = classifyItem(entry({ stockMax: 0 }));
    expect(r.purchaseConstraint).toBe(PURCHASE_CONSTRAINT.UNLIMITED);
    expect(r.slotBehavior).toBe(SLOT_BEHAVIOR.UNKNOWN);
  });

  it('F. no metadata combination ever yields a definite slot behaviour', () => {
    // Exhaustive over the four boolean/count combinations that used to drive
    // the old rules. Every one of them must stay `unknown`.
    for (const isStackable of [true, false]) {
      for (const stockMax of [0, 1, 8]) {
        for (const isPurchasable of [true, false]) {
          const r = classifyItem(entry({ isStackable, stockMax, isPurchasable }));
          expect(r.slotBehavior, `stackable=${isStackable} stockMax=${stockMax} purchasable=${isPurchasable}`)
            .toBe(SLOT_BEHAVIOR.UNKNOWN);
        }
      }
    }
  });

  it('the slot enum has exactly one member — there is no confident value', () => {
    // A future contributor adding `PERMANENT: 'permanent'` back must break
    // this test, which is the point.
    expect(Object.values(SLOT_BEHAVIOR)).toEqual(['unknown']);
  });

  it('unresolved names the slot questions the data cannot answer', () => {
    const r = classifyItem(entry());
    expect(r.unresolved).toContain('how many inventory slots the item occupies');
    expect(r.unresolved).toContain('whether charges share a slot with each other');
  });
});

describe('stackBehavior and purchaseConstraint are independent axes', () => {
  it('classifies a plain item on both axes at once', () => {
    const r = classifyItem(entry({ isStackable: false, stockMax: 0 }));
    expect(r.stackBehavior).toBe(STACK_BEHAVIOR.NON_STACKABLE);
    expect(r.purchaseConstraint).toBe(PURCHASE_CONSTRAINT.UNLIMITED);
    expect(r.itemClass).toBe(ITEM_CLASS.REGULAR);
  });

  it('allows stackable AND limited together (wards are both)', () => {
    const r = classifyItem(entry({ isStackable: true, stockMax: 5 }));
    expect(r.stackBehavior).toBe(STACK_BEHAVIOR.STACKABLE);
    expect(r.purchaseConstraint).toBe(PURCHASE_CONSTRAINT.LIMITED);
  });

  it('allows non-stackable AND limited (a shard-shaped cap)', () => {
    const r = classifyItem(entry({ isStackable: false, stockMax: 1 }));
    expect(r.stackBehavior).toBe(STACK_BEHAVIOR.NON_STACKABLE);
    expect(r.purchaseConstraint).toBe(PURCHASE_CONSTRAINT.LIMITED);
  });
});

describe('classifyItem — build candidacy from observed evidence', () => {
  it('is yes when the item appears in the statistics', () => {
    expect(classifyItem(entry(), { observedPurchases: true }).buildCandidate).toBe(BUILD_CANDIDATE.YES);
  });

  it('is no when it never appears — a recipe ingredient or dead item', () => {
    expect(classifyItem(entry({ cost: 2800 }), { observedPurchases: false }).buildCandidate).toBe(BUILD_CANDIDATE.NO);
  });

  it('is unknown, not yes, when no evidence was supplied', () => {
    // Fail-open here would invent build nodes out of nothing.
    expect(classifyItem(entry()).buildCandidate).toBe(BUILD_CANDIDATE.UNKNOWN);
  });
});

describe('classifyItem — missing metadata fails loudly (§29)', () => {
  it('throws when a required field is absent', () => {
    const broken = entry();
    delete (broken as Record<string, unknown>).isStackable;
    expect(() => classifyItem(broken)).toThrow(/missing metadata field "isStackable"/);
  });

  it('throws rather than defaulting a missing cost to 0', () => {
    const broken = entry({ cost: undefined });
    expect(() => classifyItem(broken)).toThrow(/missing metadata field "cost"/);
  });
});

describe('collectObservedItemIds (§6)', () => {
  it('collects every item id present in any lane cell', () => {
    const stats = { 1: { 1: { 5: {}, 6: {} }, 2: { 7: {} } }, 2: { 3: { 8: {} } } };
    expect([...collectObservedItemIds(stats)].sort((a, b) => a - b)).toEqual([5, 6, 7, 8]);
  });

  it('returns an empty set for empty statistics, without throwing', () => {
    expect(collectObservedItemIds({}).size).toBe(0);
    expect(collectObservedItemIds(undefined).size).toBe(0);
  });
});

describe('classifyCatalogue', () => {
  it('classifies every entry and marks unpurchased ones', () => {
    const items = { 1: entry({ id: 1 }), 2: entry({ id: 2 }), 3: entry({ id: 3, isStackable: true }) };
    const out = classifyCatalogue(items, new Set([1, 3]));
    expect(out).toHaveLength(3);
    expect(out.find((c) => c.itemId === 2)!.buildCandidate).toBe(BUILD_CANDIDATE.NO);
    expect(out.find((c) => c.itemId === 3)!.itemClass).toBe(ITEM_CLASS.STACKABLE);
  });
});
