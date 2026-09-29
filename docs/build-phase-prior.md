# Build Phase Prior (ТЗ №18)

> **Isolated.** `src/scoring/buildPhase.ts` is new and imported by nothing.
> No production data, scoring, UI or workflow changed. The existing ItemPrior
> formula is untouched — this module only *joins onto* its output.

## 1. Goal

Combine two independent sources into one row per `(hero, position, item)`:

```
STRATZ  Hero + Position -> Item   frequency, eventShare, lift, timing histogram
Valve   Hero + Item      -> Phase  categorical build labels
```

The point is to answer "**when in a build** is this item characteristic", not
just "how often is it bought".

## 2. Valve source, reproducibly pinned (§1)

Raw game files are not committed. One normalized snapshot is:

| | |
| --- | --- |
| file | `research/valve-itembuilds.json` (134 KB) |
| origin | `SteamDatabase/GameTracking-Dota2` → `game/dota/itembuilds/` |
| source commit | `e84714d6ff871cfae0b59f3f9038860f052fa247` (2026-09-25) |
| official Valve API | **false** — community mirror of shipped files |
| hero files | **127** |
| hero-less template files | 1 (`default_generic.txt`) |
| distinct Valve item names | 148 |
| regenerate | `node scripts/fetch-valve-itembuilds.mjs` |

The fetcher carries **no timestamp**, only the pinned commit, so the same input
always produces a byte-identical snapshot. It fails closed: one unusable file
aborts the write and names the file.

> §6's 128-vs-127 discrepancy is explained, not an error: 129 files = **127 hero
> builds + 1 generic template** with no `"hero"` key.

## 3. Phase semantics (§3)

`Starting_Items > Starting_Items_Secondary > Early_Game > Early_Game_Secondary >
Core_Items > Core_Items_Secondary > Mid_Items > Late_Items > Luxury > Other_Items`

These are **labels Valve authors by hand**. They are not minute ranges, not
positions, and not derived from anything measurable. An item may sit in several
phases at once — measured across 127 heroes, **66 % of items appear in more than
one phase**.

**A Valve phase is not converted into minutes anywhere in this module.** §9 is
enforced by construction: `BuildPhasePrior.valve.phases` is `string[]`; there is
no `phaseMinute` field, and the timing axis is populated only from the STRATZ
histogram.

## 4. Item mapping (§4, §5)

Valve itembuilds use internal names (`item_bfury`); the catalogue's `dname` holds
the same string. The join is **exact**, with no fuzzy matching and no fallback.

| | |
| --- | --- |
| distinct Valve names | 148 |
| resolved to a canonical itemId | **122** |
| recipe-like, excluded from the item namespace | 3 |
| unresolved | 23 |

Recipes are excluded by design: `item_recipe_force_staff`, `item_recipe_wraith_band`,
`item_recipe_orchid` are real Valve entities that would otherwise enter the build
namespace as buildable items (§5).

The 20 distinct unresolved names split into two kinds:

- **Valve name variants** — `item_manta_style` (catalogue: `item_manta`),
  `item_boots_of_speed` (catalogue: `item_boots`). Recoverable, but only with an
  alias table, which §4 does not authorise.
- **Items the catalogue no longer carries** — `item_blood_stone`, `item_mango`,
  `item_ghost_scepter`, `item_hand_midas`, `item_hood_of_defiance`,
  `item_diffusal_blade_2`, `item_eternal_shroud`. Mostly removed from the game.

## 5. Coverage — current status is 126/127 (§18.1)

| metric | value |
| --- | --- |
| Valve hero files | 127 |
| canonical heroes | 127 |
| **hero join** | **126 / 127** |
| cells with ≥1 Valve phase | 440 (96 %) |
| (hero, item) pairs with a phase | 3 466 |

For reference, before the ТЗ §18.1 fix the join was **107/127** with 80 % cell
coverage. The authoritative OpenDota key is now persisted in `heroes.json`; no
alias table exists or is needed.

> Previous versions derived the key from the localized display name, which
> caused 20 mismatches; the authoritative OpenDota key is now persisted in
> `heroes.json` and used verbatim. No alias table exists or is needed.

