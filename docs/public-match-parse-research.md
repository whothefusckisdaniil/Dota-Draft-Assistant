# OpenDota parser enrichment of public matches (ТЗ §23)

> Source-discovery experiment. No production data is generated, no item
> recommendation is produced, no enemy-conditioned score is calculated.

**Verdict: PARSER_WORKS** — the parser *can* supply the missing fields, and the
ТЗ §22 blocker turns out to have been an artefact of sampling unparsed matches.

Reproduce: `node scripts/public-match-parse-research.mjs probe` (GET only) or
`all` (probe + the sections below). `enqueue` is the only POST and is **never**
triggered by `all`.

## 1. The decisive result

On public match `9021475694` — `leagueid = 0`, `game_mode = 23`, already parsed
by OpenDota on its own — compared against five unparsed matches from the same
discovery window:

| field | before (unparsed) | after (parsed) |
| --- | --- | --- |
| `lane_role` | 0/50 | **10/10** |
| `purchase_log` | 0/50 | **10/10** |
| `position_est` | 0/50 | **10/10** |
| `item_0` | 0/50 | 8/10 |
| `item_neutral` | 0/50 | 5/10 |
| `backpack` | 0/50 | 0/10 |

`od_data: {"has_api":true,"has_gcdata":true,"has_parsed":true,"has_archive":false}`

**Hypothesis B is confirmed and hypothesis A refuted.** The ТЗ §22 conclusion
("position 0/3000") was true of the sample and false of the source: those
matches simply had not been parsed.

## 2. How the sample behaves (§3–§5)

Eight matches, 2 per calibrated bucket, public-first and newest-first. All came
back `not_parsed` — and that verdict is **definitive, not inferred**: it comes
from `od_data.has_parsed === false`.

A deliberate detail (ТЗ §23.1 §3–§4): absence from `/parsedMatches` is reported
as `unknown`, not `not_parsed`. That endpoint exposes only a recent page, so a
miss is not evidence of absence. `classifyParseStatus({ inParsedIndex,
indexExhaustive, odData })` encodes this, and a unit test pins it.

## 2a. The baseline is code-guaranteed, not luck (ТЗ §23.1 §3–§5)

An earlier version took the first five rows of the discovery page and labelled
them `before(unparsed)` without checking. It happened to be correct that day, but
correctness by luck is not correctness. The baseline is now built only from
matches where `od_data.has_parsed === false` is explicitly observed, and a
match with missing `od_data` or missing `has_parsed` is never admitted.

`isDefinitiveUnparsed()` requires `=== false` — not falsy, not absent. A test
covers `has_parsed: 0` and `has_parsed: ''` so neither can sneak in.

If fewer than 5 definitive matches exist, the run prints
`baseline: unavailable — only N definitive unparsed match(es)` instead of a
`0/N` whose denominator nobody chose.

## 2b. `enqueue` is a real, explicit mechanism (ТЗ §23.1 §1–§2)

`enqueue` is implemented, not a stub. It selects at most **4** matches — one per
calibrated bucket — and only matches that are simultaneously:

- `od_data.has_parsed === false` (demonstrably unparsed),
- `leagueid === 0` (public),
- inside a requested rank bucket.

It prints `match_id`, bucket, HTTP status, job id and job status, and writes the
summary to the cache. Error payloads are surfaced, not swallowed.

**It has not been run.** Verification is structural: `method: 'POST'` appears
exactly once in the file, inside `enqueueParse()`; that function is called only
from `runEnqueue()`; and `runEnqueue()` is called only under
`cmd === 'enqueue'`. Neither `probe` nor `all` can reach it.

The remaining unknown is therefore the **parse success rate** — whether a
request completes, fails on a missing replay, or silently never finishes. That
is the one measurement worth paying 10 API calls per request for, and it belongs
in a deliberate experiment rather than a research script.


## 3. Position (§10)

Raw `lane_role` distribution on the parsed match: `{1: 1, 2: 7, 3: 2}` — three
distinct values, **not** normalised to 1..5. `position_est` is present for
10/10.

`lane_role` is the field the existing position model can consume, but this is a
single Turbo match. Its **values** still need validation across modes and eras
before anyone treats them as positions.

## 4. Purchase log (§15)

180 entries across 10 players, 6–42 per player. Timestamps: min **−59**,
median 220, max 777, match duration 780 s.

Two findings a timing model must handle:

**Negative timestamps are real, not corrupt — 40/180 of them.**
```
faerie_fire@-59, branches@-59, magic_wand@-59, tango@-47, branches@-46
```
The clock starts at 0 on the horn, so pre-horn starting items are legitimately
negative. A histogram fed these unchecked would shift every median.

**Post-hoc purchases are large: 58/180 (32.2 %)** land after half the match
duration. This is the ТЗ §11 confound, now measured in a public/ranked
population rather than only in a pro corpus.

**`purchase_log.key` is a string, not an item id** — `ward_sentry`, `bottle`,
`boots`. All **85/85** distinct keys resolve mechanically via
`item_<key> == dname`. No fuzzy matching needed, but a mapping step is required
before the log can join to the existing dataset.

## 5. Rank continuity (§12)

`avg_rank_tier` is present in the **discovery row** and absent from the parsed
match. The correct model:

```
publicMatches  ->  avg_rank_tier  ->  external listing metadata
matches/{id}   ->  parsed gameplay data
```

A future crawl must carry rank across; it must never be reconstructed from
parsed players.

## 6. Replay availability (§19)

`has_gcdata true`, `has_parsed true`, `has_archive false`, `has_api true`.

Discovery → replay → queue → completion → enrichment are separate stages, and
this run deliberately does **not** collapse them into one success flag.

## 7. What is NOT claimed (§17)

The claim is exactly:

> the parser **can** enrich rank-filtered public matches.

It is **not** "the source is production viable". Still open:

- parse success rate versus failure on a missing replay (the ТЗ §22 replay
  concern is untested here because no POST was made);
- whether `lane_role` values are reliable across game modes and eras;
- **volume.** §22 measured a median of **1 observation per hero × enemy cell
  per 60 matches**, and parsing does not change that arithmetic. Enrichment
  makes each match usable; it does not make 60 matches sufficient.

## 8. What the next stage must decide

1. Enqueue a controlled sample and measure the **parse success rate** — the one
   number this run deliberately avoided producing, because it costs 10 API calls
   per request and has an external side effect.
2. Validate `lane_role` values across `game_mode` before adopting them as
   positions; Turbo dominated ТЗ §22's sample.
3. Handle pre-horn negative timestamps explicitly in any timing model.
4. Map `purchase_log.key` → item id before joining to the existing dataset.
