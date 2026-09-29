# Build Candidate Engine — Level 1 (ТЗ §20)

> **Isolated.** `src/scoring/buildCandidates.ts` is importable and tested, but
> nothing in `engine.ts`, the UI or the draft ranking calls it. Hero ranking is
> unchanged.

## What this layer is

```
ItemPrior  +  BuildPhasePrior   →   BuildCandidate[]
```

Level 1, scoped to one hero on one lane:

> Which items does this hero actually buy on this position, and what does each
> source independently have to say about them?

## What it is NOT

Stated plainly, because these are the things the type must never grow into:

- This layer **does not condition on the enemy draft.**
- This layer **does not infer core / situational / counter status.**
- This layer **does not optimize inventory slots.**
- This layer **does not combine evidence into a score.**

No `finalScore`, no `candidateScore`, no `coreScore`. `purchaseWinRate` is a
diagnostic and is **not** used to order candidates.

## The one judgement it makes

Candidates come from `getItemPrior()` **only**. An item Valve lists for a hero
but that STRATZ never observed on that lane is not promoted into the list.

That is a boundary, not a weight: a build recommendation has to be backed by
measured play. Smoke on the real snapshot: 3 672 Valve item slots exist across
the pinned itembuild files, and every candidate in the list is a genuine STRATZ
observation.

## No new mathematics

The candidate list **is** the ItemPrior list, in ItemPrior order. `rank` is a
copy of an existing ordering (1-based), not a new judgement. The prior travels
through untouched — the tests assert it deep-equals an independent evaluation, so
a future edit that rescores or renormalises it will fail loudly.

## API

```ts
getBuildCandidates(input: BuildCandidateInput): BuildCandidate[]
```

`limit` is the only knob, and it is consumer-side: `undefined` returns
everything, `limit: 15` returns fifteen, `limit: 0` returns `[]`. A negative or
non-integer `limit` throws `RangeError` rather than being silently reinterpreted.
There is no hidden default Top-N inside the module.

## Determinism

Pure. Same input, same array, same order — inherited from `getItemPrior()`
(score desc, purchases desc, itemId asc). No clock, no randomness, no
iteration-order dependence. A test asserts byte-identical JSON across calls.

## Evidence, not verdicts

Each candidate carries the whole `BuildPhasePrior`. A missing source stays
missing:

| situation | effect on the candidate |
| --- | --- |
| Valve has no build for this hero | candidate exists; `valveHero` / `phase` unavailable |
| Valve knows the hero, item not in build | candidate exists; `valveItem` available with `present: false` |
| no STRATZ cell for hero+lane | no candidates at all, and no Valve fallback |

The first two are covered by tests, and they are the reason the engine is safe to
build on: absence of evidence never removes an item, and never reorders one.

## What the snapshot shows

```
Anti-Mage pos1: 29 candidates, valve known 29/29, phase available 10
   #1 Battle Fury  0.93  t=14m  Mid_Items  undecided
   #2 Perseverance 0.91  t=11m  no_phase   -
Sniper pos1:     25 candidates, valve known 25/25, phase available 15
   #1 Wraith Band 0.94  t= 2m  Early_Game  supported
Wraith King pos1: 31 candidates
   #2 Assault Cuirass 0.88  t=32m  Late_Items  supported
Kunkka pos2:     17 candidates
   #1 Bracer 1.21  t= 2m  Early_Game  supported
```

Roughly 40 % of candidates carry a Valve phase; `supported` appears where the
two sources agree on the obvious end (starting items, late defensive), and
`undecided` dominates the middle — consistent with the measured 12 % agreement
rate in `docs/build-phase-prior.md`.

## Limitations

1. Level 1 only: no enemy conditioning (the underlying item-vs-enemy layer is
   still PARTIAL per ТЗ §11).
2. Slot semantics are `unknown` project-wide (ТЗ №15.1, №17), so nothing here can
   reason about which six items could co-exist.
3. Valve coverage is 126/127 heroes; the two gaps are documented in
   `docs/build-phase-prior.md`.
4. The candidate list is an observation set, not a build: it carries no order
   beyond the prior ranking and no slot model.

## Reproducing

```bash
npx vitest run src/scoring/buildCandidates.test.ts
node --experimental-strip-types scripts/build-candidates-smoke.mjs
```

Offline. No token, no network.
