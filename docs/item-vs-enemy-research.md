# Item × Enemy effectiveness research (ТЗ №11)

**Verdict: PARTIAL.**

The *data model* exists and is proven: a match-level
`Hero + Position + Enemy + Item + Result + Purchase time` tuple is
reconstructible today, in one request, from two independent sources. What does
**not** exist is the *volume* to build a production Item × Enemy layer — not at
the right population, and not for the full hero × position × enemy grid.

- **LEVEL 1** (Hero + Position → items) — already covered by ТЗ №10 (STRATZ
  aggregates). No work needed.
- **LEVEL 2** (Hero + Position + Enemy → items) — reconstructible, but only from
  a **pro-match** corpus of 252 149 matches total, against a requirement of
  ~4–16 million hero-match observations for the full grid. Usable as a
  research/demo sample; not production-grade, and not combinable with the
  existing Herald/Guardian matchup data.
- **LEVEL 3** (full draft) — not attempted; sparsity compounds.

Nothing in production was modified.

---

## 1. Problem definition

The existing data answers *"who counters this draft?"* (`matchups.json`) and
*"who actually plays this lane?"* (`positions.json`). A build engine needs a
third axis that is **per match**, not per aggregate:

```
heroId, position, enemyHeroId, itemId, matches, wins, purchaseEvents, timing
```

`Hero → Item` alone (ТЗ №10) is already available and is not the question. The
question is whether an item's value can be conditioned on *who is on the other
side of the draft*.

## 2. Why Hero→Item and Hero→Enemy must never be JOINed

This is the most important warning in this document, so it is stated first and
concretely.

Both of these are real, available aggregates:

- STRATZ `heroStats.itemFullPurchase` → *Sniper buys Maelstrom in 19% of games*
- STRATZ `heroStats.matchUp` → *Sniper beats Phantom Assassin 62% of games*

Joining them on `heroId` to produce "Maelstrom is good against Phantom Assassin"
is **mathematically meaningless**. The two aggregates are computed over
*different sets of matches* with *no shared key*. The result is the product of
two independent marginals — it will look plausible and will always be wrong.

The same trap applies to any positional join, any `itemId`-keyed co-occurrence
table built by cross-tabbing two independent exports, and any "item winrate vs
enemy" that is really `itemRate(hero) × winrate(hero, enemy)`.

The only legitimate construction is at the **match level**: item, enemy and
result must come from the *same row of the same match*. Everything below is
about whether that row exists, and whether there are enough of them.

## 3. STRATZ capabilities

Introspection of `MatchType` / `MatchPlayerType` (verified, not assumed):

| entity | provides |
| --- | --- |
| `match(id: Long)` | `id`, `didRadiantWin`, `durationSeconds`, `startDateTime`, `averageRank`, `gameMode`, `lobbyType` |
| `match.players[]` | `heroId`, **`position`**, `isRadiant`, **`isVictory`**, `item0Id…item5Id`, `backpack0Id…2Id`, `neutral0Id` |

A live query:

```
match(8847785956): 10 players | radiantWin=true | dur=1435s | gameMode=CAPTAINS_MODE
  player[0]: heroId=11 position=POSITION_1 victory=true
    items=[263,172,63,249,596,149] backpack0=244 neutral0=187
  players carrying a position value: 10/10
```

So **within a known match id**, STRATZ gives the complete tuple, in the same
Herald→Immortal population as the rest of the pipeline. It is the better source
on every axis except one: discovery.

`PlayerMatchesRequestType` (reachable as `player(id) { matches(request: …) }`)
exposes an impressive filter set — `heroIds`, **`withEnemyHeroIds`**,
`positionIds`, `rankIds`, `bracketIds`, `isVictory`, `gameVersionIds`,
`gameModeIds`, `take`, `skip` — which at first glance is exactly the query the
problem needs. It is not, and the reason is decisive:

> `matches(request:)` is nested under `player()`, so the filters **constrain that
> player's own match history**. Measured on a probe account: filtering by a hero
> in his recent lineup returned 100 matches; filtering by a hero in the same
> match but not his own returned 0; a *global* query for
> `heroIds: [35], withEnemyHeroIds: [47], positionIds: [POSITION_1]` returned
> **0 matches** — not because such matches do not exist, but because the probe
> player played none of them.

To enumerate every (hero, position, enemy) cell globally one would have to
enumerate every player on the platform. Not feasible.

Also measured: `take` is hard-capped at 100, and `bracketIds` takes a different
enum (`Int`) from the `RankBracketBasicEnum` used by the `heroStats` queries.

## 4. OpenDota capabilities

`GET /api/matches/{id}` returns, in one payload:

