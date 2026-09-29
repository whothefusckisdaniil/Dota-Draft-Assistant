# Item / build data research (ТЗ №10)

**Verdict: GO** for collecting Hero + Position + Item statistics — with two
constraints that are not optional and must be designed around now, not
discovered later:

1. the `position` field in a response **lies** — it is always `POSITION_1` when
   the result set is non-empty, so position must come from the *request*;
2. `matchCount` is a **purchase count, not a game count** — it can exceed the
   hero's total games in the same slice, so it must never be divided naively by a
   game count to produce a "purchase rate".

Everything below was measured against the live API. Nothing was assumed.

---

## 1. Current architecture

```
OpenDota /heroes · /heroStats · /constants/patch          (fresh, every run)
                        │
                        ▼
              canonical heroes[]  ─────────────────────┐
                        │                             │
                        ├─ heroIds ─┐                 │
                        │           ▼                 │
                        │    STRATZ GraphQL            │
                        │    (Playwright transport)    │
                        │      heroStats.matchUp ──▶ matchups.json
                        │      heroStats.stats  ──▶ positions.json
                        │      heroStats.itemFullPurchase ──▶ (future item layer)
                        │                                 │
                        └──────────▶ heroes.json ◀────────┘
                                       │
                              meta.json (window, brackets, provenance)
                                       │
                              atomic directory swap
                                       │
                                       ▼
                        public/data/{heroes,matchups,positions,meta}.json
                                       │
                                       ▼
                          src/data/dataset.ts  loadDataset()
                                       │
                                       ▼
                          src/scoring/engine.ts  scoreCandidates()
```

Production data lives in `public/data/` and is written **only** by
`scripts/update-data-stratz.mjs`, in one atomic directory swap. The future item
layer belongs at exactly the same altitude as `matchups.json` / `positions.json`
— same generator, same run, same weekly buckets, same brackets, same swap — and it
must be added to `DATASET_FILES` in `scripts/dataset-publish.mjs` so it can never
be published out of step with the rest.

Nothing in that path was modified by this research.

## 2. STRATZ schema findings

Item fields live on `HeroStatsQuery` (under `heroStats`), **not** on the Query
root — a first pass that searched the root found nothing and nearly led to a
"no item data" conclusion.

```
itemFullPurchase(heroId:Short, week:Long, bracketBasicIds:RankBracketBasicEnum,
                 positionIds:MatchPlayerPositionType, minTime:Int, maxTime:Int,
                 matchLimit:Int) -> HeroItemPurchaseType
itemStartingPurchase(heroId, week, bracketBasicIds, positionIds) -> HeroItemStartingPurchaseType
itemBootPurchase(heroId, week, bracketBasicIds, positionIds)     -> HeroItemBootPurchaseType
itemNeutral(heroId, week, bracketBasicIds, positionIds)          -> HeroNeutralItemType
```

`HeroItemPurchaseType` — the one a build engine wants:

| field | type | meaning |
| --- | --- | --- |
| `heroId` | Int | echo (see §4 — echoes are unreliable) |
| `position` | MatchPlayerPositionType | **echo, unreliable — use the request** |
| `itemId` | Int | joins to `constants.items.id` |
| `instance` | Int | which copy of the same item (0, 1, …) |
| `time` | Long | minute bucket, see §5 |
| `matchCount` | Long | **purchases**, not distinct games — see §6 |
| `winCount` | Long | purchases that ended in a win |
| `winsAverage` | Decimal | winCount / matchCount, the API's own rate |

`itemStartingPurchase` adds `wasGiven: Boolean` — the one field separating a
bought starting item from a granted one, exactly the distinction a "first item"
recommendation needs.

## 3. Hero → Item data

Confirmed and rich. Sniper pos1, one complete week, four brackets: **437 rows over
22 distinct items**; Anti-Mage pos1: 623 rows / 28 items; Wraith King pos1:
484 rows / 31 items.