`normalizeHero()` now stores `key: h.name` - the raw OpenDota internal name -
and `src/data/dataset.ts` reads it instead of slugifying. Both fail closed on a
missing or malformed key, so slugification cannot creep back.

| display name | authoritative key | old (wrong) slug |
| --- | --- | --- |
| Anti-Mage | `npc_dota_hero_antimage` | `npc_dota_hero_anti_mage` |
| Wraith King | `npc_dota_hero_skeleton_king` | `npc_dota_hero_wraith_king` |
| Lifestealer | `npc_dota_hero_life_stealer` | `npc_dota_hero_lifestealer` |
| Zeus | `npc_dota_hero_zuus` | `npc_dota_hero_zeus` |

### The two remaining gaps are real, and are not aliased

The join is **126/127**, not 127/127, and neither gap is fixable without
hardcoding:

1. **`npc_dota_hero_bird_samurai`** - Valve's itembuild file predates Skywrath
   Mage's rename. OpenDota's current authoritative name is
   `npc_dota_hero_skywrath_mage`, so the project side is right and the Valve file
   is stale. Bridging it needs an alias, which §9 forbids.
2. **`npc_dota_hero_kez`** - the hero has no itembuild file in the pinned Valve
   snapshot at all.

Recorded rather than papered over, and pinned by a test asserting the exact set
of two, so a future Valve refresh that fixes either one fails loudly.

### Battle Fury regression (§8) - now passes

```
Anti-Mage pos1   Battle Fury  score 0.93  ev/g 1.30  median 14  valve [Mid_Items]
```

Before the fix this row carried no Valve evidence at all, because Anti-Mage is
exactly the hero whose slug was wrong.

## 6–7. What each source actually tells us

**Valve**: which build *phase* a hero's item is authored into. Hero-scoped,
position-free, no numbers, no outcomes.

**STRATZ**: how often the hero buys it on that lane, with what lift, and when in
the game. Position-scoped, empirical, no build phase.

**The join is hero + item only** (§7). No enemy. And because Valve carries no
position, a phase prior is `Hero + Item` — `getBuildPhasePrior` returns the same
Valve phases for every position of a hero, and a test pins that (§21).

## 8–10. Agreement, measured

STRATZ median purchase minute, grouped by Valve phase family (benchmark lanes):

| family | n | p25 | median | p75 |
| --- | --- | --- | --- | --- |
| early | 7 | 1 | **2** | 2 |
| mid | 14 | 3 | 14 | 25 |
| late | 20 | 24 | 29 | 34 |
| other | 24 | 24 | 28 | 35 |
| starting | 0 | — | — | — |

The `early` family is unambiguous (all 7 rows under 15 min). `late` and `other`
overlap heavily, and `Other_Items` is a catch-all rather than a timing class.

Agreement matrix over 64 comparable rows (research boundaries: early < 15 min,
late ≥ 30 min):

```
family         med<15  med15-30   med>=30
early               7         0         0
mid                 8         5         1
late                0        11         8
other               2        11        10

agreement 16 (25%)   conflict 0 (0%)   undecided 48 (75%)
```

> A first implementation of `classifyPhaseAgreement` reported **17 % conflicts**.
> That was a bug: it treated "Valve says late, STRATZ says mid-range" as a
> conflict. A conflict is the two sources landing on **opposite ends**; the
> middle band is undecided. Corrected, real conflicts are **0 %** — the sources
> never flatly contradict each other, they mostly leave the question open.

Conflicts are **reported, never corrected** (§10).

## 11–15. Benchmarks, Battle Fury, early/core/late

Sniper pos1 shows the intended shape:

| item | score | ev/g | median | Valve phase | agreement |
| --- | --- | --- | --- | --- | --- |
| Wraith Band | 0.94 | 1.29 | 2 | Early_Game | **agreement** |
| Maelstrom | 0.90 | 0.91 | 14 | Mid_Items | unknown |
| Dragon Lance | 0.84 | 1.11 | 17 | Mid_Items | unknown |
| Mjollnir | 0.82 | 0.70 | 24 | Late_Items | unknown |
| Daedalus | 0.42 | 0.41 | 35 | Late_Items | **agreement** |
| Satanic | 0.21 | 0.21 | 41 | Other_Items | unknown |

