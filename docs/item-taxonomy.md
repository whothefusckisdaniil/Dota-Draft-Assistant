# Item taxonomy & slot model (ТЗ №15) — research

> **Not production.** `src/scoring`, `src/components`, the dataset loader, the
> workflow and `public/data` are untouched. The classifier lives in
> `scripts/item-taxonomy.mjs` and the analysis in
> `scripts/item-taxonomy-research.mjs`; nothing in `src/` imports either.

## Three separate answers (ТЗ §30)

| question | answer |
| --- | --- |
| **A. Slot model** — what is deterministic? | **Only partially.** Stack and purchase constraints are sourced. *Slot behaviour is `unknown` for all 199 items.* |
| **B. Timing model** — what is statistically solid? | **Yes.** Frequency, share, specificity and a purchase-time distribution are all solid. |
| **C. Core/Situational** | **NOT IDENTIFIABLE** from these features. |

## 1–3. Item metadata: what exists, what does not

`items.json` carries exactly 12 fields: `id, name, dname, shortName, cost,
isPurchasable, isStackable, isSideShop, stockMax, isSupportFullItem, image,
components`.

| field | usable? | note |
| --- | --- | --- |
| `cost` | yes | |
| `isPurchasable` | yes | separates shop-bought from in-game pickups |
| `isStackable` | yes | the only charge signal available |
| `stockMax` | yes | a **purchase cap**, not a slot |
| `isSideShop` | no | `false` for all 199 entries |
| `isSupportFullItem` | weak | 11 items, no gameplay meaning for builds |
| `components` | **no** | present but **empty for all 199 entries** |
| `isRecipe` | absent | filtered out by the generator before writing |

**Absent, and required for a real slot model:** `isRecipe`, `consumedBy`,
`charges`, `departsFrom`, held/passive behaviour, attribute bonuses. The
generator's STRATZ query fetches `isRecipe` and `needsComponents` but persists
neither, so the shipped file cannot answer slot questions.

### The catalogue is not a build-item list

**84 of 199 entries never appear in any statistics cell.** Of those, 54 cost
<1000 (wards, potions, cheap components) and **30 cost ≥1000** — alarming until
you read them:

```
Broadsword, Claymore, Mithril Hammer, Platemail, Ogre Axe, Blade of Alacrity,
Staff of Wizardry, Ultimate Orb, Talisman of Evasion, Demon Edge, Eaglesong,
Reaver, Sacred Relic, Hyperstone, Mystic Staff, Point Booster, Vitality Booster,
Diadem, Ring of Tarrasque, Blitz Knuckles, Revenant's Brooch, Tiara of Selemene,
Boots of Travel, Boots of Travel 2, Phase Boots, Power Treads, Arcane Boots,
Guardian Greaves, Boots of Bearing, item_caster_rapier
```

Two groups, **not separable from metadata**:

1. **Recipe ingredients.** STRATZ records the completed item, never its parts,
   and `components` is empty.
2. **Items removed from the game.** Power Treads, Arcane Boots, Guardian Greaves,
   Boots of Travel and Phase Boots no longer exist; the constants table keeps
   them forever.

What does separate them from real build nodes is `buildCandidate: no` — a
dataset-level observation, not a metadata property. **115 of 199 are candidates.**


## 4. Stack behaviour, purchase constraint, and slot behaviour

Three **separate** axes, because the source metadata supports three different
claims of very different strength:

| axis | values | n | source |
| --- | --- | --- | --- |
| `stackBehavior` | `stackable` / `non-stackable` | 19 / 180 | `isStackable` |
| `purchaseConstraint` | `unlimited` / `limited` | 181 / 18 | `stockMax` |
| `slotBehavior` | `unknown` | **199 / 199** | **nothing** |

> **The current dataset can classify stack and purchase constraints, but cannot
> establish inventory slot behavior.**

`slotBehavior` is `unknown` for every item, and that is the finding — not a
placeholder. An earlier version of this research reported `permanent` for
non-stackable unlimited items and `shared-charges` for stackable ones. **That was
wrong**: it converted *missing* metadata into an *asserted* gameplay behaviour,
and it contradicted this document's own conclusion two sections later.

The distinction that was blurred:

- `isStackable: true` says the item **holds charges**. It does not say whether
  those charges share a slot, occupy one, or occupy none.
- `stockMax: 1` says the item can be **bought once**. It says nothing about
  where the item lives. A shard (`stockMax: 1`) and a ward (`stockMax: 8`) are
  both purchase-limited, and neither fact is about inventory.

Purchase-limited items: Gem of True Sight, Clarity, Healing Salve, Observer
Ward, Sentry Ward, Tango, Smoke of Deceit, Enchanted Mango, Infused Raindrops,
Aghanim's Shard, 7 River Vials, Blood Grenade (18 total).