## 4. Hero + Position → Item data

**Supported, and it genuinely changes the answer.** `positionIds` is a real
`LIST of MatchPlayerPositionType`.

| Bane, week 2959, filter | rows | sum `matchCount` |
| --- | --- | --- |
| `POSITION_1` | 0 | 0 |
| `POSITION_2` | 2 | 674 |
| `POSITION_3` | 0 | 0 |
| `POSITION_4` | 103 | 65 201 |
| `POSITION_5` | 154 | 144 815 |

Kunkka over the same slice: pos1 = 1 row, pos2 = 178, pos3 = 286, pos4 = 3,
pos5 = 0 — five genuinely different datasets, and they line up with the
production `positions.json` (Kunkka 32.5% pos2 / 58.6% pos3 / 4.9% pos4 / 2.2%
pos5; the thin pos4 slice returns 3 rows, pos5 none).

### The `position` echo is a liar

Every non-empty response above returned `position: "POSITION_1"` regardless of
what was requested. **The filter works; the echo does not.** This is the same
class of defect already documented for `week` / `bracketBasicIds` in
`docs/stratz-research.md`, and it constrains the contract: position must be
recorded from the request, never read back from the response.

### One request per (hero, position) is mandatory

The obvious optimisation — one request per hero with all five positions — is
**unusable** for a position-keyed dataset:

| Bane, week 2959 | distinct (item, instance, time) keys |
| --- | --- |
| union of the 5 single-position responses | 154 |
| the single all-positions response | 223 |
| keys whose count matches between the two | **0 of 154** |

The combined response is not the sum of the per-position responses, and its rows
carry no usable position label. Position-attributed data therefore costs one
request per (hero, position) pair. This is the single most important design
constraint of this research, and it is invisible until you measure it.

## 5. Timing availability

`time` is a `Long` with values `0…51`, **contiguous integers** (verified: every
value between min and max is present). Purchases concentrate in a sharp early
peak (t=0: 3 629 → t=2: 23 760 → t=5: 5 284), then flatten to a broad plateau of
10–14k per minute from t=10 to t=29. That shape matches in-game behaviour
(starting items at 0–3 min, then a steady stream), so `time` is read as **game
minutes**. STRATZ publishes no unit for it, so this is an inference from the
distribution, not a documented guarantee — worth pinning with a test before any
timing feature ships.

`itemFullPurchase` also accepts `minTime` / `maxTime` filters, so a future
"late-game items" slice is expressible.

There is **no** median or percentile field and no item-level "average purchase
time". Timing must be derived from the histogram: a weighted mean is computable, a
true median is not (the bucket counts are not individual observations).

## 6. Win outcome availability

**Available and correctly conditioned.** Each row carries `matchCount` and
`winCount` for the same (item, instance, time) cell, plus the API's own
`winsAverage`. Item-conditioned winrate is real, not derived from unrelated
aggregates.

It must be used with care:

- `matchCount` is a **purchase** count. Anti-Mage pos1 returned 218 715 Battle
  Fury purchases against 167 925 hero games in the same week and brackets — a
  ratio of **130.2%**. Dividing purchases by a game count does not yield a rate.
- Consequently `winsAverage` is a *winrate among purchases*, not a per-game
  winrate. It answers "when this item is bought, how often does the game end in a
  win" — useful for build advice, but not "winrate of games with this item", and
  the two must not be conflated in wording.

No join to the matchup layer is possible: these are per-item aggregates with no
enemy identity, so an item cannot be conditioned on the drafted enemy.

## 7. Item metadata

`constants.items(language: ENGLISH)` returns **604 entries** with
`id, name, displayName, shortName, isSupportFullItem, image`, and
`constants.item(id:)` adds `stat { … }` with everything a build engine needs:
`cost`, `isPurchasable`, `isRecipe`, `needsComponents`, `stockMax`,
`initialStock`, `isStackable`, `isSupport`, `isSideShop`, `isSellable`,
`isDroppable`, `quality`, `aliases`, `upgradeItem`, `upgradeRecipe`,
`neutralItemTier`, and `components { index, componentId }`.

