# heroStats.matchUp: matchCount differs between A→B and B→A for the same week and brackets

Hello STRATZ team,

## 1. Short description

We use the public GraphQL API (`heroStats.matchUp`) to build hero-vs-hero statistics. For the same weeks and the same `bracketBasicIds`, the `matchCount` returned for hero A against hero B differs from the `matchCount` returned for hero B against hero A. The difference is reproducible and stable across repeated requests. We would like to understand whether this is expected and how the aggregate is defined.

## 2. Exact reproducible examples

A→B is the `vs` row with `heroId1 = A, heroId2 = B` inside the entry with top-level `heroId = A`; B→A is the row with `heroId1 = B, heroId2 = A` inside the entry with `heroId = B`. Counts are summed over the four weekly buckets below; all values are integers exactly as returned.

### Totals over four weeks

| Hero pair | A→B matchCount | B→A matchCount | Delta (A→B − B→A) |
|---|---:|---:|---:|
| Enchantress (58) / Broodmother (61) | 1318 | 1361 | −43 |
| Broodmother (61) / Shadow Demon (79) | 1182 | 1137 | +45 |

### Per week (A→B / B→A)

| Hero pair | week 2963 | week 2964 | week 2965 | week 2966 |
|---|---:|---:|---:|---:|
| Enchantress (58) / Broodmother (61) | 301 / 318 | 282 / 290 | 362 / 375 | 373 / 378 |
| Broodmother (61) / Shadow Demon (79) | 263 / 243 | 249 / 242 | 311 / 301 | 359 / 351 |

### Per bracket, week 2963: Enchantress (58) / Broodmother (61) (A→B / B→A)

- `HERALD_GUARDIAN`: 95 / 96
- `CRUSADER_ARCHON`: 100 / 105
- `LEGEND_ANCIENT`: 73 / 82
- `DIVINE_IMMORTAL`: 33 / 35
- all four brackets in one request: 301 / 318

### Per bracket, week 2963: Broodmother (61) / Shadow Demon (79) (A→B / B→A)

- `HERALD_GUARDIAN`: 47 / 41
- `CRUSADER_ARCHON`: 95 / 83
- `LEGEND_ANCIENT`: 80 / 84
- `DIVINE_IMMORTAL`: 41 / 35
- all four brackets in one request: 263 / 243

## 3. Production query configuration

- Endpoint: `https://api.stratz.com/graphql`
- `bracketBasicIds`: `HERALD_GUARDIAN`, `CRUSADER_ARCHON`, `LEGEND_ANCIENT`, `DIVINE_IMMORTAL`
- `week`: bucket × 604800 (Unix seconds); buckets 2963, 2964, 2965, 2966
- Window: 2026-10-15 to 2026-11-12 UTC (end exclusive), weeks 2963 = 2026-10-15, 2964 = 2026-10-22, 2965 = 2026-10-29, 2966 = 2026-11-05
- `take: 200`; production requests the fields `heroId`, `vs { heroId1 heroId2 matchCount winCount }`

Exact request for the first pair as sent in our diagnostic run (no credentials; sent with a standard API token). It is the production query with three additional fields (`winRateHeroId1`, `winRateHeroId2`, `winsAverage`); `matchCount` and `winCount` were identical with and without these fields:

```graphql
{ heroStats {
    w2963: matchUp(heroIds: [58, 61], week: 1792022400, bracketBasicIds: [HERALD_GUARDIAN, CRUSADER_ARCHON, LEGEND_ANCIENT, DIVINE_IMMORTAL], take: 200) { heroId vs { heroId1 heroId2 matchCount winCount winRateHeroId1 winRateHeroId2 winsAverage } }
    w2964: matchUp(heroIds: [58, 61], week: 1792627200, bracketBasicIds: [HERALD_GUARDIAN, CRUSADER_ARCHON, LEGEND_ANCIENT, DIVINE_IMMORTAL], take: 200) { heroId vs { heroId1 heroId2 matchCount winCount winRateHeroId1 winRateHeroId2 winsAverage } }
    w2965: matchUp(heroIds: [58, 61], week: 1793232000, bracketBasicIds: [HERALD_GUARDIAN, CRUSADER_ARCHON, LEGEND_ANCIENT, DIVINE_IMMORTAL], take: 200) { heroId vs { heroId1 heroId2 matchCount winCount winRateHeroId1 winRateHeroId2 winsAverage } }
    w2966: matchUp(heroIds: [58, 61], week: 1793836800, bracketBasicIds: [HERALD_GUARDIAN, CRUSADER_ARCHON, LEGEND_ANCIENT, DIVINE_IMMORTAL], take: 200) { heroId vs { heroId1 heroId2 matchCount winCount winRateHeroId1 winRateHeroId2 winsAverage } }
  } }
```