Every classification therefore carries an `unresolved` list naming what the data
cannot answer — including *"how many inventory slots the item occupies"* and
*"whether charges share a slot with each other"* — so a future slot model reads
the gap instead of assuming it away.


## 5. Aghanim's Shard

An ordinary purchase event (174 cells, 0.15 ev/g, median 27 min), `stockMax: 1`,
`isStackable: false`, `isPurchasable: true`.

**The dataset cannot answer the question that matters.** No field says "this does
not occupy an inventory slot" and none says it does. `stockMax: 1` is the only
hint, and `stockMax` is about purchase limits. A build engine must treat shard
slot behaviour as **unknown**.

## 6. Aghanim's Scepter vs Aghanim's Blessing — the strongest Part A finding

Two **separate catalogue entities**, and the statistics separate them:

| | id | cost | cells | avg ev/g | avg median |
| --- | --- | --- | --- | --- | --- |
| Aghanim's Scepter | 108 | 4200 | **234** | 0.47 | **29 min** |
| Aghanim's Blessing | 271 | 5800 | **70** | 0.08 | **47 min** |

The consumed upgrade appears in only **70 of the 234 cells** where the scepter
was bought, 18 minutes later on average. Therefore:

- a scepter is bought in 234 lane-cells and consumed in 70 — the two states are
  **individually measurable**;
- merging them would double-count 70 cells and mis-time the rest;
- the pair is a **hard case for any slot model**: before consumption it must
  occupy something, after consumption it must not.

`dname` is `item_ultimate_scepter_2` for the Blessing. That suffix is the only
link between them, and it is a **name pattern, not metadata**. A principled
version needs a `consumedBy` / `departsFrom` field, which STRATZ does expose but
the generator does not persist.

## 7. Moon Shard

`id 247`, cost 4000, ordinary inventory metadata — indistinguishable from a
4000-gold core item by metadata alone. The statistics set it apart: **14 cells**,
0.03 ev/g, **median 46 min**. The rarest late luxury in the dataset.

## 8. Neutral items

Two entries are `isPurchasable: false` — Great/Greater Healing Lotus
(`item_great_famango`, `item_famango`), both `cost: 0`, `isStackable: true`, and
both **do** appear as real purchase events (AM pos1: 70 851, `instances[1] =
14 053`). Seven River Vials (`item_river_vial_*`, ids 1021–1027) are
`isPurchasable: true`, `cost: 0`, `stockMax: 1` — and **never appear in any
statistics cell**: they are the drop entities, not the resulting items.

## 9. Recipes

Structurally excluded: the generator drops `isRecipe: true` before writing, so
**0 recipes are in the catalogue** and none can become a build node. The field is
not persisted, so the file cannot prove its own cleanliness — that guarantee
lives in the generator, not in the data.

## 10. Consumables

`isStackable: true` marks 19 entries, and they behave accordingly: Wraith Band
25 % repeat purchases, Oblivion Staff 44 %, Greater Healing Lotus 20 %.
`instances[1] > 0` in 393 of 6 672 cells, concentrated entirely in consumables
and cheap stackables.

**Metadata cannot separate "consumable" from "re-buyable permanent item"** — Wraith
Band and Oblivion Staff are both `isStackable: true` and both permanent. What
marks them as non-slots is **timing** (median 2 and 26 min) plus `instances[1]`,
not any catalogue field.

## 11–12. Timing distributions: a gradient, not two populations

Sniper pos1, ordered by `ev/g`:

```
Wraith Band          ev/g 1.29  med  2   |  0-10: 100.0%
Magic Wand           ev/g 0.49  med  3   |  0-10:  98.4%
Mask of Madness      ev/g 0.37  med 12   | 10-20:  77.0%
Maelstrom            ev/g 0.91  med 14   | 10-20:  87.5%
Dragon Lance         ev/g 1.11  med 17   | 10-20:  63.2%
Specialist's Array   ev/g 0.41  med 23   | 20-30:  42.9%
Mjollnir             ev/g 0.70  med 24   | 20-30:  54.5%
Hurricane Pike       ev/g 0.55  med 25   | 20-30:  68.5%
Crystalys            ev/g 0.57  med 30   | 30-40:  43.4%
Black King Bar       ev/g 0.24  med 33   | 30-40:  58.1%
Daedalus             ev/g 0.41  med 35   | 30-40:  54.7%
Satanic              ev/g 0.21  med 41   |  40+:   61.2%
```

Every adjacent pair overlaps. Frequency and timing trade off smoothly and
produce a continuum.

## 13–14. Bimodality test — and two bugs I had to fix first