| id | item | cost | purchasable | isRecipe | stockMax | components |
| --- | --- | --- | --- | --- | --- | --- |
| 145 | Battle Fury | 3900 | true | false | 0 | — |
| 108 | Aghanim's Scepter | 4200 | true | false | 0 | — |
| 609 | Aghanim's Shard | 1400 | true | false | 1 | — |
| 247 | Moon Shard | 4000 | true | false | 0 | — |
| 44 | Tango | 90 | true | false | 10 | — |
| 62 | Power Treads Recipe | 0 | true | **true** | 0 | 29, 25, 17 |

All the special entities the ТЗ asked about exist and are distinguishable:
Aghanim's Shard (609, `stockMax: 1`), Aghanim's Scepter (108), Moon Shard (247),
Tango and other consumables (stackable, `stockMax > 0`), and neutral items (via
`neutralItemTier` on the separate `itemNeutral` query).

**Recipes are a distinct entity** (`item_recipe_*`, `isRecipe: true`) and can be
excluded by flag. Verified independently: across the 70 distinct item ids seen in
purchase data, **zero were recipes** — STRATZ already reports only the finished
item, so recipe filtering is not strictly required, though the flag exists.

All 70 observed ids resolved in `constants.items`; **no orphan ids**, so a
metadata join has no dangling keys.

## 8. Population / bracket semantics

The same `bracketBasicIds` used by the matchup pipeline works verbatim:
`HERALD_GUARDIAN`, `CRUSADER_ARCHON`, `LEGEND_ANCIENT`, `DIVINE_IMMORTAL`.
Applying them moved Sniper's pos1 response from 1 417 rows (no bracket filter) to
1 411 — small, but the unfiltered default is not the same population and the
difference must not be assumed away. The same weekly-bucket semantics apply: week
is epoch seconds, the 4 complete buckets sum cleanly, and the current partial
bucket can and should be excluded exactly as in production.

One population caveat worth carrying forward: these brackets skew heavily toward
Herald/Guardian, where lane and build choices differ markedly from the
pro/high-MMR meta most people picture when they hear "Dotabuff build".

## 9. One complete week vs four

| | week 2956 | 2957 | 2958 | 2959 | 1 week | 4 weeks |
| --- | --- | --- | --- | --- | --- | --- |
| Anti-Mage pos1 distinct items | 29 | 27 | 27 | 28 | 28 | **29** |
| Bane pos4 distinct items | 10 | 7 | 7 | 7 | 7 | **10** |

- **Anti-Mage**: top-15 overlap between week 2959 alone and the 4-week sum is
  **15/15** — one week is already stable. Items with <50 purchases: 0.
- **Bane pos4**: overlap 7/15 (all 7 of his items), and the 4-week sum recovers
  three items a single week misses entirely — Infused Raindrops, Great Healing
  Lotus, Greater Healing Lotus. Items with <200 purchases over 4 weeks: 0.

Conclusion: **use the same 4 complete weeks as production.** One week suffices
for a high-volume carry but is demonstrably lossy for a thinner support slice,
and a different window than the rest of the dataset would break the
same-snapshot guarantee.

## 10. Battle Fury sanity check

Battle Fury is **id 145** — resolved from `constants.items`, not assumed. (An
earlier pass of this script hard-coded 135, which is Monkey King Bar, and
produced a completely inverted result. The id was wrong; the data was fine.)

Same week, same four brackets:

| hero · position | BF purchases | BF winrate |
| --- | --- | --- |
| Anti-Mage pos1 | **218 715** | 50.6% |
| Sniper pos1 | 0 | — |
| Wraith King pos1 | 0 | — |
| Puck pos2 | 0 | — |
| Bane pos4 | 0 | — |
| Bane pos5 | 0 | — |
| Kunkka pos3 | 0 | — |

