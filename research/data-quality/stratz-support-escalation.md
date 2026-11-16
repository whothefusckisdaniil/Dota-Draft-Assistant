# heroStats.matchUp: matchCount differs between A→B and B→A for the same week and brackets

Status: **DRAFTED** — draft for review, not sent.

Hello STRATZ team,

We use the public GraphQL API (`heroStats.matchUp`) to build hero-vs-hero statistics. For the same week and the same `bracketBasicIds`, the `matchCount` returned for hero A against hero B differs from the `matchCount` returned for hero B against hero A. We would like to understand whether this is expected and how the aggregate is defined.

## Observation

Window: buckets 2963, 2964, 2965, 2966 (`week = bucket × 604800`, 2026-10-15T00:00:00.000Z – 2026-11-12T00:00:00.000Z, end exclusive).

Brackets: `HERALD_GUARDIAN`, `CRUSADER_ARCHON`, `LEGEND_ANCIENT`, `DIVINE_IMMORTAL`.

| Hero pair | A→B matchCount | B→A matchCount | Delta |
|---|---:|---:|---:|
| Enchantress (58) / Broodmother (61) | 1318 | 1361 | -43 |
| Broodmother (61) / Shadow Demon (79) | 1182 | 1137 | +45 |

Per week (A→B / B→A):

| Hero pair | week 2963 | week 2964 | week 2965 | week 2966 |
|---|---:|---:|---:|---:|
| Enchantress / Broodmother | 301 / 318 | 282 / 290 | 362 / 375 | 373 / 378 |
| Broodmother / Shadow Demon | 263 / 243 | 249 / 242 | 311 / 301 | 359 / 351 |

Per bracket, week 2963, Enchantress / Broodmother (A→B / B→A):

- `HERALD_GUARDIAN`: 95 / 96
- `CRUSADER_ARCHON`: 100 / 105
- `LEGEND_ANCIENT`: 73 / 82
- `DIVINE_IMMORTAL`: 33 / 35
- all four brackets: 301 / 318

Here A→B is the `vs` row with `heroId1 = A, heroId2 = B` under the dryad `heroId = A`, and B→A is the row with `heroId1 = B, heroId2 = A` under `heroId = B`.

## Query (sanitized)

```graphql
{ heroStats {
    w2963: matchUp(heroIds: [58, 61], week: 1792022400, bracketBasicIds: [HERALD_GUARDIAN, CRUSADER_ARCHON, LEGEND_ANCIENT, DIVINE_IMMORTAL], take: 200) { heroId vs { heroId1 heroId2 matchCount winCount } }
    w2964: matchUp(heroIds: [58, 61], week: 1792627200, bracketBasicIds: [HERALD_GUARDIAN, CRUSADER_ARCHON, LEGEND_ANCIENT, DIVINE_IMMORTAL], take: 200) { heroId vs { heroId1 heroId2 matchCount winCount } }
    w2965: matchUp(heroIds: [58, 61], week: 1793232000, bracketBasicIds: [HERALD_GUARDIAN, CRUSADER_ARCHON, LEGEND_ANCIENT, DIVINE_IMMORTAL], take: 200) { heroId vs { heroId1 heroId2 matchCount winCount } }
    w2966: matchUp(heroIds: [58, 61], week: 1793836800, bracketBasicIds: [HERALD_GUARDIAN, CRUSADER_ARCHON, LEGEND_ANCIENT, DIVINE_IMMORTAL], take: 200) { heroId vs { heroId1 heroId2 matchCount winCount } }
  } }
```

Request SHA-256: `8a3b375761088e1966d865c07439f95110765f924bdf6e27f508d6c8101334ec`, normalized response SHA-256: `3f60ff7b8db1e670c65b5c4db6d499a38d76af5b17c1a17b0cd36242e581beff` (retrieved 2026-11-12T12:33:28.440Z).

## What we have already ruled out

- Batched (32 heroes per request), single-hero and pair-only requests return identical rows. (FIX11 controls: pairOnlyVsSingleMismatches=0, singleHeroVsMatchedBatchMismatches=0.)
- Independent repeated requests return identical rows. (FIX10 repeatability: status PASS, 1512 matching rows, 0 mismatches.)
- Swapping the order of heroIds in the request does not change any row. (FIX11: 30/30 pairs PASS, 0 mismatching rows.)
- Querying each production bracket separately and summing reproduces the multi-bracket totals exactly (matchCount and winCount, both directions). (FIX13: PROVEN_ON_SAMPLE, 32/32 pair-weeks.)
- Reverse-direction differences appear in individual weekly buckets, not only in the multi-week sum. (FIX13: 0/32 pair-weeks have equal reverse counts.)
- For the studied pairs the values were identical across all archived retrievals on 2026-11-12. (FIX14 cross-check: 32/32 pair-weeks identical across 6 archives. Note: FIX11 also recorded 56 row differences for other heroes between a 07:52 UTC batch and 11:12 UTC re-queries, so values can change between retrievals.)
- The public GraphQL schema exposes no way to list the match IDs behind a matchUp row. (FIX14 schema introspection (513 types): status MATCH_LEVEL_EVIDENCE_UNAVAILABLE.)

## Questions

1. Is matchCount for heroId1=A/heroId2=B expected to equal matchCount for heroId1=B/heroId2=A (same week, same bracketBasicIds)? Is this part of the API contract?
2. What exactly does the top-level `heroId` in heroStats.matchUp represent, and how are heroId1 and heroId2 assigned in the `vs` rows?
3. What counts as one game in matchCount (lobby types, game modes, abandons, matches without full stats)?
4. Can a single match be counted for A vs B but not for B vs A? If so, under which conditions?
5. Is bracketBasicIds applied per player (to the hero's own player) or per match (e.g. average rank)? Is it applied identically to both heroes of the pair?
6. Can different ranks of the two players in one match lead to different directional counts?
7. Is `week` a fixed Unix bucket (week = floor(t / 604800) × 604800) or a calendar week, and which match timestamp (start or end) is used?
8. How are matches with unknown or uncalibrated rank handled for bracketBasicIds filtering?
9. Is there an official way to obtain the match IDs that make up a specific matchUp row?
10. Are there known limitations, sampling, delays or reprocessing in the hero-stats aggregation pipeline (e.g. counts based on a subset of matches)?
11. Could you share an official example query and the expected (symmetric or asymmetric) result for one of the pairs below?

Example queries and the expected results for one of the pairs above would be very helpful.

Thank you!
