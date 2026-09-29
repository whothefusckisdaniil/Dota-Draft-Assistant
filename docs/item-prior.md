# Item Prior (ТЗ №14) — production data/scoring layer

> **Not in the UI yet.** Nothing renders an item prior. The hero ranking does not
> read this module. It exists so a future Build Engine has a typed, tested,
> deterministic source instead of inventing one.

## 1. What an Item Prior is

For one **hero** on one **lane**, an ordered list of the items that hero
characteristically buys there, each with the statistics behind that judgement.

It is a *prior*, not a recommendation: it says "this is what the data shows",
never "buy this".

## 2. Scope: hero + position

```ts
getItemPrior(dataset, heroId, position): ItemPrior[]
```

Every prior is scoped to a single `(hero, position)` cell. Two lanes of the same
hero are computed independently and never borrow from each other — Bane pos4 and
pos5 are different datasets with different volumes and different scores.

A missing cell returns `[]`. It does **not** fall back to another lane, and it
does **not** fall back to OpenDota role tags. "We do not know" and "he buys
nothing here" are different answers, and the consumer must be able to tell them
apart.

## 3. The formula

```
eventsPerGame  = purchases / heroGames

globalBaseline = Σ events(all heroes, this lane, this item)
               / Σ heroGames(all heroes, this lane)

smoothed       = (purchases + 100 · globalBaseline) / (heroGames + 100)

lift           = (smoothed + 0.01) / (globalBaseline + 0.01)

score          = 0.6 · log1p(eventsPerGame)
               + 0.2 · log1p(eventShare)
               + 0.2 · log2(lift)
```

`eventShare = purchases / Σ purchases(hero, lane)`.

Constants live in `ITEM_PRIOR_PARAMS` and are fixed by ТЗ №14 §4. Changing them
requires re-running the ТЗ №13 research, not a whim.

### Why the population baseline (not the hero's own average)

A hero's own average would make every item on his lane look equally
characteristic — the ratio would be ~1 by construction and carry no information.
The baseline must be **all heroes on the same lane**, so `lift` measures hero
affinity rather than self-consistency.

## 4. Purchase-event semantics

`purchases` counts purchase **events**, not distinct games. It routinely exceeds
`heroGames` (Anti-Mage: 801 242 Battle Fury events across 616 623 carry games,
1.30). So:

- `purchaseEventsPerGame` is **not** a rate and **not** a percentage;
- the dataset deliberately contains **no** `purchaseRate` field;
- `instances` is a partition of events by nth copy in a game. `instances[0]` is
  **not** a per-game count — it exceeds `heroGames` in 329 of 6 672 cells — so
  unique-game ownership is unrecoverable and nothing here claims it.

## 5. What `purchaseWinRate` does not mean

`wins / purchases` is the winrate **among purchase events**. It is not "this item
gives you +X%".

- A hero who buys an item in minute 40 of a decided game inflates it.
- A hero saved by a teammate's item never records it.
- It is **excluded from `score`** and exists for diagnostics only.

## 6. Timing fields

`medianPurchaseMinute`, `p25PurchaseMinute`, `p75PurchaseMinute` are
**approximate**: the source histogram is bucketed by minute, so a quantile
reports the point inside the interval where the cumulative count crosses, not an
exact minute. `meanMinute` is exact for the bucketed data.

The 0–10 / 10–20 / 20–30 / 30+ shares are exploratory buckets, **not** build
phases. The raw `byMinute` histogram is carried through so a future build-order
model can use it without regenerating the dataset.

## 7. What an Item Prior does not know

- **The enemy draft.** There is no enemy input anywhere in the signature. ТЗ №11
  concluded the Item×Enemy layer is PARTIAL, so conditioning on the draft is not
  something the current data can support honestly.
- **Build order.** The source is an unordered histogram; there is no sequence in
  it and none is inferred.
- **Item classes.** There is no `isCore`, `isSituational` or `isCounter` field.
  Adding one would freeze a guess into a contract; classification is a later
  stage. Neutral items and shard/scepter are ordinary priors with no penalty
  and no slot metadata.

## 8. Performance

The population baseline is built **once per `Dataset` instance** and memoised in a
`WeakMap` keyed on the dataset object. Without it every call would rebuild the
127 × 5 × ~25 aggregate. Measured: a full `getItemPrior` call is well under 1 ms
with the cache warm, and a new dataset object can never serve stale aggregates.

## 9. Contracts enforced at runtime

- every emitted number is finite (NaN and Infinity are sanitised at the
  boundary — `wins` included, since a corrupt cell must not leak into the
  public shape);
- `heroGames <= 0` → the cell is skipped, never divided by;
- a stats row whose item is missing from `items.json` **throws** rather than
  being silently dropped, because the dataset validator owns that invariant;
- ordering is deterministic: score desc, purchases desc, itemId asc.

## 10. It is a foundation, not a feature

`getItemPrior` returns **all** valid items with no top-N cut — the consumer
decides how many it needs. A build engine will likely need more candidates than
a UI list would show.