`eta` (variance explained by the best single 1-D threshold) came out at
**74–80 %** for every feature, which looks like strong bimodality. It is not:

1. **My first `eta` was wrong by a factor of n** — it printed 13 735 %. Fixed.
2. **My peak detector skipped the first bin** — the largest spike, starting items
   at 0–4 min, was invisible, which manufactured a fake bimodal shape.

Both bugs pointed the same way: toward a conclusion the data does not support.
After fixing, over 186 benchmark cells:

```
median-minute counts
  0:31   5:8  10:21  15:15  20:26  25:27  30:31  35:17  40:5  45:4  50:1
local maxima: 3  (bins 0, 10, 30)

control (unimodal lognormal matched to median and IQR, deterministic sampling)
  real data  eta = 73.7%
  unimodal   eta = 61.2%   -> excess 12.5 pp
```

**Three local maxima, not two.** The control — a deliberately single-peaked
distribution — explains almost as much variance as the real data, on a
186-sample histogram.

### Verdict (§30 C): **CORE/SITUATIONAL IS NOT IDENTIFIABLE**

> Core/Situational is not identifiable from these aggregate features alone. The
> purchase-time distribution is continuous with three local maxima, and a
> deliberately single-peaked control explains almost as much variance.

The early spike at minute 0–4 is **mechanically explained** — starting items are
bought before the horn, so their median is 2 regardless of build philosophy. It
is not a "core" category.


So neutrals are **two different things** here, and the metadata distinguishes

## 15. The named sanity items

| item | id | cost | cells | avg ev/g | avg median |
| --- | --- | --- | --- | --- | --- |
| Wraith Band | 75 | 505 | 137 | 0.35 | **1 min** |
| Magic Wand | 36 | 460 | 422 | 0.60 | **2 min** |
| Mask of Madness | 172 | 450 | — | 0.37 | 12 min |
| Witch Blade | 534 | 2775 | 21 | 0.33 | 18 min |
| Battle Fury | 145 | 3900 | 23 | 0.50 | 15 min |
| Blink Dagger | 1 | 2250 | 211 | 0.64 | 20 min |
| Aghanim's Shard | 609 | 1400 | 174 | 0.15 | 27 min |
| Aghanim's Scepter | 108 | 4200 | 234 | 0.47 | 29 min |
| Black King Bar | 116 | 4050 | 187 | 0.46 | 30 min |
| Butterfly | 139 | 5450 | 39 | 0.27 | 33 min |
| Monkey King Bar | 135 | 5000 | 50 | 0.16 | 35 min |
| Satanic | 156 | 5050 | 30 | 0.24 | 39 min |
| Moon Shard | 247 | 4000 | 14 | 0.03 | 46 min |
| Aghanim's Blessing | 271 | 5800 | 70 | 0.08 | 47 min |

Two families separate cleanly: **sub-3000-gold items cluster at 1–20 min** (Wraith
Band 1, Magic Wand 2, Mask of Madness 12, Battle Fury 15, Witch Blade 18) while
**4000+ items cluster at 29–47 min** (Scepter 29, BKB 30, Butterfly 33, MKB 35,
Satanic 39, Moon Shard 46, Blessing 47). That boundary tracks **cost**, not a
gameplay role — which is exactly why "core" is not a statistical category.

## 16. Popularity vs specificity

The two lists are disjoint:

| universal (lift ≤ 1.2) | ev/g | lift | median | | hero-specific (lift ≥ 2.5) | ev/g | lift | median |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Magic Wand | 0.49 | 0.66 | 3 | | Sange and Yasha | 1.11 | 52.1 | 15 |
| Black King Bar | 0.24 | 0.53 | 33 | | Parasma | 0.77 | 12.3 | 28 |
| Aghanim's Scepter | 0.22 | 0.54 | 36 | | Blade Mail | 0.33 | 10.3 | 13 |
| Aghanim's Blessing | 0.13 | 1.13 | 46 | | Witch Blade | 1.27 | 9.6 | 14 |
| Aghanim's Shard | 0.11 | 1.03 | 31 | | Assault Cuirass | 0.45 | 9.4 | 32 |

A single "popularity" ranking cannot express both: Agh's Scepter is bought in
**11× more lane-cells than Witch Blade** (234 vs 21) and is *less* specific by an
order of magnitude. A build needs both kinds, so the two axes must stay separate.

## 17. Timing + specificity: four descriptive regimes

