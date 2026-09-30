# Parse success rate + item/timing enrichment (ТЗ §25)

> **This experiment estimates parser/enrichment behavior on a small controlled
> sample. It does not establish production-scale throughput.**

**Result: `has_parsed` 12/16 (75.0 %), 95 % Wilson CI [50.5 %, 89.8 %].**

Reproduce: `plan` (GET) → `enqueue` (POST) → `poll` (GET) → `report` (GET).

## 0. What this experiment actually sampled (ТЗ §25.2 §3)

**The executed 16-match experiment covered four brackets: Herald, Guardian,
Crusader and Archon. It did NOT sample Legend/Ancient or Divine/Immortal.**

The plan used the ranges 10–15 / 20–25 / 30–35 / 40–45, each labelled as a
*pair* of brackets. On the OpenDota scale each of those ranges is a **single**
bracket:

| tier | bracket | labelled as |
| --- | --- | --- |
| 12, 14 | **Herald** | "Herald/Guardian" |
| 21, 22, 23 | **Guardian** | "Crusader/Archon" |
| 32, 35 | **Crusader** | "Legend/Ancient" |
| 43, 45 | **Archon** | "Divine/Immortal" |

So the 75 % figure is an observation on a **Herald–Archon** sample. It must not
be quoted as behaviour across four calibrated buckets spanning Herald→Immortal.

