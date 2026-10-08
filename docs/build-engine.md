# Production Build Engine — ТЗ №41

## API

`getBuild(heroId, position)` in `src/scoring/buildEngine.ts` loads the local
dataset and returns a production recommendation model. For a caller that
already holds the loaded dataset, `createBuildEngine(dataset).getBuild(...)`
provides the same behavior synchronously.

```ts
{
  heroId,
  position,
  status: 'ready' | 'no-build-data' | 'ineligible-position',
  items: [{
    itemId,
    rank,             // inherited ItemPrior rank
    phase,            // Valve category or "general"
    itemPriorScore,
    evidence,         // ItemPrior + full BuildPhasePrior provenance
  }],
  confidence: {
    status: 'not-calibrated',
    reason,
  },
  caveats,
}
```

## Recommendation semantics

The only item source is `getBuildCandidates(heroId, position)`, which itself
starts with the existing ItemPrior. The existing BuildPhasePrior then supplies
the Valve phase evidence. The production engine uses the shared pure assembly
core in `src/scoring/buildAssembly.mjs`; the research entry point
`scripts/build-assembly-lib.mjs` re-exports this same implementation.

Items with a mapped Valve phase are presented in the six canonical phase
groups and use the existing phase capacity and ItemPrior ordering. Items with
unavailable phase evidence or only unmapped labels such as `Other_Items` are
retained as `General`. `General` is a product presentation bucket, not a Valve
phase, not a new item class, and not evidence that the item is permanent or a
core item. Every item retains its exact phase evidence.

`rank` and the order within a phase are presentation ranks from ItemPrior.
Neither implies which item was purchased first. Phase names are categorical
labels, not game-minute timing.

There is no numerical confidence score: the data has no calibrated build
confidence model, and №41 adds no new weights or thresholds. The explicit
`not-calibrated` status prevents a UI from presenting an invented probability.

The `caveats` field carries the recommended user-facing explanation:

> Recommendations are based on historical Hero + Position item purchase
> patterns. Build phases are based on historical item-build data; item order
> within a phase is ranked by purchase prior.

It also states that `General` lacks a mappable Valve phase and that the model
does not adjust for enemies, capabilities, slots, item dependencies, or
win-based weights. It does not call items “optimal”, promise a clean core, or
claim an exact purchase order.

## Fail-closed behavior

- Unsupported position values throw `RangeError`.
- Unknown heroes and missing ItemPrior cells return `no-build-data`.
- Positions that fail the existing empirical eligibility gate return
  `ineligible-position`; there is no fallback to another position.
- An assembler result outside the exact BuildCandidates set or a duplicate
  item ID throws an explicit error.
- The engine does not classify consumables/permanent items. Taxonomy remains
  unresolved, so General and phase groups make no cleanliness guarantee.

The engine is production code but is **not yet connected to the UI**. №42 is
the separate presentation/integration step.

## Validation

```sh
npx vitest run src/scoring/buildEngine.test.ts scripts/build-assembly-lib.test.ts
npm run typecheck
npm run build
```