- `players[].hero_id`, `player_slot`, `lane_role` (position), `isRadiant`
- `item_0…item_5`, `backpack_0…2`, `item_neutral`, `item_neutral2`
- **`purchase_log`** — `[{ time, key }]`, e.g. `{time: -54, key: "boots"}`
  (negative = pre-horn), plus `purchase_time` and `first_purchase_time` maps
- `item_win` — per-item win flag
- `aghanims_shard`, `aghanims_scepter`, `moonshard`, `neutral_item_history`
- `radiant_win` → result, `duration`, `patch`, `rank_tier`, `computed_mmr`

This is a strictly richer match record than STRATZ's, and it comes with a
**global SQL surface**.

### The SQL join that reconstructs the whole tuple

```sql
SELECT pm.match_id, pm.player_slot, pm.hero_id, pm.lane_role, pm.purchase_log,
       pm.item_0, pm.item_1, pm.item_2, pm.item_3, pm.item_4, pm.item_5,
       pm.backpack_0, pm.item_neutral, pm.neutral_item_history,
       m.radiant_win, m.duration, m.game_mode, m.start_time,
       e.hero_id AS enemy_hero_id
FROM player_matches pm
JOIN matches m   ON m.match_id = pm.match_id
JOIN player_matches e ON e.match_id = pm.match_id AND e.player_slot <> pm.player_slot
WHERE pm.hero_id = :hero
  AND pm.lane_role = :position
  AND e.hero_id = :enemy
```

Verified live. `player_matches` carries `match_id, account_id, player_slot,
hero_id, item_0…5, lane, lane_role, is_roaming, purchase_log, backpack_0…3,
item_neutral, neutral_item_history` — everything needed.

**But the corpus is pro matches.** Measured game_mode distribution in the
explorer: `{2: 31211, 1: 513, 22: 22}` — Captains Mode dominates completely and
every `leagueid` is non-zero. Total inventory: **252 149 matches**, of which
31 746 are from the last ~15 months.

That is a fundamentally different population from the production
Herald/Guardian rank-bracket data. An item recommendation derived from pro
Sniper would not describe the Sniper our users actually queue with.

`/matches/recent` and `/constants/matches` are both **404**; `/parsedMatches`
works but returns only ids and ignores every query parameter (verified:
`?hero_id=35` and `?featured=1` both returned the same 100 unfiltered ids).

## 5. Other sources

| Source | Match-level? | Items? | Time? | Position? | Result? | Population | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OpenDota `/matches/{id}` | yes | yes | yes | `lane_role` | yes | any; discovery pro-only | **richest record, wrong corpus** |
| OpenDota explorer SQL | yes (join) | `item_0..5` | `purchase_log` | `lane_role` | yes | **pro only** | **only global discovery surface** |
| STRATZ `match(id:)` | yes | yes | no | yes | yes | Herald→Immortal | **right population, no discovery** |
| STRATZ `matches(request:)` | — | — | — | — | — | right | player-scoped, not global |
| STRATZ `heroStats.*` | aggregate | yes | minute buckets | yes | yes | right | ТЗ №10 → LEVEL 1 |
| Dotabuff | — | — | — | — | — | — | no public API, no documented export, **HTTP 403**, ToS |

Dotabuff is reference-only and unreachable; no scraping was attempted beyond a
single reachability check, as the ТЗ requires.

## 6. Match-level feasibility — the honest summary

| requirement | STRATZ | OpenDota |
| --- | --- | --- |
| Hero + Position + Item + Result + Enemy in one request | ✅ | ✅ |
| Purchase timing | ❌ | ✅ (`purchase_log`) |
| Population matches production (Herald→Immortal) | ✅ | ❌ (pro) |
| **Global discovery of the right cells** | ❌ | ✅ but wrong population |
| Volume for the full grid | unknown (undiscoverable) | ❌ (see §7) |

**The two sources are complementary and neither is sufficient.** STRATZ has the
right population but cannot enumerate; OpenDota can enumerate but in the wrong
population. That is the central finding of this research.

## 7. Sample experiment

Three cases over the OpenDota SQL surface, 200-match cap each.

**Sniper pos1 vs Phantom Assassin** — 200 matches found, 30 at `lane_role = 1`:

- top items: Power Treads 28/30, Wraith Band 21/30, Mjollnir 19/30,
  Hurricane Pike 14/30, Mask of Madness 13/30, Dragon Lance 12/30
- `purchase_log` present in **30/30** matches
- timing 0–10 / 10–20 / 20–30 / 30–40 / 40+ min: **275 / 276 / 180 / 30 / 0**
- any purchase after 30:00: **8/30**
- duration 1248–2407 s, median 1712 s
- game_mode `{1: 2, 2: 196, 22: 2}` — **98% pro**

