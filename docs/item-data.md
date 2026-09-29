# Item data (ТЗ №12) — production LEVEL 1

> **These statistics describe what heroes buy on each position.
> They are NOT item-vs-enemy recommendations.**
>
> Nothing in this layer is conditioned on the enemy draft. There is no counter
> logic, no build optimiser, no slot allocation and no UI. That is deliberate:
> item × enemy data is not obtainable at production volume (see
> `docs/item-vs-enemy-research.md`, verdict PARTIAL), and shipping a
> "recommended build" built on aggregates that cannot see the draft would be
> worse than shipping nothing, because it looks authoritative.

## 1. Data source

| file | source | endpoint |
| --- | --- | --- |
| `items.json` | STRATZ | `constants.items(language: ENGLISH)` |
| `item-stats.json` | STRATZ | `heroStats.itemFullPurchase(heroId, week, bracketBasicIds, positionIds)` |

Fetched by `scripts/stratz/items.mjs`, driven by
`scripts/update-data-stratz.mjs`, and published in the same atomic directory swap
as `heroes.json`, `matchups.json`, `positions.json` and `meta.json`. A failure in
either item fetch aborts the entire dataset run — the app can never serve new
matchups beside stale items.

## 2. Population

Identical to the matchup and position layers: `HERALD_GUARDIAN`,
`CRUSADER_ARCHON`, `LEGEND_ANCIENT`, `DIVINE_IMMORTAL`. Not "ranked only" —
rank-bracket weighted, which skews toward Herald/Guardian. Builds in that
population are not the pro meta, and the layer must not be presented as "the"
build.

## 3. Four-week window

The same four last **fully completed** weekly buckets as everything else (current
run: 2956–2959; partial bucket 2960 excluded). `itemFullPurchase` is bucketed by
week and is **not patch-filtered** — `meta.itemData.patchFiltered` is `false`.

One week was measured as insufficient: for Anti-Mage pos1 a single week already
matched the 4-week top-15, but for Bane pos4 the 4-week sum recovered three
items (Infused Raindrops, Great/Greater Healing Lotus) that one week misses.

## 4. Hero + Position contract

```
item-stats.json[heroId][position][itemId] -> { purchases, wins, heroGames, byMinute, instances }
```

**The position key comes from the REQUEST, never from the response.** STRATZ
answers `position: POSITION_1` for every non-empty result regardless of the filter
(ТЗ №10 §4), so the field is never even requested. A combined all-positions
request is likewise never issued: its result is not the union of the per-position
requests (measured: 223 keys vs 154, zero matching counts).

The unit of work is `(hero, position, week)` with heroes aliased 20-at-a-time —
140 batched requests, ~28 s.

## 5. Item metadata

`items.json` is the pruned STRATZ catalogue: 199 entries (197 shop items plus 2
neutral items that are genuinely purchased — Healing Lotus 4205/4206, which
carry `isPurchasable: false` and would otherwise be orphans).

- **Recipes are excluded** (`isRecipe: true`) — synthesis steps, not purchases.
- Internal-only entities (cheese, courier, upgrade variants) are excluded
  because they are neither purchasable nor ever purchased.
- Aghanim's Scepter (108) and Shard (609) are present and distinguishable via
  `stockMax` / `isStackable`.

Pruning happens **after** the statistics are fetched, so a neutral item survives
on the strength of being bought rather than on a shop flag.

## 6. purchase-event semantics

`purchases` counts **purchase events, not distinct games**. A hero can buy the
same item twice, and can buy several items, so:

```
purchases / heroGames = purchases PER GAME   (can exceed 1)
```

It is **not** a percentage of games and is never named `purchaseRate`. In the
current snapshot 357 cells exceed 1.0, maximum **2.31** — correct data, not a
defect, and the validator deliberately does *not* assert
`purchases <= heroGames`.

## 7. wins semantics