| regime | n | examples |
| --- | --- | --- |
| MID + ordinary | 69 | Blink Dagger, Desolator, Mask of Madness, Infused Raindrops, Falcon Blade |
| LATE (post-core / luxury-like) | 58 | Black King Bar, Monkey King Bar, Butterfly, Daedalus, Crystalys |
| MID + high-specificity | 33 | Force Staff, Shadow Blade, Mjollnir, Dragon Lance, Hurricane Pike |
| EARLY + high-frequency | 26 | Magic Wand, Wraith Band, Maelstrom, Perseverance, Battle Fury |

These **describe** the measured cells; they are not an enum and no consumer is
forced to treat them as a classification. Note the largest group is "ordinary" —
most bought items are unremarkable on both axes.

## 18. Bane pos4 vs pos5 — a clean structural finding

```
pos4 items = 10, pos5 items = 13, shared = 10
pos4-only: none
pos5-only: Force Staff, Wind Lace, Aghanim's Shard
volume:   pos4 heroGames = 79 286   pos5 heroGames = 141 589
```

**pos4 is a strict subset of pos5**: a common support core plus three items that
appear only on pos5. Cleaner than ТЗ №12's "overlapping but reordered" result,
and it is what a position-aware model should expect — the same hero on two
supports shares a core and differs by lane-specific extras.


## 19–20. Build order is not recoverable

Anti-Mage Battle Fury histogram: `{"9":2561,"10":9749,"11":31621,"12":72953,
"13":118744,"14":139955,"15":128983,…}`.

That is a **distribution over minutes, not a sequence**. Two items bought in the
same minute are indistinguishable, and the identical aggregate describes both
"bought X then Y" and "bought Y then X". The most that can be recovered:

- a purchase-window distribution per item (what §11 gives);
- a *relative* early/late ordering when windows barely overlap — Wraith Band at
  100 % before 10 min is unambiguously before Satanic at 61 % after 40 min;
- **no** total order, and no "item A → item B → item C" chain.

## 21–22. Future build state (design draft only)

```ts
interface BuildState {
  inventorySlots: 6;
  inventoryItems: number[];      // items believed to hold a slot
  upgrades: { shard?: number; scepter?: number; moonShard?: number };
  consumables?: number[];        // charges, not slots
  neutrals?: number[];           // separate pool
}
```

**Inventory state ≠ purchase history.** The dataset only ever observes the
latter. A slot-aware model needs new metadata before any of this can be filled.

## 23–24. Recommended taxonomy

Two **independent** axes, never collapsed into one boolean:

```ts
interface ItemTaxonomy {
  itemClass: 'regular' | 'stackable' | 'zero-cost' | 'not-shop-bought' | 'recipe';
  stackBehavior: 'stackable' | 'non-stackable';          // from isStackable
  purchaseConstraint: 'limited' | 'unlimited';           // from stockMax
  slotBehavior: 'unknown';                               // NOT derivable today
  buildCandidate: 'yes' | 'no' | 'unknown';              // from observed purchases
  unresolved: string[];                                  // what metadata cannot say
}
```

There is deliberately **no** `isCore`, `isSituational` or `isLuxury`: per §30 the
data does not identify them, and a boolean would launder a guess into a contract.

### Limitations

1. Slot occupancy and slot-freeing are **not determinable** from the shipped
   metadata. This is the blocking gap for a 6-slot model.
2. Recipe ingredients and removed items are indistinguishable from metadata.
3. `buildCandidate` depends on a 4-week window; a hero who stops buying an item
   flips to `no`.
4. The bimodality test runs on 186 cells — small for a distributional claim.
5. No enemy conditioning anywhere (ТЗ №11: PARTIAL).
6. Purchase events ≠ unique games, unique players, or final inventory state.
7. `instances` is a partition of purchases by copy index, **not** a per-game
   count (it exceeds `heroGames` in 329 of 6 672 cells), so nothing here uses it
   as an ownership proxy.

### Next step

**Do not build the optimizer yet.** The prerequisite is a metadata change:
persist `isRecipe`, `consumedBy`/`departsFrom` and charge counts from STRATZ so
slot semantics stop being a guess. That is a generator change for a later ticket,
and it is the only thing standing between this research and a real 6-slot model.

## Reproducing

```bash
node --experimental-strip-types scripts/item-taxonomy-research.mjs metadata
node --experimental-strip-types scripts/item-taxonomy-research.mjs timing
node --experimental-strip-types scripts/item-taxonomy-research.mjs bimodality
node --experimental-strip-types scripts/item-taxonomy-research.mjs spread
node --experimental-strip-types scripts/item-taxonomy-research.mjs sanity
node --experimental-strip-types scripts/item-taxonomy-research.mjs all
```

Offline: reads only `public/data/*.json`, no requests, no token. The maths comes
from `src/scoring/itemStats.ts`, so the numbers describe the shipping engine.

neither: in-game consumables that are bought, and drop pickups that are not.