SHA-256 of the query text above: `8a3b375761088e1966d865c07439f95110765f924bdf6e27f508d6c8101334ec`; normalized response SHA-256: `3f60ff7b8db1e670c65b5c4db6d499a38d76af5b17c1a17b0cd36242e581beff` (retrieved 2026-11-12T12:33:28.440Z).

## 4. What has already been verified

1. Bracket partition: querying each of the four production bracket groups separately and summing reproduces the multi-bracket `matchCount` and `winCount` exactly, in both directions, in 32/32 pair-weeks.
2. `winsAverage` equals `winCount / matchCount` (within the returned rounding) in 446/446 checked rows. This is our empirical observation, not a documented contract.
3. Reproducibility: batched (32 heroes per request), single-hero and pair-only requests return identical rows, and 2 independent repeated passes matched in all 1512 rows.
4. Hero order: swapping the order of `heroIds` in the request does not change any row (30/30 pairs).
5. The reverse counts differ within individual weeks, not only in the four-week sum (0/32 pair-weeks have equal reverse counts).
6. Stability: for the studied pairs the values were identical across 32/32 pair-weeks in all archived retrievals on 2026-11-12. Rows for some other heroes did change between retrievals that day, so values can change over time.

### Independent OpenDota reference

For context only, we counted matches for the same pairs and weeks in OpenDota's `public_matches` table (ranked matchmaking, match-average rank Herald–Immortal, the two heroes on opposing teams). Example: Enchantress (58) / Broodmother (61), week 2963: STRATZ 301 (A→B) / 318 (B→A), OpenDota reference 907 matches.

In our independent OpenDota reference sample, STRATZ directional match counts ranged from approximately 0.33 to 0.55 of the corresponding external pair-match counts. This is not a coverage estimate because the two sources do not expose equivalent match eligibility, rank, and completeness filters.

Limitations of this reference: OpenDota does not document the completeness of `public_matches`; its rank is a match average rather than per player; lobby type and game mode eligibility may differ; and its match IDs cannot be linked to individual `matchUp` rows. We use it only to motivate the question about eligibility criteria.

## 5. API limitations discovered during introspection

- Schema introspection (513 types) found no field that returns the match IDs behind a `matchUp` row.
- 17 fields return match lists: 11 require a specific player, team, league, guild or match ID, and the remaining 6 lack a hero-pair, time or bracket filter.
- The schema description of `winsAverage` is empty, and the descriptions of `heroId1`, `heroId2` and `matchCount` do not state whether reverse counts are expected to be equal.

Because of this we cannot reconcile the two directions at match level on our side.

## 6. Questions

1. Is `matchCount` for A→B expected to equal `matchCount` for B→A (same week, same `bracketBasicIds`)? Is this part of the API contract?
2. What exactly does the top-level `heroId` of a `heroStats.matchUp` entry represent?
3. How are `heroId1` and `heroId2` assigned in the `vs` rows?
4. Why can the reverse-direction `matchCount` values differ?
5. How is `bracketBasicIds` applied to the two players of one match (per player, per match, or otherwise)?
6. Which match eligibility rules are used for `matchCount`?
7. How are lobby types and game modes filtered?
8. How are matches with an unknown rank excluded or counted?
9. What are the exact semantics of `week` (bucket definition and which match timestamp is used)?
10. Why are match-level IDs not available from `matchUp`?
11. Is there an official way to obtain the underlying match IDs for a specific `matchUp` row?

If possible, please share:

- official documentation of the `matchUp` fields (`heroId`, `heroId1`, `heroId2`, `matchCount`, `winCount`, `winsAverage`);
- an example query;
- the expected result for that query;
- an explanation of the directional count semantics;
- any known limitations of the aggregation pipeline (sampling, delays, reprocessing).

## 7. Supporting evidence

We can provide the following compact attachments (no credentials; large raw archives available on request):

- A1. Sanitized GraphQL query (SHA-256 `aaff8ae3018db44d18d541fa2fcbf2633e15cf2eab3ae7c4db6f8fb1bffba584`)
- A2. Pair-level summary (SHA-256 `809a09c3cd02cc01eff768cec7c373d044245522578a78fc54f580db9ae60608`)
- A3. Bracket partition summary (SHA-256 `8d2804ed7312df8a0c621693cd94f936fdb064e3397b95859e01d16c92f96dc1`)
- A4. Repeatability summary (SHA-256 `dcfc9ab2eee96d263a40d2f4777accf4c3bc68d8977adf684b513a4eaaa23484`)
- A5. Match-level API capability limitation (SHA-256 `6fa7e344fa54f65df2c94118b1e0fb8379e1bc5ba18d0f84b14ddc338a41a407`)
- A6. OpenDota comparison caveat (SHA-256 `905b307f1b6d44dc083a91bc8d1ead778a22d78559c2406f7a7397f114e7ab2d`)

Thank you for your help.
