# Level 1 item model (ТЗ №13) — research

> **Where the math lives.** All of it is defined once in
> `src/scoring/itemStats.ts` — a production-safe, dependency-free module. The
> research script imports it; it does not own it. The former
> `scripts/item-level1-model.mjs` was **removed** in ТЗ №14 §24: with the
> production ItemPrior engine now running on the same formulas, a second copy
> would have been free to drift away from the one that ships.
>
> `src/scoring/itemPrior.ts` consumes the same module, so every number in this
> document describes the engine that actually runs.


## 1. Problem

Answer, for a given hero and lane, *which items are statistically characteristic
of that hero on that lane*. Not item-vs-enemy, not a build optimiser.

## 2. Data semantics — what `instances` actually is

Measured over all 6 672 cells:

| question | answer |
| --- | --- |
| does `sum(instances) == purchases`? | **yes, exactly**, in every cell |
| distinct instance keys | `0`, `1`, `2` only |
| cells with an `instance 1+` | 393 of 6 672 |
| is `instances[0] <= heroGames` everywhere? | **no — 329 cells violate it** |
| worst ratio | **1.479** — Broodmother pos2 Soul Ring, 82 936 / 56 088 |

**`instances[0]` is not a per-game count.** A hero can record two first-copy
events in one match, so `instances[0]` exceeds `heroGames`. Therefore:

- `instances` is a **partition of purchases**, indexed by *nth purchase of the
  same item within a game*;
- **unique-game ownership is unrecoverable** from this aggregate and nothing may
  claim it. A hero that buys, sells and re-buys the same item is invisible here.

The items carrying `instance 1+` are exactly those a hero can buy more than once:
consumables and cheap stacking items — Greater Healing Lotus (85 cells), Bracer
(68), Great Healing Lotus (66), Null Talisman (41), Wraith Band (40), Oblivion
Staff (30), Infused Raindrops (26).

## 3. Naming: `purchaseEventsPerGame`, never `purchaseRate`

```
purchases = 130, heroGames = 100  ->  purchaseEventsPerGame = 1.30
```

1.30 is not "130% of games bought it". The numerator is events. 357 cells in the
current snapshot exceed 1.0, max 2.31.

## 5–6. Models and smoothing

- **A** `log1p(eventsPerGame)` — intensity
- **B** `log1p(eventShare)` — share of the hero's events
- **C** `log2(lift)` — affinity vs the lane population
- **D** `0.6·A + 0.2·B + 0.2·C` — candidate combination

Smoothing: `(purchases + α·baseline) / (heroGames + α)`, α ∈ {10, 50, 100, 500}.

**Sensitivity result: the ranking does not move at all** — Spearman ρ = 1.000
across a 50× α range for all nine benchmark cells; top-15 overlap stays 13–15/15.
Reason: the thinnest hero-position cells in the entire dataset contain **a single
item** (Undying pos1: 1 item / 251 events; Centaur pos5: 1 item; Witch Doctor
pos2: 1 item). A one-item ranking cannot reorder.

Consequence, stated plainly: **the real data never exercises the shrinkage
path.** α is a guard for a future thin-cell regime, not a knob to tune today.
The shrinkage behaviour is therefore pinned by synthetic tests instead.

## 7. Timing

`medianMinute` / `p25` / `p75` are **approximate** — reported as the point inside
the minute interval where the cumulative count crosses, not as exact minutes.
Exploratory buckets 0–10 / 10–20 / 20–30 / 30+; these are not build phases.

## 8–14. Classes

**Universal vs hero-specific** (§11) — the distinction the model must make:

| universal (lift ≈ 1) | hero-specific (lift ≫ 1) |
| --- | --- |
| Magic Wand 0.66, Agh's Scepter 0.88, Glimmer Cape 1.13, Blink 1.23, BKB 1.27 | Sange and Yasha 52, Parasma 12, Blade Mail 10, Witch Blade 9.6, Assault Cuirass 9.4, Buckler 7.3, Specialist's Array 7.1, Maelstrom 5.5, Mjollnir 5.4 |

Model A alone cannot separate these — Magic Wand tops many lanes while being the
*least* hero-specific item in the set. Only lift does.

**Duplicate-purchase bias** (§12) — `repeatShare = instances[1]/(0+1)`:
Wraith Band 25%, Oblivion Staff 44%, Greater Healing Lotus 20%, Great Healing
Lotus 12%, Perseverance 3.8%, Bracer 1.9%. Consumables and cheap stacking items
are inflated by events; `eventShare` and `lift` are more robust than raw
`eventsPerGame`.

**Neutral items** (§13) — Great Healing Lotus `ev/game 0.100, lift 0.76,
medMin 24`; Greater Healing Lotus `0.033, 0.63, 29`. Both sit **below** lift 1,
i.e. less than the lane average, so they sink naturally in every model. They
still deserve a separate class in a future engine: their timing profile (24–29
min) is entirely unlike a core item.