**Sniper pos1 vs Axe** — 200 found, 43 at pos1, game_mode `{2: 100%}`:

- Power Treads 42/43, Wraith Band 41/43, Mjollnir 27/43, Mask of Madness 20/43
- timing 397 / 346 / 235 / 21 / 0; late purchases in 9/43

**Bane pos5 vs Puck** — 200 found, **0 at `lane_role = 5`**. Pro Bane is never
recorded at hard support in this corpus, so the position filter had to be
dropped to get any signal. (Unfiltered: Magic Wand 126/200, Aether Lens 105/200,
Glimmer Cape 96/200, and **147/200** matches with purchases after 30:00 — long
support games make the post-hoc confounder severe.)

**Conclusion: the tuple is proven reconstructible.** Hero, position, enemy, items,
result and purchase timing were all recovered from the same match rows, for
exactly the cases the ТЗ asked for. What follows is about *scale and
population*, not feasibility.

## 8. Data model

At match grain — never the aggregate grain of §2:

```json
{ "matchId": 8972905634, "heroId": 35, "position": 1,
  "enemyHeroId": 47, "items": [{ "itemId": 145, "boughtAtSec": 812 }],
  "won": true, "durationSec": 2217, "gameMode": 2, "patchId": 60 }
```

Aggregation must happen *after* the join, never before.

## 9. Confounders

Ranked by how badly each would distort an item recommendation:

1. **Post-hoc purchasing.** A buy at minute 38 often happens in a decided game.
   Measured: 8/30 and 9/43 of the Sniper samples, 147/200 for unfiltered Bane.
   Any "item X correlates with winning" statistic must exclude or flag purchases
   after the game is effectively decided; `duration` bounds this.
2. **Population / skill bracket.** The pro corpus and the Herald/Guardian
   production population are different games. This invalidates combining them.
3. **Game duration.** Supports run 50–80 min, carries 25–35. Item rates compared
   across roles without conditioning on duration favour long-game items
   (Glimmer, Lotus, Heart).
4. **Hero strength.** A strong hero wins more *and* gets more items. `matchups.json`
   deltas give a per-hero baseline, usable as a regression control on a
   match-level row — **never** as a join.
5. **Team composition.** Two items in one draft are perfectly correlated;
   single-item marginals cannot separate them.
6. **Player skill.** Unmeasured at this grain — `rank_tier` exists in
   `/matches/{id}` but **not** in `player_matches`.
7. **Item availability.** Cost, shop state and patch change what is buyable;
   `gameVersionIds` is the only patch filter measured.
8. **Ceiling effects.** In a won game the 6th slot is often bought after the
   outcome is settled, inflating that slot's winrate.

## 10. Timing

`purchase_log` gives `{time, key}` in **seconds**, with negative values for
pre-horn purchases (measured: −54 for starting boots). The 0–10 / 10–20 / 20–30 /
30–40 / 40+ buckets are directly computable and were measured in §7.

STRATZ's `match(id:)` exposes **no purchase times** — only the final inventory.
A timing-aware Item × Enemy layer is therefore OpenDota-only, hence pro-only.

## 11. API / rate limits and cost

- OpenDota explorer: free, unauthenticated, no documented hard limit; responses
  returned quickly. Read-only SQL, one request per cell.
- OpenDota `/matches/{id}`: ~40 KB per match, one request per match.
- STRATZ: Cloudflare-protected, browser transport, `take` capped at 100.

The SQL join collapses the naive 80 010 requests into one query per cell
returning all rows, so **API cost is not the binding constraint — volume is.**

## 12. Volume — the binding constraint

| measurement | value |
| --- | --- |
| explorer total matches (all time) | **252 149** |
| matches in the last ~15 months | 31 746 |
| total hero-match observations | ≈ 2.5 M |
| most-played hero | 63 098 matches |
| least-played hero | 1 523 matches |

Per-cell volume is extremely uneven:

| cell | matches |
| --- | --- |
| hero 35 vs 47 (Sniper vs PA) | 816 |
| hero 3 vs 13 (Bane vs Puck) | 3 038 |
| hero 1 vs 35 (AM vs Sniper) | 352 |
| hero 82 vs 1 (Meepo vs AM) | 197 |
| hero 126 vs 126 | **0** |
| hero 35 **pos1** vs 47 | 179 |
| hero 35 **pos1** vs 2 | 241 |
| hero 3 **pos5** vs 13 | **0** |

The full grid is 127 × 5 × 126 = **80 010 cells**:

| observations per cell | total required |
| --- | --- |
| 50 | 4.0 M |
| 200 | 16.0 M |
| 1000 | 80.0 M |

**The entire explorer's history is ~2.5 M hero-match observations.** Even the
most generous threshold (50/cell) needs ~1.6× more than exists — in the wrong
population — and a realistic 200/cell threshold needs **6.4× more than exists**.

