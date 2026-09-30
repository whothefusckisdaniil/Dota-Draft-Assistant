# Temporal eligibility research (ТЗ №26) — PREPARED, corpus not executed

> **Status: PREPARED.** The harness is built, reviewed and unit-tested. The
> corpus crawl has **not** been run, so this document contains **no results**.
> Every section below states a method or a pre-registered constant, never a
> finding.

## 1. Question

How much does the observable `Hero + Item` signal change when the purchase
window is truncated, and is that signal stable enough to justify a temporal
eligibility rule in later enemy-conditioned analysis?

The cutoffs are **fractions of match duration**, never absolute minutes:

```text
0.25  0.33  0.40  0.50  0.60  0.70  0.80  1.00
```

## 2. Scope boundary

This study is **GET-only**. There is no POST endpoint in
`scripts/public-temporal-research.mjs`, no parser job is created, and no
production scoring, UI, dataset or workflow is touched.

Deliberately absent, and forbidden by §25: enemy conditioning, positions,
winrate, lift, `core`, `situational`, `mustBuy`, `recommended`, and any
`Hero + Position + Enemy + Item` dataset. Position is out of scope on purpose.

## 3. Source

Two GET endpoints only:

- `/publicMatches` — discovery, pages walked with `less_than_match_id`
- `/matches/{id}` — hydration

Filters: `leagueid === 0` and `od_data.has_parsed === true`.

> `has_parsed` lives under **`od_data`** on `/matches/{id}`. There is no
> top-level field with that name. Reading `detail.has_parsed` yields `undefined`
> for every match and silently rejects the entire corpus.

Rank comes from the **discovery row** (`avg_rank_tier`), never inferred, mapped
through `scripts/opendota/rank-buckets.mjs` — the ranges are not duplicated
here.

## 4. Grain — `(heroId, matchId, itemId)`

Every quantity in the report is computed at this grain.

Ten players in one match each buying Battle Fury is **ten** observations of the
Hero × Item signal, not one. An earlier draft keyed presence by `(matchId,
itemId)` alone, which silently turned "Hero × Item" into "item across all
heroes" while still labelling it Hero × Item.

`aggregateItemPresence()` requires both identifiers and throws a named
`TypeError` if either is missing. A silent fallback would recreate the bug.

## 5. Two independent views

`purchase_log` is event-based, so the same data is summarised twice:

| View | Definition |
| --- | --- |
| **presence** | an item bought **at least once** in a (hero, match) — `purchasedOnce = 1` |
| **events** | the number of `purchase_log` records for that item |

An item bought twice in one match is one presence and two events. The two can
disagree about stability, which is exactly what §13 asks.

Ranking ties are broken by `itemId` ascending. Without a total order the top-k
list inherits Map insertion order — i.e. whichever match the crawl saw first —
and the sample A/B comparison would be measuring that artefact.

Every ranking in the study goes through one helper, `rankedRows(rows, key)`
(`key` descending, then `itemId` ascending). No call site sorts items by key on
its own. This matters most here precisely because the corpus is expected to be
small: at ~20 matches per bucket there are long runs of identical rates, so a
key-only sort would report "movement" that is pure crawl order.

## 6. Timing normalisation

```text
relativeTime = time / duration
```

- **Pre-horn timestamps are data, not errors.** `time < 0` (starting items,
  e.g. `-59s`) falls inside every positive cutoff and is kept.
- `time > duration` and non-numeric times are excluded from the signal and
  **counted separately**, never dropped silently.
- Without a duration there is no scale, and the event is classified
  `no_duration` rather than assumed to be at time zero.

A timing summary describes **only the events that are inside the window**. At
cutoff `c` the median is computed over `pre_horn` and `in_window` events only;
`after_cutoff`, `after_duration`, `invalid_type` and `no_duration` never reach
it. Otherwise the report would call an event invalid for the signal and then
use that same event to describe the signal's timing.

For the same reason the retention denominators come from the **full window
(cutoff = 1.0) restricted to valid in-match observations**, not from raw event
keys. Counting raw keys put an item into the denominator when its only event was
`time > duration`, so `presenceRetained` at the 100% window could read *below*
100% — the report appearing to lose data it had itself declared invalid.
Excluded events are reported as `events excluded` and `excl` columns.

### One definition of "valid"

`isValidPurchaseTime(t, duration)` is derived from `classifyPurchaseTiming`, so
every statistic in the study draws its population from the same rule:

| `time` | Verdict |
| --- | --- |
| `< 0` | **valid** — pre-horn is real data |
| `0 <= time <= duration` | **valid** (both endpoints included) |
| `> duration` | invalid |
| non-numeric | invalid |
| no usable duration | invalid |

An event describing an item with **no key** is also excluded: it produces no
row, so it must not enter `inWindow` or move the timing median either.

This matters because the helpers had quietly drifted apart — at one point
`aggregateItemPresence`, `specialItems` and `lateFraction` each had their own
slightly different idea of validity, so `lateFraction` was reporting a
past-the-end purchase as "observed late" at every cutoff while the aggregate had
already discarded it as invalid. A regression test now asserts that all four
views agree on one event set.

## 7. Pre-registered constants

Chosen before any data was seen, and **not** revised afterwards:

