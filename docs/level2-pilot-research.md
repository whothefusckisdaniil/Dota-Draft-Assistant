# Controlled Level-2 pilot (ТЗ №28) — support is far too sparse

> **Status: pilot executed.** 400 rank-filtered public matches, 100 per broad
> bucket, declared before the crawl and not revised after. Production scoring,
> datasets, UI and workflows are untouched.

## 1. Question

ТЗ №27 proved the bridge works: an OpenDota-discovered `match_id` hydrates from
STRATZ with an exact roster, agreeing result and final inventory. What was
unknown is whether the resulting `Hero × Position × Enemy` layer carries enough
support to build anything on.

**The answer is no, at this scale — and that is the pilot's finding.**

## 2. Methodological correction (§28.1)

`/publicMatches` does **not** expose `leagueid`. Verified over **21 100
discovery rows** (211 pages): the key is absent from every row, and the field
list is `match_id, match_seq_num, radiant_win, start_time, duration,
lobby_type, game_mode, avg_rank_tier, num_rank_tier, cluster, radiant_team,
dire_team`. This mirrors OpenDota's schema — `public_matches` carries discovery
fields, the full `matches` table carries `leagueid`.

So the selection policy is:

```text
/publicMatches      -> league status UNKNOWN
  -> /matches/{id}   -> leagueid === 0 ?
       YES -> candidate occupies one of the 100 slots
       NO  -> rejected, slot NOT consumed
```

The earlier `m.leagueid !== 0` filter rejected **100%** of rows, because
`undefined !== 0`. It had never been executed against live discovery data —
the №27 pilot predated it and the 27.1 check only re-rendered a cache.

## 3. Selection funnel

```text
discovery_scanned            : 1300
rank_in_bucket               : 1300
league_unknown_at_discovery  : 1300   (source property, not an error)
opendota_hydrated            : 400
league_confirmed_public      : 400
league_rejected              : 0
hydrate_failed               : 0
selected                     : 400    (exactly 100 per bucket)
bucket already full          : 900
rows examined per bucket     : ca 557, la 489, hg 149, di 105
```

The fixed quota was met exactly, in every bucket, with zero league rejects.

## 4. Bridge

```text
STRATZ hydration : 310/400 (77.5%)   STRATZ_HTTP_ERROR 89, NOT_FOUND 1
exact roster     : 310/310           id mismatches 0
result agreement : 3100 rows, 0 mismatches
inventory        : 3091 rows, all exact multisets
enemy reconstruct: 0 failures
POSITION_FULL    : 239      POSITION_PARTIAL 0      POSITION_NONE 71
```

`POSITION_PARTIAL` is 0 across 310 matches: STRATZ has either all ten
positions or none. Matches without positions are valid matches with invalid
positional enrichment, not bridge failures.

## 5. The headline — support density

`Hero × Position × Enemy`, 8969 cells from 11 950 observations:

| support | cells | observations |
| --- | ---: | ---: |
| 1 | 6995 | 6995 |
| 2–4 | 1885 | 4434 |
| 5–9 | 88 | 511 |
| **10–24** | **1** | 10 |
| 25–49 | 0 | 0 |
| 50+ | 0 | 0 |

```text
support >= 10 : 1 cell of 8969   (0.011%)
support >= 25 : 0
support >= 50 : 0
```

`Hero × Position × Enemy × Item`: 60 029 cells, **54 582 at support 1**, and
**zero** cells above 10.

`Hero × Position`: 450 cells — 293 at 0–4, 88 at 5–9, 56 at 10–24, 13 at 25–49,
0 at 50+. This is the layer that carries support; the enemy dimension
destroys it.

## 6. Why more matches alone will not fix this

The cell space is roughly `126 heroes × 5 positions × 125 heroes ≈ 78 750`
possible `Hero × Position × Enemy` cells. At 400 matches we have observed 8969
of them — about **11% coverage**, averaging 1.3 observations each.

Both the observation count and the cell count grow linearly with matches until
the space saturates, so **mean support per cell stays near 1 while the corpus
is sparse**. Reaching support 10 on most cells requires filling the space,
which is orders of magnitude beyond 400 matches. The useful conclusion is not
"run a bigger pilot" but "reconcile the grain with the ontology first".

## 7. Sample A/B

```text
HxP cells   : A=341  B=366  shared=257  jaccard 0.571
HxPxE cells : A=5002 B=5114 shared=1147 jaccard 0.128
```

A jaccard of 0.128 on the enemy dimension means two disjoint halves of the
discovery produce almost the same HxPxE cells — most of them singletons that
never recur. This is the same sparsity seen from a different angle.

## 8. Optional timing

`OpenDota has_parsed` : 50/400 (12.5%). Recorded as an independent coverage
measurement and **not** used for match acceptance. No temporal cutoff from
ТЗ §26 is applied here; bridge feasibility and temporal eligibility stay
separate experiments.

## 9. What is deliberately not computed

No winrate, no lift, no score, no ranking, no recommendation. `wins` and
`losses` are raw counts, and a unit test asserts those keys are absent from
every aggregate. Final inventory was observed **after** the game and may
reflect post-outcome decision making: these tuples are observed
associations, not recommended reactions to an enemy.

## 10. Verdict

The mechanical rule produced `LEVEL2_PROMISING` because exactly one cell
cleared the support-10 bar. **That verdict is wrong**, and it is worth naming
why: a rule of "at least one cell above the floor" reads a single cell out of
8969 as a stable flow. §30 defines PROMISING as a stable stream across
hundreds of matches; one cell is not that. This is the same
absence/assertion error the project has now had to undo in three different
places (ТЗ §21.1, №26.4, and here).

The support the data actually supports:

```text
LEVEL2_PARTIAL — the bridge is sound, the enemy dimension is what is sparse.
```

Recommended reading, not a decision taken here: the grain that carries
support is `Hero × Position` (450 cells, 69 above support 10). Any enemy-conditioned
layer has to be reconciled with that ontology before it is scaled.
