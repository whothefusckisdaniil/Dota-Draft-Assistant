# Consumable / Permanent Item Taxonomy — ТЗ №40

**Verdict: `ITEM_CONSUMABLE_TAXONOMY_NOT_IDENTIFIABLE`.**

Valve's item file exposes explicit `ItemQuality` and `ItemPermanent` fields,
but together they do not produce an exhaustive binary classification for the
199 items in the shipped catalogue. The source key joins every shipped item;
the remaining gap is field semantics and coverage, not entity resolution.

This is research only. No classifier is wired into production, and this work
does not change `public/data`, `src/scoring`, or the build assembler.

## Source and method

The audit uses the public SteamDatabase/SteamTracking mirror of Valve's
`game/dota/pak01_dir/scripts/npc/items.txt`, pinned to commit
[`3f630cc18bfa63f63b3ce259be52209d922558c3`](https://github.com/SteamTracking/GameTracking-Dota2/commit/3f630cc18bfa63f63b3ce259be52209d922558c3).
This is Valve game item KV data in a community-maintained mirror, not a Valve
API. The exact source record key joins to `public/data/items.json.dname`.
No item-name pattern, alias, blacklist, or inference from cost/charges/stacking
is used to assign classes.

Reproduce (fetches the pinned public file; no token):

```sh
node scripts/item-consumable-taxonomy-research.mjs
```

Or run fully offline against an already downloaded Valve `items.txt`:

```sh
node scripts/item-consumable-taxonomy-research.mjs /path/to/items.txt
```

## Coverage on the shipped catalogue

| Measure | Result |
| --- | ---: |
| Shipped catalogue rows | 199 |
| Valve item records parsed | 544 |
| Exact canonical-key matches | 199 / 199 |
| `ItemQuality` present | 196 / 199 |
| `ItemQuality` absent | 3 / 199 |
| `ItemPermanent = 1` | 12 / 199 |
| `ItemPermanent = 0` | 15 / 199 |
| `ItemPermanent` absent | 172 / 199 |
| `ItemInitialCharges` present | 18 / 199 |
| `ItemPurchasable` present | 10 / 199 |
| Exact `ItemQuality=consumable` category | 15 / 199 |
| Rows classified by the two positive labels | 27 / 199 |
| Rows left unknown | 172 / 199 |

Quality values are source categories, not a validated permanent/consumed
mechanics label. `ItemPermanent` is an explicit source flag when present, but
is missing for 172 shipped entries; absence is not treated as `true` or
`false`. `ItemPurchasable`, stackability, charges, cost, and item key are
reported as independent metadata and are not used as substitutes.

## False-positive and disagreement audit

On the pinned Valve snapshot, none of the 15 `ItemQuality=consumable` rows also
has `ItemPermanent=1`; 13 explicitly have `ItemPermanent=0`, and two have no
permanence value. This internal cross-tab has no direct flag contradiction,
but it is **not** an independent validation that the quality category means an
item is consumed on use or that every other item is permanent.

The existing captured STRATZ fixture for Magic Wand records
`quality: "consumable"` in [item-metadata.test.ts](../scripts/item-metadata.test.ts).
The pinned Valve item file classifies that same canonical source key as
`ItemQuality "common"` and records charge-related fields. This is a material
cross-source category disagreement; neither value can silently override the
other. `public/data/items.json` does not currently persist either field, so the
production dataset cannot preserve or resolve this evidence.

The source leaves 172 of 199 catalogue items without `ItemPermanent`; most
non-consumable `ItemQuality` values (for example, component/equipment tiers)
are not a source assertion that the item is permanent. Calling them permanent
would turn a category label into an unsupported behavioral claim. The full
false-positive/coverage table is printed by the research runner; diagnostic
item keys are not classifier rules.

## Decision

`ItemQuality=consumable` can identify a source-tagged subset, and
`ItemPermanent=1` identifies a separate explicit-flag subset. The available
fields do not establish a complete, conflict-free consumable/permanent
partition, and the recorded STRATZ/Valve category disagreement further
prevents treating the sources as interchangeable.

Therefore:

```text
ITEM_CONSUMABLE_TAXONOMY_NOT_IDENTIFIABLE
```

The research runner exits 0 when it completes its audit, including this
negative finding. It returns non-zero only for source, parsing, or data
failures. A product decision is still needed before removing the №39 blocker:
show Starting and General recommendations without a clean-Core claim, or
restrict an initial build display to a consciously defined evidence subset.
That decision is outside this research ticket.