The raw experiment is left exactly as executed; only its interpretation is
corrected. A single canonical source now lives in
`scripts/opendota/rank-buckets.mjs` (13 tests), and all four public research
scripts import it. New plans are written to `plan-v2.json` with
`schemaVersion: 2` and `rankBucketVersion: "broad-v1"`; the executed plan is
kept verbatim as `plan-v1-legacy.json`, and `readPlan()` selects between them by
**evidence** (which plan's matches actually have `post_*.json` files) so the two
experiments cannot be silently mixed.

A fresh v2 plan does reach the missing strata — Legend 51–54 and Divine 73–75 —
which the old ranges could not. It has not been executed.

## 1. Three instrumentation bugs found and fixed (ТЗ §25.1)

The first run reported `0/16 usable`. None of that was a parser failure.

**1. The job id is nested.** A successful `POST /request/{id}` answers
`{ "job": { "jobId": 556030584 } }`. The harness read `body.jobId`, found
nothing, and printed `200 / - / unknown` for all 16 — **which were 16
successful requests.**

**2. The cache made polling a no-op.** `get()` is keyed by URL, so polling
`/request/{jobId}` returned the same first response, and the post-parse
`/matches/{id}` was already cached as the *planning baseline*.
`getFresh()` always hits the network; `detail_before_*` is immutable.

**3. An unobservable job state vetoed an observable parse.** With the job id
extracted, `/request/{jobId}` returned **`null` (HTTP 200) for all 16 jobs** —
the job layer is not observable for these matches. The classifier returned
early on any non-`completed` job state, so 12 fully parsed matches were reported
as `0/16 usable`. `od_data.has_parsed` is now authoritative; `jobState` is
reported alongside but never gates the verdict.

This is the fourth instance in this project of the same mistake class — an
absence of observation read as an assertion.

## 2. Funnel (§10)

| stage | result |
| --- | --- |
| requested | 16 |
| POST accepted (payload carries a job) | **16/16 (100 %)** |
| job completed | **unobservable**, see §1.3 |
| `has_parsed = true` | **12/16 (75.0 %)** |
| 10 players | 12/16 |
| `purchase_log` present | 12/16 |
| item keys resolvable | 12/16 |
| valid timing | 12/16 |

Mode composition, recorded post-hoc and **not** rebalanced: Turbo 9, All Pick 5,
Ranked All Draft 2.

## 3. Purchase-log enrichment

- **2 055 purchase events** across 12 matches, ~171 per match
- **2 055/2 055 keys resolve** via `item_<key> == dname`
- **2 055/2 055 timings valid**
- **412 pre-horn** (negative) timestamps — valid, kept
- **0** after-duration, **0** invalid type

## 4. Post-hoc purchases (§15, ТЗ §25.2 §7)

| window | count | share |
| --- | --- | --- |
| after half the match duration | 802 | **39.0 %** |
| in the final 2 minutes | 310 | **15.1 %** |

The measurement is `purchase_time > duration / 2` — the halfway point of the
match. It does **not** establish the moment the game was decided, so
"post-outcome contamination" is recorded as a *limitation to resolve*, not as a
measured fact.

## 5. Non-parsed matches (ТЗ §25.2 §6)

The four matches with `has_parsed=false` all carry `has_api=true` and
`has_gcdata=true`. **The exact reason for non-parsing is unresolved by this
experiment.** Those are independent OpenDota metadata flags; they are not
evidence that a `.dem` replay was retrievable, and no `replay_url` was captured.
A later claim about replay availability would need that field recorded.

## 6. What this does and does not license

It licenses: a rank-filtered public corpus **can** be asked to parse, and 75 % of
requests in a **Herald–Archon** sample yielded match-level `purchase_log` with
100 % key resolution and 100 % usable timing.

It does not license: any statement about high-rank behaviour, nor a build of
`Hero + Position + Enemy + Item` (ТЗ §22). The sample is 12 matches, drawn from
the lower half of the rank range only, and ТЗ §24 established that positions
cannot come from OpenDota at all.

The next step is a GET-only temporal-eligibility study on a larger parsed
corpus, cut by the four **correct** broad buckets and by game mode, to measure
how stable an item signal is across purchase-time cutoffs — before any enemy
conditioning is attempted.

## 7. Test count

467 tests (was 453) after adding the rank-bucket suite; typecheck and build
clean; `report` reproduces the figures above from the cached POST results.



## 1. Experiment design

16 matches, 4 per calibrated rank bucket. A candidate must satisfy **all** of:

- comes from `/publicMatches`,
- `leagueid === 0` (public, never league/pro),
- `avg_rank_tier` inside the requested bucket,
- `detail.od_data.has_parsed === false` — the strict form, never inferred from
  absence in the (recent-page-only) `/parsedMatches` index.

`game_mode` is **not** filtered. `/publicMatches` is randomly sampled public
matches, so pre-filtering by mode would mix parse success with mode coverage.

## 2. Sample (frozen, 400 discovery rows scanned)

| bucket | n | tiers |
| --- | --- | --- |
| Herald/Guardian | 4 | 14, 12, 12, 14 |
| Crusader/Archon | 4 | 22, 21, 21, 23 |
| Legend/Ancient | 4 | 32, 35, 35, 35 |
| Divine/Immortal | 4 | 43, 43, 43, 45 |

Mode composition, recorded post-hoc: **Turbo 9, All Pick 5, Ranked All Draft 2**.
That skew is a property of the random sample and is reported, not corrected
(§19).

Baseline for all 16: 10 players, **0 players with a `purchase_log`**, and
`has_parsed === false` — so every downstream change is attributable to the parse.

## 3. What the experiment measures (§10)

A funnel, never a single percentage:

```
requested -> POST accepted -> job completed -> has_parsed
          -> 10 players -> purchase_log -> item keys -> valid timing
```

Completion and *usable enrichment* are reported as two separate numbers with
95 % Wilson intervals (§21): a parser can complete at 14/16 while only 11/16
yield usable item/timing data, and the second number is the one that matters
for the roadmap.

## 4. Status distinctions that are kept apart (§8, §18)

`POST_FAILED`, `QUEUED`, `PENDING`, `COMPLETED`, `FAILED`, `TIMEOUT`, `UNKNOWN`
are separate. In particular a bounded poll that runs out is `TIMEOUT`, not a
parser failure — collapsing them would invent a parser defect out of a local
timeout.

## 5. Timing semantics (§13)

Negative timestamps are **valid**: the OpenDota clock starts at 0 on the horn, so
pre-horn starting items (`faerie_fire@-59`, `tango@-47`) are ordinary data.
`classifyPurchaseEvent` folds them into `valid` while counting them separately as
`preHorn`, so the raw counts are preserved and nothing is dropped. Only
`time > duration` is `after_duration`.

`classifyPurchaseEvent` is deliberately separate from `validPurchaseTimestamp`,
which keeps `negative` as its own bucket for the ТЗ §23 report. A test asserts
the two never disagree about what is out of range.

## 6. Item key resolution (§12)

Exact only: `purchase_log.key` → `item_<key>` → `dname`. No fuzzy matching.
Resolved and unresolved counts are reported separately, with the unresolved
keys listed.

## 7. Side-effect guard (§25)

`method: 'POST'` appears exactly once, inside `sendPost()`. That function is
called only from `runEnqueue()`, and `runEnqueue()` only under
`cmd === 'enqueue'`. Neither `plan`, `poll`, `report` nor `all` can reach it.

One POST per match: a match already present in the cache is skipped, and a
failed POST is **not** retried.

## 8. Verification performed

- `node --check` clean on the script and the new rank-bucket module
- `plan` → `exit=0`, stderr empty, both the legacy and the v2 plan render with
  their schema version and their actual strata
- `report` → `exit=0`, stderr empty, reproduces 12/16 from the cached POST results
- **467 tests** (was 453), typecheck and build clean

## 9. What is deliberately absent

No `Hero + Position + Enemy + Item` dataset is built here (§22), even if all 16
matches parse. This experiment answers exactly one question: can match-level item
and timing data be obtained regularly from a rank-filtered public corpus?

Positions are not part of that question. ТЗ §24 established that
`position_est` is a structural round-robin and `lane_role` is a lane, so
positions would still come from the STRATZ layer.

## 10. Next step

Not another POST round on the same design. The next experiment is GET-only
temporal eligibility on a larger already-parsed corpus, cut by the four
**correct** broad buckets and by game mode, to measure how stable an item signal
is across purchase-time cutoffs — before any enemy conditioning is attempted.
