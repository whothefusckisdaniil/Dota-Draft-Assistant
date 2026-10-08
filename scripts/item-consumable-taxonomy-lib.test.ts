import { describe, expect, it } from 'vitest';
import {
  auditConsumableTaxonomy,
  parseValveItems,
} from './item-consumable-taxonomy-lib.mjs';

const source = `
"DOTAAbilities"
{
  "Version" "1"
  "item_consumable"
  {
    "ItemQuality" "consumable"
    "ItemPermanent" "0"
    "ItemPurchasable" "1"
    "ItemInitialCharges" "1"
    "AbilityValues" { "charges" "1" }
  }
  "item_equipment"
  {
    "ItemQuality" "rare"
    "ItemPermanent" "1"
    "ItemPurchasable" "1"
  }
  "item_unknown"
  {
    "ItemQuality" "consumable"
  }
  // Comments and nested values must not leak into top-level records.
}`;

describe('parseValveItems', () => {
  it('parses item fields and nested KeyValues deterministically', () => {
    const rows = parseValveItems(source);
    expect(rows.map((row) => row.canonicalKey)).toEqual([
      'item_consumable', 'item_equipment', 'item_unknown',
    ]);
    expect(rows[0].fields.ItemQuality).toBe('consumable');
    expect(rows[0].fields.AbilityValues.charges).toBe('1');
  });

  it('rejects malformed source instead of silently returning no classifications', () => {
    expect(() => parseValveItems('')).toThrow(/non-empty/);
    expect(() => parseValveItems('"DifferentRoot" { "item_a" {} }')).toThrow(/DOTAAbilities/);
    expect(() => parseValveItems('"DOTAAbilities" { "item_a" {')).toThrow(/Unclosed/);
  });
});

describe('auditConsumableTaxonomy', () => {
  const catalogue = {
    1: { id: 1, dname: 'item_consumable' },
    2: { id: 2, dname: 'item_equipment' },
    3: { id: 3, dname: 'item_unknown' },
    4: { id: 4, dname: 'item_not_in_source' },
  };
  const entries = parseValveItems(source);

  it('joins by exact canonical key and preserves unknown source fields', () => {
    const result = auditConsumableTaxonomy(catalogue, entries);
    expect(result.totals).toMatchObject({
      catalogueItems: 4,
      exactSourceMatches: 3,
      sourceMissing: 1,
      qualityKnown: 3,
      qualityUnknown: 1,
    });
    expect(result.rows[0]).toMatchObject({
      itemId: 1,
      quality: 'consumable',
      permanent: false,
      purchasable: true,
      initialCharges: 1,
    });
    expect(result.rows[2].permanent).toBeNull();
    expect(result.rows[3].quality).toBeNull();
  });

  it('does not mistake a quality tag with unknown permanence for exhaustive taxonomy', () => {
    const result = auditConsumableTaxonomy(catalogue, entries);
    expect(result.qualityConsumablePermanentCrossTab).toEqual({
      permanent: 0,
      nonPermanent: 1,
      unknown: 1,
    });
    expect(result.supportsExhaustiveBinaryTaxonomy).toBe(false);
  });

  it('flags contradictory authoritative labels rather than picking one', () => {
    const contradictory = parseValveItems(`
      "DOTAAbilities" {
        "item_x" {
          "ItemQuality" "consumable"
          "ItemPermanent" "1"
        }
      }
    `);
    const result = auditConsumableTaxonomy(
      { 1: { id: 1, dname: 'item_x' } },
      contradictory,
    );
    expect(result.qualityConsumablePermanentConflicts).toHaveLength(1);
    expect(result.classificationCounts.conflict).toBe(1);
    expect(result.supportsExhaustiveBinaryTaxonomy).toBe(false);
  });

  it('does not use substring matches for the consumable category', () => {
    const semicolonCategory = parseValveItems(`
      "DOTAAbilities" {
        "item_x" { "ItemQuality" "consumable;laning" }
      }
    `);
    const result = auditConsumableTaxonomy(
      { 1: { id: 1, dname: 'item_x' } },
      semicolonCategory,
    );
    expect(result.qualityConsumableCount).toBe(1);
    expect(result.consumableRows[0].quality).toBe('consumable;laning');
  });
});
