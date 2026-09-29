# Item metadata for the slot / consume model (ТЗ №16) — research

> **Not production.** `public/data`, `src/scoring`, `src/components`, the
> workflow, `item-stats.json` and the ItemPrior engine are untouched. This
> document proposes a schema; it does not ship one. Approval for the generator
> change is a separate ticket.

## Headline

The slot/consume model is **still not buildable from this source**, but the
reason is now much narrower and precisely documented:

- **The recipe graph is fully recoverable.** 125/125 recipes carry both
  `itemResult` and `components`, and the recovered edges match real recipes.
- **The consumption link does not exist in the API at all.** Not a single field
  connects Aghanim's Scepter to Aghanim's Blessing.
- **Charges are recoverable** (`initialCharges`, `isRequiresCharges`).
- **`consumedBy` / `departsFrom` / `held` are not in the schema** — they were
  never a matter of the generator forgetting to persist them.

## 1–2. What exists, what is persisted, what is lost

Real types (introspected, not assumed): `ItemType` (10 fields) and
`ItemStatType` (38 fields, reached as `ItemType.stat`). 604 items returned.

**Persisted today** (12 fields): `id, name, dname, shortName, cost,
isPurchasable, isStackable, isSideShop, stockMax, isSupportFullItem, image,
components`.

**33 schema fields are available and thrown away**, including 10 that matter
here: `isRecipe`, `needsComponents`, `itemResult`, `upgradeItem`, `upgradeRecipe`,
`initialCharges`, `isRequiresCharges`, `isPermanent`, `quality`, `behavior`,
`shopTags`.

The generator query already *fetches* `isRecipe` and `needsComponents` and uses
`isRecipe` only to drop recipes — neither value is written to disk.

**Fields that do not exist** (checked against both types): `consumedBy`,
`departsFrom`, `held`, `replaces`, `replacedBy`, `itemClass`, `qual`, `buyback`,
`consumable`, `charges`. `neutralItemTier` exists in the schema but is set on
**0 of 604** items — a dead field.

## 3. Recipe semantics — CONFIRMED, and stronger than expected

A recipe is `stat.isRecipe === true` and carries both halves of the edge:

```
recipe 35 -> item 36, parts [Magic Stick + Iron Branch + Iron Branch]
recipe 47 -> item 48, parts [Boots of Speed]
recipe 49 -> item 50, parts [Boots of Speed + Chainmail + Blades of Attack]
recipe 62 -> item 63, parts [Boots of Speed + Gloves of Haste + Belt of Strength]
recipe 64 -> item 65, parts [Gloves of Haste]
recipe 66 -> item 67, parts [Ogre Axe + Iron Branch + Ring of Regen]
```

These are correct: Power Treads really is Boots of Speed + Gloves of Haste +
Belt of Strength. **125/125 recipes have a complete edge**, and components are
non-empty on exactly those 125 — every one `isRecipe: true`, none a product.

This also corrects ТЗ №15, which concluded recipe ingredients were undetectable
from metadata. They are: `stat.quality === 'component'` marks **56 of 604**
items, and `needsComponents` marks the 129 recipe-flagged ones.

## 4. Consumption semantics — NOT AVAILABLE

The decisive negative result. Comparing the two entities that matter most:

| | Aghanim's Scepter (108) | Aghanim's Blessing (271) |
| --- | --- | --- |
| `stat.cost` | 4200 | **5800** |
| `stat.quality` | `"rare"` | `"rare"` |
| `stat.shopTags` | `int;str;agi;mana_pool;…` | `int;str;agi;mana_pool;…` |
| `stat.behavior` | 2 | 2 |
| `stat.isPermanent` | false | false |
| **stat fields that DIFFER** | | **`cost` only** |
| `name` | `item_ultimate_scepter` | `item_ultimate_scepter_2` |

**The two items differ in exactly one stat field: price.** `upgradeItem`,
`upgradeRecipe` and `itemResult` are `null` for both. Across the whole
catalogue, `upgradeItem` points at a *different* id for **1 item out of 604**
(Disperser 1097 → 174) — a recipe linkage, not a consumption relation.

> Even a `consumedBy` field would not have proven slot behaviour: nothing in this
> source states that any slot is freed.

## 5. Charge semantics — CONFIRMED

| field | coverage | examples |
| --- | --- | --- |
| `initialCharges` | 42/604 (18 of the shipped 199) | Bottle 3, Clarity 1, Observer Ward 1 |
| `isRequiresCharges` | 9/604 (8 shipped) | Magic Stick, Magic Wand, Hand of Midas, Urn of Shadows, Spirit Vessel |
| `isPermanent` | 12/604 (12 shipped) | Bottle, Hand of Midas, Urn of Shadows, Diffusal Blade, Wind Lace |


## 6–7. Transformation graph