`wins` is a subset of `purchases`; the validator enforces `wins <= purchases`.
`wins / purchases` is a **winrate among purchases**: "when this item is bought,
how often did the game end in a win". It is not a per-game winrate and it is not
causal. There is deliberately no field called "item winrate", and nothing may
render "this item gives you +X%".

## 8. Time histogram

`byMinute` maps STRATZ's minute bucket to purchase events (observed 0–51). It is
kept as a **histogram**, not collapsed to an average, so a weighted mean, an
approximate median, percentiles and time buckets can be derived later without
another fetch. A minute beyond 90 fails validation instead of being silently
clamped — that would mean the time field is not what we think it is.

## 9. Instance semantics

`instances` maps the purchase-event copy index to its count; `0` is the first
copy owned. Copies are **not** summed: one copy and a re-buy are different build
signals, and a future engine may want "first owned copy" as a build anchor. The
current UI interprets none of this.

## 10. Missing data

Absence is recorded, never filled. 176 of 635 hero-position cells in the current
snapshot are empty. There is **no** hero-global fallback, **no** Pos1→Pos4
copying and **no** OpenDota role substitution, so a consumer can tell "no data"
from "this hero buys nothing here".

## 11. heroGames

The denominator comes from the already-validated `positions.json` for the same
hero, position, window and brackets — not from the item endpoint (which cannot
supply it) and never from summing purchases. It is stored per cell so a consumer
can compute purchases-per-game without the generator inventing a rate.

## 12. Validation

`validateItemData` gates metadata (unique keys, no recipes, required fields, no
orphan components) and statistics (known hero and item, non-negative integers,
`wins <= purchases`, valid minute/instance keys, and histograms that account for
every purchase). `verifyStagedDataset` re-checks on disk before the swap.

The single most important negative: **`purchases <= heroGames` is not checked
and must not be.**

## 13. Payload

| file | raw | gzip | parse |
| --- | --- | --- | --- |
| `items.json` | 48 KB | 6 KB | 0.1 ms |
| `item-stats.json` | 1.55 MB | 456 KB | 7.3 ms |
| whole dataset | 2.4 MB | — | — |

The histogram is the bulk of `item-stats.json` and is kept because dropping it
would destroy information (§8). If this ever needs to shrink, the compression
must be agreed first — a "compaction" that silently discards minute or instance
detail is not a decision to make unilaterally.

## 14. Limitations

- No enemy conditioning (ТЗ №11: not obtainable at production volume).
- No build ordering — the data says *what* and *when*, not *which item leads to
  which*.
- Population skew: Herald/Guardian builds, not the pro meta.
- Not patch-filtered; a dataset spanning patches mixes item regimes.
- Post-hoc purchasing: an item bought in a decided game is indistinguishable
  here from one that decided it.
- Backpack, shard/scepter slots and neutral-item slots are not modelled.

## 15. Future use

The next stage may consume `purchases`, `byMinute` and `instances` to build a
build recommendation. It must not: call `purchases / heroGames` a rate, read
`wins / purchases` as causal, condition on the enemy draft, or infer an ordered
build from an unordered histogram.

## 16. Fallback behaviour

`npm run update:data:opendota-fallback` regenerates `heroes.json`,
`matchups.json` and `meta.json` from OpenDota and **carries
`positions.json`, `items.json` and `item-stats.json` forward verbatim**. Those
three are STRATZ-derived and are not what the rollback replaces; carrying them
forward keeps the dataset complete. If any is missing, or if the carried
`item-stats.json` covers a different number of heroes than the regenerated
roster, the fallback fails loudly rather than publishing a dataset the app cannot
load. The carried `heroGames` values are explicitly NOT recomputed — the fallback
has no position statistics to recompute them from.

## 17. Verifying

```bash
node scripts/update-data-stratz.mjs   # regenerate all six layers
node scripts/verify-items.mjs         # §24 live sanity check + §25 payload
node scripts/verify-dataset.mjs       # cross-layer contract
```