The source separates them perfectly, and it does so **statistically** — no
blacklist, no hero-specific rule, just an item id and a count. A hero either
shows the item or it does not.

## 11. Dotabuff reference comparison

**Not performed: Dotabuff returns HTTP 403** (anti-bot protection) to both direct
fetches and the browser. The ТЗ scoped Dotabuff as a manual UX/data sanity check
and explicitly forbade scraping it for production, so this is recorded as a
limitation rather than worked around. The qualitative comparison that *can* be
made from STRATZ alone: the item sets returned for Anti-Mage (Battle Fury, Manta
Style, Yasha, Skadi, Mjollnir, Abyssal Blade, Butterfly) and Sniper (Wraith
Band, Maelstrom, Mjollnir, Crystalys, Hurricane Pike, Butterfly) match the
shapes of the familiar builds — consistent with the population caveat in §8
rather than contradicting it.

## 12. Alternative sources

| Source | Endpoint | Hero | Position | Item | Timing | Winrate | Patch | Population | Limits | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **STRATZ** | `heroStats.itemFullPurchase` | yes | **yes** | yes | minute buckets | **yes** | weekly buckets | bracket filter | Cloudflare; browser transport | **chosen** |
| OpenDota | `/api/heroes/{id}/items` | — | — | — | — | — | — | — | **HTTP 404, retired** | unusable |
| OpenDota | `/api/constants/items` | n/a | n/a | 501 entries, string-keyed | no | no | no | n/a | free, no key | metadata cross-check only |
| Dotabuff | web pages | yes | yes | yes | yes | partly | yes | rank-filterable | **HTTP 403**, no API, ToS | reference only, unreachable |

OpenDota's item constants are a viable cross-check for metadata, but they expose
no statistics at all, and mixing a third-party metadata source with STRATZ
statistics adds a join key for no proven benefit. STRATZ's own `constants`
covers the same ground on the transport the project already uses.

## 13. API limits and batching

- `itemFullPurchase.heroId` is `NON_NULL Short` — a **scalar**. There is no
  `heroIds` list, so batching must use GraphQL field aliasing.
- Aliasing works: 3 heroes in one request, 2 309 rows, 563 ms, 180 KB payload.
  The matchup pipeline already uses this pattern.
- `positionIds` **is** a list, but §4 shows the combined response is unusable, so
  the real unit of work is `(hero, position, bucket)`.

| approach | requests for 127 heroes × 5 positions × 4 buckets |
| --- | --- |
| naive, one per cell | 2 540 |
| aliased in groups of 20 heroes per (position, bucket) | **~127** |
| for comparison, the existing matchup pipeline | 4 |

~127 requests at ~0.5 s each is a couple of minutes — comfortably inside the
existing weekly schedule, and nowhere near a design needing tens of thousands of
calls.

Payload: ~110 KB for one hero across all positions. Aggregated 4-week data for
127 heroes should land in the low tens of MB uncompressed, which is the one
sizing item worth measuring before committing to a shape. Sparse slices
(Bane pos1 = 0 rows) contribute nothing, so real volume is well below the
127 × 5 worst case.

## 14. Proposed future data contract (draft only — not published)

Two files, both part of the same atomic swap as the rest of the dataset.

`public/data/items.json` — metadata, one entry per item, refreshed rarely:

```json
{ "145": { "name": "Battle Fury", "displayName": "Battle Fury",
           "cost": 3900, "isPurchasable": true, "isRecipe": false,
           "isStackable": false, "isSideShop": false, "components": [] } }
```

`public/data/item-stats.json` — statistics, keyed `heroId` → position → item:

```json
{ "1": { "1": { "145": { "purchases": 218715, "wins": 110640,
                         "firstMinute": 8,
                         "byMinute": { "8": 41200, "9": 30100 },
                         "instances": { "0": 218715 },
                         "heroGames": 167925 } } } }
```

