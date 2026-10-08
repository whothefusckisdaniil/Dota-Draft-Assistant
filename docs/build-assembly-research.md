# Build Assembly — ТЗ №39 research gate

**№39 verdict: `BUILD_ASSEMBLY_BLOCKED` (accepted/closed).** Its structural
checks passed; the original clean-consumable/Core requirement could not be
established from available metadata. The №41 product decision explicitly
permits recommendations without a clean-Core promise. The shared assembler is
now used by the production build engine, with unmapped phase candidates
retained in a clearly labelled `General` presentation bucket. See
[build-engine.md](./build-engine.md).

The engine is not yet connected to `src/main.tsx` or UI components. No
`public/data/*` files have been changed.

## Data contract

The only candidate path is:

```text
getItemPrior
  -> getBuildCandidates(heroId, position)
  -> assembleBuild(heroId, position, candidates)
```

The third argument is the `BuildCandidate[]` returned for that exact hero and
position. The pure assembler never calls the candidate builder, reads files,
or creates candidates. With no candidates it returns `NO_BUILD_DATA`; it never
falls back to another lane, hero, or global build.

Each phase item preserves:

```js
{
  itemId,
  phase,
  itemPriorRank,
  itemPriorScore,
  phaseEvidence,
  phaseReason
}
```

`phaseEvidence` retains Valve phase labels, phase families, exclusivity, and
the existing phase/timing agreement evidence. Canonical item IDs remain
separate, so Aghanim's Shard, Scepter, and Blessing are not merged. No component
or upgrade edges are inferred.

## Phase and ordering semantics

The six display groups, in canonical order, are exactly Valve categorical
build phases:

```text
Starting -> Early -> Core -> Mid -> Late -> Luxury
```

They are not minute ranges. `Starting` does not mean minute 0, and no group
asserts a purchase timestamp. An item's position in a group is its inherited
ItemPrior presentation rank only. It is not a causal or historical purchase
sequence. UI copy may show only the six category labels and should describe the
build as based on historical Hero + Position item patterns; it must not say
"buy at N min", "buy after X", or "optimal order".

Valve observations can list an item in several phases. The evidence layer
provides one phase-evidence object for the item, not independent strength
scores for each of its phase labels. Assembly therefore:

1. Rejects unavailable or unmapped phase evidence to `NO_PHASE`/`overflow`.
2. For duplicate candidate rows, prefers available mapped evidence, then an
   exclusive phase label, then existing `supported` agreement, then canonical
   phase order, then ItemPrior rank and item ID.
3. For multiple phase labels on one evidence row, deterministically chooses
   the earliest mapped display phase. It never uses the first source row,
   property enumeration, item name, or a newly derived timing rule.

`Other_Items` is not one of the six phases and is retained in provenance while
the item stays in `overflow`. No unavailable phase is guessed.

## Selection, caps, and invariants

The presentation caps are fixed and are not statistical thresholds:

| Valve phase | Capacity |
| --- | ---: |
| Starting | 3 |
| Early | 3 |
| Core | 5 |
| Mid | 3 |
| Late | 3 |
| Luxury | 3 |

Under-cap phases remain shorter, including empty. Overflow is not force-fitted.
After canonical phase assignment, an item ID appears at most once. Items within
each phase are ordered by ItemPrior rank, then ItemPrior score, then item ID.
The library's validator checks valid/canonical phases, evidence presence,
rank ordering, uniqueness (including overflow), and the assembled-item
subset-of-candidates invariant.

There is no enemy input, capability/matchup data, new scoring weight, slot
optimizer, dependency tree, timing model, `situational` class, or production
UI integration. The existing item-taxonomy classifier is used by the research
runner for a metadata-integrity check only; it does not filter, move, or label
build items.

## Offline snapshot results

Reproduce with:

```sh
node --experimental-strip-types scripts/build-assembly-research.mjs all
```

Pinned local data results:

| Metric | Result |
| --- | ---: |
| Heroes in snapshot | 127 |
| Heroes with at least one build | 127 / 127 |
| Eligible Hero × Position cells | 290 |
| Cells with build | 288 |
| Cells with `NO_BUILD_DATA` | 2 |
| Cells with at least one empty phase | 288 |
| BuildCandidates | 5,534 |
| Candidates with mappable Valve phase | 1,501 |
| Items in six display phases after caps | 1,431 |
| Items retained in `NO_PHASE` overflow | 4,033 |
| Items dropped by duplicate resolution | 0 |
| Items dropped by presentation capacity | 70 |
| Structural invariant violations | 0 |
| Puck pos 2 / Juggernaut pos 1 / Crystal Maiden pos 5 invented items | 0 |
| Reversed-input byte-identical checks | 290 / 290 |

Displayed phase counts across the eligible cells:

| Phase | Items | Cells where phase is empty |
| --- | ---: | ---: |
| Starting | 32 | 258 |
| Early | 269 | 87 |
| Core | 35 | 273 |
| Mid | 527 | 31 |
| Late | 566 | 40 |
| Luxury | 2 | 288 |

An empty phase is valid and is not backfilled. The large `NO_PHASE` count is
also intentional: an item without usable Valve phase evidence is not assigned
to a convenient display bucket.

## Blocking limitation: consumables

The existing taxonomy is grounded in `items.json` fields such as
`isPurchasable`, `isStackable`, `cost`, and `stockMax`. It deliberately has no
`consumable` or permanent-item property. In particular, `isStackable` cannot
separate consumables from re-buyable permanent items. No item-name list or new
classification rule is introduced here.

Consequently, the assembler cannot guarantee the requirement that consumables
not be mixed with permanent Core items while using only the approved layers.
The correct outcome is `BUILD_ASSEMBLY_BLOCKED`, not a silent heuristic. All
structural research commands still exit successfully when their checks pass;
the gate verdict records this data-contract blocker for the next engineering
decision.