**Battle Fury (§12)**: Anti-Mage pos1 → rank 1, `ev/g 1.30`, median 14 min, and
**Valve phase evidence exists**: `Mid_Items`. Sniper pos1 → absent from STRATZ
and from Valve, with **no fallback applied**; the absence is preserved rather
than filled in, which is what §12 asks for.

Core-like items (Battle Fury, Maelstrom, Manta, BKB, Skodi, Butterfly, Satanic)
get a **phase profile**, never an `isCore` flag (§14). Late/luxury items (Moon
Shard at median 50 min) keep their measured timing and are compared against
Valve's labels without any causal conclusion (§15).

## 16–17. What is still not derivable

**Build order.** A phase *set* plus a timing *histogram* cannot yield `A → B → C`.
Items bought in the same minute are indistinguishable, and an unordered label
set is not a sequence. `early-like` / `late-like` are describable; order is not.

**Position.** Valve has no position. Phase is `Hero + Item`; position-specific
relevance lives only in the STRATZ layer, and a global phase is never presented
as position-specific evidence (§21).

**Candidate models A/B/C** (§17–§19) are intentionally not combined into a
single number. A produced no new information (it is the existing prior); B is a
categorical label with no magnitude; C would require the weights §16 explicitly
declines to pick. Forcing them into one score now would invent the very thing
this research measures.

## 18. Recommended representation

```ts
interface BuildPhasePrior {
  heroId, position, itemId, itemName;
  itemPrior: ItemPrior;          // unchanged STRATZ prior
  valve?: { phases, phaseFamilies, source, phaseExclusive };
  timing: { p25, median, p75 };  // STRATZ only
  phaseAgreement?: { type, details };
}
```

Keep the two axes side by side and **do not merge them**. A consumer wanting
"early, characteristic item" filters on both fields; it does not read a blended
score.

## 19. Limitations

1. Hero join is 126/127; 2 documented gaps, both unfixable without aliases (§5).
2. 23 Valve item names unresolved, 2 recoverable as variants.
3. Agreement 25 %; 75 % of rows undecided by construction.
4. `Other_Items` is a catch-all with no timing meaning.
5. Valve phases are Valve's opinion, not measured play.
6. Snapshot is pinned to one commit and will drift from live game data.
7. Nothing is wired into the UI; the module is unexercised in the app.

## 20. Remaining gaps and next step

The authoritative `npc_dota_hero_*` key **is** persisted in `heroes.json`
(ТЗ №18.1), which is what took the join from 107/127 to 126/127. That work is
done; what remains are two gaps that are not code defects:

| gap | project side | Valve side | why no alias |
| --- | --- | --- | --- |
| Skywrath Mage | `npc_dota_hero_skywrath_mage` | `npc_dota_hero_bird_samurai` | Valve's itembuild file predates the rename. The project side is current and correct; the mirror is stale. An alias would encode a fact about the mirror's history into production identity. |
| Kez | `npc_dota_hero_kez` | *(no itembuild file)* | The hero has no build file in the pinned snapshot. Nothing to join to. |

Both are pinned by `scripts/hero-identity.test.ts`, which asserts the exact set
of two — so a future Valve refresh that closes either one fails the test loudly
instead of silently changing coverage.

**126/127 is a coverage limitation of one Valve snapshot, not a defect.** A
Build Engine must handle "Valve evidence present" and "Valve evidence absent"
as equally normal states, and must never read absence as a negative signal about
the item.

Next step is the production-safe `BuildPhasePrior` (ТЗ №19), which must keep the
three signals separate rather than blending them into one score — with 75 % of

---

# ТЗ §19 — production Evidence Model (`BuildPhasePrior`)

> **Not wired into the app.** `getBuildPhasePrior` is importable and tested, but
> nothing in the UI, draft ranking or `scoreCandidates` calls it. Hero ranking is
> unchanged (§29).