Design notes, each forced by a measured finding rather than by taste:

- **keyed by position explicitly**, because the response cannot tell you (§4);
- **raw counts preserved, never pre-divided**, because `matchCount` is purchases
  and a rate would be a fabrication (§6);
- **`byMinute` kept as a histogram**, not collapsed to a mean, so a median remains
  computable if the raw bins are kept (§5);
- **`instances` kept** rather than summed — two copies of an item is a different
  build signal from one;
- **`heroGames` stored alongside**, so a consumer can compute a *coverage* rate
  without the generator inventing one.

`meta.json` would gain an `itemData` block mirroring `positionData`: source,
weekly buckets, brackets, and the explicit note that the population is
rank-bracket weighted, not "ranked only".

## 15. Risks and limitations

1. **The `position` echo lies.** Position must be carried from the request. Any
   consumer that trusts the response will silently label every row position 1.
2. **`matchCount` is purchases, not games.** Ratios against a game count can
   exceed 100% (measured: 130.2%). Wording must say "winrate among purchases".
3. **`time` units are inferred, not documented.** Treat as minutes provisionally
   and pin with a test.
4. **No item × enemy conditioning.** Build advice can be "what this hero buys",
   never "what to buy against this specific enemy" — that would need a different
   source entirely.
5. **Population skew.** Herald/Guardian-weighted builds are not the pro meta;
   recommendations must not be presented as authoritative "the" build.
6. **Thin slices exist.** Bane pos1 and pos3 return zero item rows. A future
   engine must fail closed per position rather than fall back to hero-global
   items, exactly as the position gate does.
7. **`itemNeutral` was not exercised** in this pass; neutral items are a separate
   query type and may need their own contract.
8. **No build-ordering signal.** The data says *what* and *when*, not *which item
   leads to which*. A "build" in the Dotabuff sense (an ordered core progression)
   is not directly available; it would have to be inferred from the minute
   histogram, and that inference is a design decision for the next stage, not
   something this research settles.
9. **Aggregates are not joinable.** Item rows carry no enemy, no teammate and no
   game id, so nothing here can be correlated with the matchup layer.

## 16. GO / NO-GO

**GO** — for "collect Hero + Position + Item statistics".

Justified by: a confirmed source supporting every required axis (hero, position,
item, timing, win outcome), a clean metadata join with no orphans, the same
4-week window and same brackets as the existing pipeline (hence no second
population story), a batching strategy that fits the existing weekly schedule at
~127 requests, and a sanity check (Battle Fury) that separates correctly on
statistics alone with no hero-specific rules.

No decision is made here about a build engine; §15.8 in particular means the
"build" concept itself still needs design work before it can be built.

The first implementation step should be the item-metadata file plus a single
(hero, position) fetch whose correctness is asserted against the §4 findings — in
particular, a test that fails if the `position` echo is ever trusted.

## 17. Reproducing this

```bash
node scripts/item-research.mjs schema     # §2  introspection, no assumptions
node scripts/item-research.mjs sample     # §3  the 5 required heroes
node scripts/item-research.mjs position   # §4  does positionIds filter?
node scripts/item-research.mjs semantics  # §5/§6 time and matchCount meaning
node scripts/item-research.mjs meta       # §7  item metadata fields
node scripts/item-research.mjs names      # §7  resolve observed ids to names
node scripts/item-research.mjs stat       # §15 item stat flags
node scripts/item-research.mjs window     # §9  1 week vs 4 weeks
node scripts/item-research.mjs bfury      # §10 Battle Fury sanity check
node scripts/item-research.mjs batching   # §13 aliasing + additivity
```

The script is read-only: it reads `public/data/`, queries STRATZ, and caches
responses under `/tmp/stratz-research/cache`. It never writes to `public/data`,
and the token is only read from `process.env.STRATZ_API_TOKEN` (falling back to
the git-ignored `.env`), never logged and never cached.