Full LEVEL 2 coverage in the pro corpus is therefore **structurally
impossible**, not merely expensive. The 0 and 179 cells show this is a
distribution fact, not a budget one: Bane-pos5-vs-Puck does not occur in this
corpus at all, so no amount of scraping produces those observations.

## 13. Refresh feasibility and data freshness

- OpenDota explorer is continuously updated and `matches.start_time` is
  available, so a rolling 4-week window is expressible in SQL. Freshness does not
  fix the population problem.
- STRATZ uses weekly buckets, as production does.
- **Neither source exposes a Herald/Guardian match-level corpus.** That is the
  gap. The production matchup and position layers are rank-bracket aggregates;
  no measured source offers a match-level equivalent for that population.

## 14. LEVEL 1 / 2 / 3 feasibility

| level | needs | feasible? |
| --- | --- | --- |
| **LEVEL 1** Hero + Position → items | hero-level item aggregate | ✅ **already built** (ТЗ №10) |
| **LEVEL 2** Hero + Position + Enemy → items | match-level join, 80 010 cells | ⚠️ **research-only** — proven, but pro-only and short by ~6× |
| **LEVEL 3** full draft → build | 5-enemy conditioning | ❌ not attempted; sparsity compounds |

LEVEL 1 is the honest production answer today, and it is already in hand.

## 15. Recommended architecture

1. **Ship LEVEL 1** from ТЗ №10 as the only production item layer. Right
   population, right window, ~127 requests, already validated.
2. **Do not build LEVEL 2 on the pro corpus.** It would produce confident
   recommendations from a population our users do not play in — worse than no
   recommendation, because it looks authoritative.
3. **If Item × Enemy is required, it needs a new source** — specifically a
   rank-bracket match-level export. That is a procurement question, not a code
   question, and should be answered before any engineering effort.
4. **If a research prototype is wanted anyway**, label it pro-only, publish the
   sample size next to every rate, and never mix it with `matchups.json` in one
   formula.

## 16. Risks

- **The false join (§2) is the largest risk**, because it is easy to write, looks
  like data, and would ship plausible wrong answers. Block it with a review rule,
  not a comment.
- **Silent population drift**: a future source swap to pro-only data would break
  no test, because the schema is identical.
- **Sparse-cell noise**: at 179 observations a rate has a wide interval; without
  a minimum-sample gate, tail items will look like recommendations.
- **Patch sensitivity**: item stats change every patch; a dataset spanning
  several patches mixes regimes.
- **Post-hoc purchasing** (§9.1) is severe in long support games and would
  silently inflate late items.

## 17. Verdict

**PARTIAL.**

1. Hero + Position + Enemy + Item — **provable at match level**, demonstrated in
   §7. ✅
2. Source — OpenDota SQL join; STRATZ has the right population but no discovery. ✅
3. Granularity — one row per (match, hero, enemy, item). ✅
4. Result — `radiant_win` + `player_slot`, or `didRadiantWin` + `isVictory`. ✅
5. Purchase timing — `purchase_log`, seconds, pre-horn negatives. OpenDota only. ✅
6. Patch / window — `gameVersionIds` (STRATZ), `start_time` (OpenDota). ✅
7. Population control — **the failure point.** OpenDota's global surface is
   pro-only; STRATZ's population is right but undiscoverable. ❌
8. Data required — ~4–16 M hero-match observations for the full grid; ~2.5 M
   exist. ❌
9. API calls — not the constraint (one SQL query per cell). ✅
10. LEVEL 2 — research-only at present. ⚠️
11. LEVEL 3 — not feasible. ❌
12. Constraints — pro-only corpus, sparse cells, post-hoc purchasing confounder,
    no `rank_tier` in the SQL table.
13. Production architecture — **yes for LEVEL 1**, which already exists; **no**
    for LEVEL 2/3 without a new rank-bracket match-level source.

**Recommendation: proceed with LEVEL 1. Treat LEVEL 2 as blocked on data
acquisition, not on engineering.**

## 18. Reproducing this

```bash
node scripts/item-enemy-research.mjs stratz-schema   # §3  match-level + discovery test
node scripts/item-enemy-research.mjs opendota         # §4  match payload + SQL join + population
node scripts/item-enemy-research.mjs experiment      # §7  the three required cases
node scripts/item-enemy-research.mjs sample-size     # §12 volume, the decisive numbers
```

Read-only: queries STRATZ and OpenDota, caches under
`/tmp/stratz-research/cache`, never writes to `public/data`. The token is read
only from `process.env.STRATZ_API_TOKEN` (falling back to the git-ignored
`.env`), never logged, never cached.