The only transformation-like fields are `upgradeItem` / `upgradeRecipe`, and §4
shows they link *items to their recipes*, not to consumed outcomes.

**There is no transformation graph to build from this source.** The Scepter →
Blessing step is a gameplay fact with no metadata representation — consistent
with the ТЗ №11 finding that match-level data would be required.

## 8. Proposed contract (draft, not shipped)

```ts
interface ItemMetadataV2 extends ItemMetadataV1 {   // V1 fields unchanged
  isRecipe: boolean | null;
  itemResult: number | null;          // product of this recipe
  componentIds: number[] | null;      // parts of this recipe
  quality: string | null;             // 'consumable' | 'component' | 'rare' | …
  initialCharges: number | null;
  isRequiresCharges: boolean | null;
  isPermanent: boolean | null;
  shopTags: string[] | null;
  consumption: null;                  // always null: no source field
  slotSemantics: 'unknown';           // always 'unknown' for now
  slotEvidence: 'none' | 'quality-consumable' | 'quality-component' | 'quality-equipment';
}
```

`slotEvidence` is deliberately **separate** from `slotSemantics`. `quality:
'consumable'` is real evidence about what an item *is*; it is not a slot rule, so
it never upgrades the semantics field. `SLOT_SEMANTICS.CONSUMED` exists as a
name but is emitted by nothing.

### Backward compatibility

Every V1 field keeps its name, type and position; new fields are additive and
optional, so `src/data/dataset.ts` and the ItemPrior engine keep working
untouched. A migration needs only the generator to persist ~10 extra fields and
the loader to widen `ItemEntry`.

## 9. Unknown must remain unknown

Absent → `null`; `null` → `'unknown'`; never `'false'`. Pinned by tests:

- an item with no `stat` block yields `cost: null`, `charges: null`,
  `slotSemantics: 'unknown'` — not `cost: 0`;
- a null `quality` is not "not a consumable";
- `isStackable` and `stockMax` demonstrably do not move `slotSemantics`;
- a `displayName` of "Aghanim's Scepter" on an item with no supporting fields
  classifies identically to the real Scepter — the model never branches on names.

## 10. Coverage over the 199 shipped items

| property | confirmed | unknown |
| --- | --- | --- |
| recipe (is an itemResult of a recipe) | **116** | 83 |
| charge declaration (`initialCharges > 0`) | 18 | 181 |
| requires charges | 8 | 191 |
| is permanent | 12 | 187 |
| `quality: consumable` | 15 | 184 |
| `quality: component` (ingredient) | 55 | 144 |
| consumption / transformation link | **0** | **199** |
| slot semantics | **0** | **199** |

## 11. Three independent results

**A. Confirmed metadata**
`isRecipe`, `itemResult`, `componentIds`, `needsComponents`, `quality`,
`initialCharges`, `isRequiresCharges`, `isPermanent`, `isSellable`, `isDroppable`,
`stockMax`, `stackTime`, `shopTags`. The full recipe graph is recoverable.

**B. Partially inferable**
`behavior` is a bitmask on 415/604 items (Blink Dagger `137439478800`, Battle Fury
`8`) and clearly encodes Dota item-behaviour flags, but the schema exposes no
matching enum, so decoding it would be guesswork. `consumable` can be inferred
from `quality`, not from behaviour.

**C. Still unknown**
Consumption relations, transformation outcomes, slot occupancy, slot freeing,
which item consumes which. None of these exist in the source.

### Can we now build a reliable 6-slot state model?

**NO.**

Not because the generator forgot to persist fields — those were found and are
cheap to add — but because **the API has no consumption or slot fields to
persist**. Persisting all 33 available fields would give a complete recipe graph
and charge counts, and would still leave slot behaviour `unknown` for all 199
items.

The 6-slot model needs either a different source, or match-level data (ТЗ №11,
which concluded PARTIAL). Writing a slot optimizer now would mean inventing the
one rule this research proves is unavailable.

## 12. Next step

1. **Optional, cheap, worth doing**: persist `isRecipe`, `itemResult`,
   `components` (already fetched, already free), `quality`, `initialCharges`,
   `isRequiresCharges`, `isPermanent`. This fixes the ТЗ №15 "ingredients are
   undetectable" finding and gives the build engine a real recipe graph.
2. **Blocking**: obtain a source with consumption/slot fields, or accept that the
   slot model is manual. Do not start the optimizer until this is settled.

## Reproducing

```bash
node scripts/item-metadata-research.mjs discover   # schema + candidate verdict
node scripts/item-metadata-research.mjs all        # + live probe + compare
```

Token is read from `process.env` by the caller and never printed. The normaliser
(`scripts/item-metadata.mjs`) is pure and offline.

`isStackable` remains a **separate axis** from slot behaviour, per ТЗ №15.1.