```text
TARGET_PARSED_PER_BUCKET   = 300
MAX_DISCOVERY_PER_BUCKET   = 800      (§3 crawl ceiling)
SUPPORT_FLOORS             = 10, 25, 50, 100   (hero-matches)
MIN_SAMPLE_FOR_CONCLUSION  = 30       (MATCHES, not player rows)
```

`MIN_SAMPLE_FOR_CONCLUSION` counts **matches**. Ten players per match inflate a
30-match slice to ~300 rows, so a row-based gate would certify conclusions from
8 matches while printing a confident-looking table.

If a bucket cannot reach 300 parsed matches, the report prints
`available: N  target: 300` and marks it a **limitation**. The ceiling is

## 8. Known availability constraint

Measured before the crawl was designed (GET probes only):

| Probe | Result |
| --- | --- |
| `/publicMatches` page size | 100 rows; per page ~12 Herald, 46 Crusader, 33 Legend, 6–8 Divine |
| Parse rate on hydration | **1 of 62 ≈ 1.6%**, and no better at page depth 40 / 120 / 300 |
| `/parsedMatches` ∩ `/publicMatches` | 26 of 3000 rows (0.9%) — a *worse* hit rate than blind hydration |
| Those 26 matches | `od_data.has_parsed = true`, 10/10 players with `purchase_log` |

Consequences, recorded before running:

- At the pre-registered ceiling, 800 discovery rows per bucket yields roughly
  **~25 parsed matches per bucket**, not 300.
- Divine/Immortal is the sparsest bucket in `/publicMatches`, so a per-bucket
  ceiling is least informative exactly where rank matters most.
- `/parsedMatches` is rejected as a source: it is a 100-id rolling window,
  almost entirely **Turbo**, and Turbo durations range from ~390s to ~1550s.
  Mixing Turbo with All Pick would confound a `% of duration` scale.

The crawl is expected to end in `TEMPORAL_INCONCLUSIVE`. That is a legitimate,
correct outcome — see §10.

## 9. Output

The report prints, in order:

```text
=== Corpus ===               === Presence signal ===       === Support sensitivity ===
=== Rank buckets ===         === Event signal ===          === Benchmark heroes ===
=== Game modes ===           === Stability vs 100% ===     === Sampling stability ===
=== Patch/time coverage ===  === Rank stability ===        === Special items ===
=== Purchase timing distribution ===                       === Conclusion ===
=== Post-hoc fractions ===
=== Pre-horn ===
=== Mode stability ===
```

Every figure is printed with its `n`. Patch coverage is reported explicitly, and
if the corpus spans several patches with no dominant patch above 70%, that is
flagged as a limitation rather than blended silently.

`/publicMatches` is randomly sampled, so pages alternate into **sample A** and
**sample B** within each bucket. Both are compared on hero/mode/item
distribution TVD and on the 50%-vs-100% conclusion, to check that stability is
not an artefact of one particular sample.

Aghanim's Shard, Aghanim's Scepter, Aghanim's Blessing and Moon Shard are
profiled **separately** (§17) with median / p25 / p75 relative time, and are
never folded into the ordinary item ranking — a consumable bought at 0.7
duration is not a core item.

## 10. Verdicts

Four outcomes, and **absence is a verdict of its own**:

```text
TEMPORAL_STABLE        stable across several rank/mode/sample splits
TEMPORAL_PARTIAL       stable only in large samples or specific strata
TEMPORAL_UNSTABLE      the cutoff strongly changes item ranking at sufficient support
TEMPORAL_INCONCLUSIVE  not enough data to decide
```

`TEMPORAL_INCONCLUSIVE` exists because defaulting to `TEMPORAL_UNSTABLE` when no
split reached the minimum would repeat the ТЗ §21.1 error: turning "we did not
measure it" into "we measured instability".

## 11. What this cannot claim

A purchase observed after a cutoff **does not imply** that the cutoff caused
the purchase, nor that the game outcome was already known. The study reports
only *what is observed by time X*. It does not choose a cutoff, and it does not
by itself justify a temporal eligibility rule for future enemy-conditioned
analysis — that remains a separate decision.

## 12. Running it

```bash
node scripts/public-temporal-research.mjs plan          # no network
node scripts/public-temporal-research.mjs all           # GET crawl
node scripts/public-temporal-research.mjs all --cached  # re-report from cache
```

The cache lives in `/tmp/opendota-temporal-research` and is **never**
committed. Requests are paced at ~1.3 s: OpenDota's public tier allows roughly
60/min, and exceeding it returns HTTP 429 with a small JSON error body that
`res.ok` discards — which produced a false 0% parse rate during development.

`all` re-execs itself once with `--experimental-strip-types` so that
`spearmanRho` can be imported from `src/scoring/stats.ts`. Spearman is
**delegated, never reimplemented** — the maths lives in
`scripts/public-temporal-lib.mjs`, which is unit-tested (79 tests).

The report path is also exercised offline, without any network call, by writing
a synthetic corpus into the cache directory and re-reporting it with
`all --cached`. That smoke path includes deliberately invalid timestamps
(past match end and non-numeric), so the median, retention-denominator and
special-item rules are all checked before a long crawl spends API budget.

**not** raised after seeing availability — that would be post-hoc redesign.