**Shard / Scepter** (§14) — Aghanim's Scepter `ev/game 0.522, lift 1.16,
medMin 31`; Aghanim's Shard `0.130, 1.04, 31`. Both are **universal and late**.
Worth flagging: Aghanim's Blessing (271) has `medMin 47` — a Roshan consumable
bought after the game is effectively decided, a textbook post-hoc purchase.

## 9. Benchmark results (α = 100)

| lane | Model A top-3 | Model C (lift) top-3 |
| --- | --- | --- |
| Sniper pos1 | Wraith Band, Dragon Lance, Maelstrom | Specialist's Array 2.82, Maelstrom 2.47, Mjollnir 2.44 |
| Anti-Mage pos1 | Perseverance, **Battle Fury**, Yasha | **Battle Fury 2.04**, Perseverance, Abyssal |
| Wraith King pos1 | Radiance, Blink, Magic Wand | Assault Cuirass 3.23, Buckler 2.87, Bracer 2.46 |
| Puck pos2 | Blink, Oblivion Staff, Witch Blade | Parasma 3.62, Witch Blade 3.27, Oblivion |

Every lane yields a recognisable profile: Sniper a carry/multi-hit set, Anti-Mage
a mid-tempo core set, Wraith King a survivability set, Puck an
intimidation/regen set.

## 4. Features

| feature | definition | why |
| --- | --- | --- |
| `purchaseEventsPerGame` | `purchases / heroGames` | how often, per game |
| `eventShare` | `purchases / Σpurchases(hero,position)` | share of the hero's own events |
| `purchases` (support) | raw count | separates 100 from 500 000 |
| `purchaseWinRate` | `wins / purchases` | **diagnostic only** |
| `lift` | shrunk hero intensity ÷ global position intensity | hero affinity |
| timing | from `byMinute` | when |

## 10. Battle Fury sanity — statistics only

| | Model A | Model C | Model D | verdict |
| --- | --- | --- | --- | --- |
| Anti-Mage pos1 | 2/29 | **1/29** | **1/29** | PASS |
| Sniper pos1 | absent | absent | absent | PASS |

Anti-Mage: 801 242 purchases / 616 623 games = 1.30 ev/game, eventShare 11.4%,
lift 4.12, median minute 14. Sniper has **no Battle Fury row at all** in the
dataset, so no model can rank it. No `heroId` or `itemId` branch exists anywhere
in `src/scoring/itemStats.ts`.

## 17. Recommended baseline

Not wired to production. Formula, with α = 100 and s = 0.01:

```
eventsPerGame  = purchases / heroGames
globalBaseline = Σ_events(all heroes, pos, item) / Σ_heroGames(all heroes, pos)
smoothed       = (purchases + α · globalBaseline) / (heroGames + α)
lift           = (smoothed + s) / (globalBaseline + s)

score = 0.6 · log1p(eventsPerGame)
      + 0.2 · log1p(eventShare)
      + 0.2 · log2(lift)
```

Why this shape:

- **intensity first** — it is the only term that knows "how often";
- **lift as a tie-breaker (0.2), not a driver** — lift alone promotes cheap
  hero-specific curiosities; on its own it ranked Sange-and-Yasha at lift 52,
  which is real but would dominate any list built on it alone;
- **eventShare at 0.2** — normalises for heroes with a huge item pool;
- **no winrate term** (§15). `purchaseWinRate` stays a diagnostic: adding it
  would reward items bought in decided games, which is exactly the bias the
  post-hoc analysis exposes (Aghanim's Blessing, median minute 47).

## 18. Limitations

1. **No enemy conditioning** (ТЗ №11 concluded PARTIAL).
2. **No build ordering** — an unordered histogram cannot yield an ordered build.
3. **Post-hoc purchases** are indistinguishable from decisive ones.
4. **Population skew**: Herald/Guardian weighted, not the pro meta.
5. **Events, not games** — every intensity number is event-based.
6. **Unique-game ownership is unrecoverable** (§2).
7. **Shrinkage is untested by real data** (§6) — no multi-item thin cell exists.
8. **Dotabuff comparison not performed** — HTTP 403, as recorded in
   `docs/item-data-research.md` §11. No scraping was attempted beyond a
   reachability check.
9. **Cross-hero comparison is invalid by construction** — every ranking is
   hero+position scoped; heroes are only compared to check generalisation.

## 19. Next step

1. ~~Add `itemData` to `DatasetMeta`~~ — **done** in ТЗ №14: `itemData?: ItemDataMeta`
   now lives in `src/data/dataset.ts`, so `meta.json`'s item block is typed.
2. Decide whether neutral items and Agh's Shard/Scepter form a separate class —
   the data supports it (low lift, late median) but it is a product decision.
   Still open.
3. Build the build engine on top of this baseline — **not recommended yet**, see
   `docs/build-profile-research.md`: the honest outcome of that research is that
   `core` / `situational` is **not identifiable** from these aggregates, and
   `position_est` from OpenDota turned out to be a round-robin
   (`docs/public-position-research.md`).

## 20. Reproducing

The script imports TypeScript directly, so Node needs `--experimental-strip-types`
(Node ≥ 22.6). Without the flag it fails with `ERR_UNKNOWN_FILE_EXTENSION`.

```bash
node --experimental-strip-types scripts/item-level1-research.mjs semantics    # §2
node --experimental-strip-types scripts/item-level1-research.mjs baseline     # §5-6, §9
node --experimental-strip-types scripts/item-level1-research.mjs timing       # §7
node --experimental-strip-types scripts/item-level1-research.mjs classes      # §11-14
node --experimental-strip-types scripts/item-level1-research.mjs sanity       # §10
node --experimental-strip-types scripts/item-level1-research.mjs sensitivity # §18
node --experimental-strip-types scripts/item-level1-research.mjs all
```

Fully offline: reads only `public/data/*.json`, makes no network call, and never
touches the STRATZ token. Runtime 20–95 ms on the 1.55 MB dataset.

## 21. Related documents

- `docs/item-prior.md` — the production engine built on this baseline
  (`getItemPrior`), including the runtime contracts this research implies.