## Architecture (ТЗ §19.1)

```
Canonical production layer
  src/scoring/buildPhasePrior.ts      evidence model + Valve mapping helpers
  src/scoring/buildPhaseAgreement.ts  phase families + agreement rule

Research
  scripts/build-phase-research.mjs    imports the canonical modules
  scripts/fetch-valve-itembuilds.mjs  pinned snapshot fetcher
```

There is **one** implementation of `ValvePhase`, `PHASE_FAMILY`,
`VALVE_PHASE_ORDER` and the item-name mapping. The earlier
`src/scoring/buildPhase.ts` duplicate (and its test file) was **removed** in
ТЗ §19.1; its still-relevant cases moved into `buildPhasePrior.test.ts`. The
research script imports from the canonical modules only.

## Purpose

For one `(hero, position, item)` triple, collect the independent evidence a
future Build Candidate Engine will need — **without merging it into a score**.

```
STRATZ item prior        ─┐
STRATZ purchase timing   ─┤
Valve hero evidence      ─┼─→  BuildPhasePrior  (5 signals, no magic number)
Valve item evidence      ─┤
Valve phase evidence     ─┘
```

## Evidence model

```ts
type Evidence<T> =
  | { status: 'available';   source: string; value: T }
  | { status: 'unavailable'; source: string; reason: UnavailableReason };
```

A discriminated union, not an optional field. `status` is always explicit, and
`value` cannot be read without first narrowing on it.

## The rule the whole type exists to enforce (§0)

**Absence of evidence is never a negative signal.** Two situations that are
opposites in meaning, and which this model refuses to conflate:

| | status | reason | meaning |
| --- | --- | --- | --- |
| Valve does not know the hero | `unavailable` | `hero_data_unavailable` | ignorance |
| Valve knows the hero, item not in its build | **`available`**, `present: false` | — | real, measured negative |

Both are exercised by tests, and the Kez benchmark row shows the first in the
wild: `valveHero=no_build_file` while the STRATZ prior stays `0.05` and timing
`med 2m`. A missing Valve file never lowers a STRATZ signal.

## Hero evidence (§2)

The join is on the authoritative `hero.key` stored in `heroes.json` (ТЗ §18.1) —
**no slugification, no alias table** (§13).

```ts
{ status: 'available', heroKey, buildFile }
{ status: 'unavailable', heroKey, reason: 'no_build_file' | 'hero_key_mismatch' }
```

## Item evidence (§3, §14)

Present when the hero is known and the item maps exactly on `dname`. When Valve
knows the hero but the item is not in the build, the result is
`{ available, present: false, phases: [] }` — never `unavailable`.

Mapping is exact or nothing: an id with no catalogue entry gives
`item_not_in_catalogue`; a duplicated `dname` gives `item_mapping_unresolved`.

## Timing evidence (§5)

From the existing STRATZ `byMinute` histogram via `histogramStats` — never
recomputed, never back-filled from a global or neighbouring-lane value.

```ts
{ status: 'available', value: { p25Minute, medianMinute, p75Minute, meanMinute, earlyShare, … } }
{ status: 'unavailable', reason: 'no_stratz_cell' | 'zero_purchases' | 'empty_histogram' }
```

## Valve phase evidence (§4)

Carries every phase Valve authored for the item, deduplicated, plus
`phaseExclusive` (false when the item sits in several phases — the label is
fuzzy, and the model says so rather than picking one, §16–17).

## Agreement (§19–§21)

```ts
type AgreementDecision = 'supported' | 'undecided' | 'conflicting' | 'unavailable';
```

`getPhaseAgreement(valvePhases, timing)` compares Valve's phase family with the
STRATZ median. Boundaries are explicit, exported constants:

```ts
AGREEMENT_BOUNDARIES = { earlyMedianBelow: 15, lateMedianAtOrAbove: 30 }
```

`undecided` is a first-class outcome. Measured on the current snapshot: **supported
25 %, undecided 75 %, conflicting 0 %**. The rule is not tuned to make that look
better; rounding the middle into agreement would manufacture a signal the data
does not have (§21).

## Reason codes (§22)

Deterministic identifiers, never prose. A UI may render them as text later.

| scope | codes |
| --- | --- |
| hero | `no_build_file`, `hero_key_mismatch` |
| item | `hero_data_unavailable`, `item_mapping_unresolved`, `item_not_in_catalogue` |
| stratz | `no_stratz_cell`, `zero_purchases`, `empty_histogram` |
| phase | `no_phase`, `hero_data_unavailable`, `item_mapping_unresolved`, `item_not_in_catalogue` |
| agreement | `no_phase`, `no_timing`, `not_decidable`, `agreement`, `conflict` |

`PhaseUnavailableReason` and `ItemUnavailableReason` are separate literal unions,
and `phase.reason` is the **upstream** reason verbatim (ТЗ §19.1 §5). A broken
item identity is reported as `item_mapping_unresolved`, not as a missing hero —
those are different defects with different fixes, and collapsing them would hide
one behind the other. The compiler enforces it: assigning a stratz-scoped reason
to `phase.reason` is a type error.

## What is deliberately absent

| excluded | why |
| --- | --- |
| `finalScore` / `combinedScore` (§9) | with 75 % undecided, a blend hides an arbitrary weight choice inside one number |
| enemy input (§10) | Level 1 only; the data cannot support enemy conditioning honestly (ТЗ §11) |
| slots / inventory / current build (§11) | slot semantics are still `unknown` project-wide (ТЗ №15.1, №17) |
| `nextItem` / ordering (§12) | an unordered phase set plus a histogram cannot yield `A → B → C` |
| hero/item hardcoding (§28) | verified by grep and by tests that assert the exact input/output key sets |

A test asserts the exact input and output shapes, so a future addition of any
forbidden field fails rather than slipping in.

## Benchmarks (§25)

```
AntiMage p1 BF         prior=0.93 timing=med 14m valveHero=available valveItem=Mid_Items    phase=Mid_Items -> undecided
Sniper p1 BF           prior=unavailable timing=unavailable valveHero=available valveItem=present:false phase=no_phase
Puck p2 WitchBlade     prior=1.17 timing=med 14m valveHero=available valveItem=Mid_Items    phase=Mid_Items -> undecided
Bane p4 AetherLens     prior=0.72 timing=med 21m valveHero=available valveItem=Late_Items   phase=Late_Items -> undecided
Bane p5 AetherLens     prior=0.69 timing=med 22m valveHero=available valveItem=Late_Items   phase=Late_Items -> undecided
WraithKing p1 Radiance prior=0.93 timing=med 16m valveHero=available valveItem=Mid_Items    phase=Mid_Items -> undecided
Kez p1 WraithBand      prior=0.05 timing=med  2m valveHero=no_build_file valveItem=hero_data_unavailable phase=hero_data_unavailable
```

The Kez row is the whole thesis in one line: no Valve file, and the STRATZ
signals are untouched. The Sniper row shows the §3 rule from the other side —
Valve knows Sniper, Battle Fury is simply not in the build, so item evidence is
`available` with `present: false`, and prior/timing are `unavailable` because
STRATZ has no cell either.

## Limitations

1. Valve coverage is **126/127** (ТЗ §18.1); `bird_samurai` and `kez` are the two
   documented gaps.
2. Agreement 25 %; 75 % undecided by construction.
3. `Other_Items` is a catch-all with no timing meaning.
4. Phase families come from Valve's opinion, not measured play.
5. The snapshot is pinned to one commit and will drift.
6. Unused in the app: nothing is rendered, and no ranking reads it.

## Future Build Candidate layer

The consumer this exists for. It will need to decide what to do with
`undecided` and with `unavailable` — and that decision is deliberately not made
here, because it is a policy choice, not a derivation. The model hands over
evidence; the next layer owns the judgement.

## Reproducing

```bash
node --experimental-strip-types scripts/build-phase-research.mjs benchmarks
npx vitest run src/scoring/buildPhasePrior.test.ts
```

Offline. No token, no network.

No best-effort fuzzy join (§14).
