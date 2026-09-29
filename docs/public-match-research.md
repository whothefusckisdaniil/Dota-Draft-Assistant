# OpenDota `/publicMatches` — source-discovery research (ТЗ §22)

> This is a source-discovery experiment.
> No production data is generated.
> No item recommendation is produced.
> No enemy-conditioned score is calculated.

**Verdict: PARTIAL.**

Reproduce with `node scripts/public-match-research.mjs all` (cache in
`/tmp/opendota-public-research/`; no token is read or stored).

## 1. The endpoint exists and beats anything found in ТЗ §11

`GET /publicMatches` returns **100 rows** per call:

```
match_id, match_seq_num, start_time, duration, game_mode, lobby_type,
avg_rank_tier, num_rank_tier, radiant_win, cluster, radiant_team, dire_team
```

`less_than_match_id` paginates cleanly: 3 pages, **300 rows, 100 % unique, zero
page overlap**.

## 2. The rank filter genuinely works

A 200 alone proves nothing, so the returned `avg_rank_tier` distribution was
compared with the requested range:

| bucket | requested | tiers returned | within range |
| --- | --- | --- | --- |
| Herald/Guardian | 10–15 | 11,12,13,14,15 | **100/100** |
| Crusader/Archon | 20–25 | 21,22,23,24,25 | **100/100** |
| Legend/Ancient | 30–35 | 31,32,33,34,35 | **100/100** |
| Divine/Immortal | 40–45 | 41,42,43,44,45 | **100/100** |

**This is the finding that changes the picture from ТЗ §11**, where the only
global source was a pro-only explorer. Rank-tier filtering on public matches
works, and it spans the Herald-Immortal range the project targets.
The endpoint is a **rank-filtered public corpus** (randomly sampled public
matches, filtered by rank tier) — not a "ranked matches only" feed, and not a
pro corpus.

## 3. Population integrity — genuinely public, not a pro subset

60 hydrated matches:

| | |
| --- | --- |
| `leagueid > 0` (league/pro) | **0 / 60** |
| `game_mode` | 23 turbo 31, 1 all-pick 14, 22 ranked 8, 13: 7 |
| `lobby_type` | 0 public 31, 4 ranked 14, 7 balanced 8, 14: 7 |

Contrast with ТЗ §11: the explorer returned `game_mode 2` (Captains Mode) 31 211
and `leagueid > 0` everywhere. `/publicMatches` adds a corpus the explorer simply
does not have.

## 4. Freshness

All 300 sampled matches fall on the current day, `patch` is `60` across 20
hydrated matches. A rolling 4-week window is reachable by walking
`less_than_match_id` backwards, but this sample cannot **verify** a
patch-consistent window — that would need a deliberate multi-week crawl.

## 5. The blocker is COVERAGE, not population

60 hydrated matches / **600 player rows**:

| field | availability |
| --- | --- |
| `players`, `hero_id`, `player_slot` | 60/60 matches |
| `item_0`…`item_5`, `item_neutral` | present in 60/60 |
| `radiant_win`, `duration` | 60/60 |
| **`lane_role`** | **0/60 matches, 0/600 player rows** |
| **`purchase_log`** | **0/60 matches, 0 entries** |
| `backpack` | 0/60 |
| **`avg_rank_tier`** | **0/60** — discovery reported it for **60/60 of the same ids** |

Player rows with at least one item: **73.3 %**.

Three things are lost between discovery and hydration:

- **Position.** `lane_role` is empty everywhere, so `Hero + Position + …` cannot
  be assembled, and position cannot be inferred from `player_slot` without lane
  data.
- **Purchase timing.** Zero `purchase_log` entries, so §12's post-hoc control is
  not merely small — it is unmeasurable.
- **Rank.** The discovery layer knows the tier; the hydrated match does not. Rank

## 6. Volume at this scale

From 60 matches → 3 000 match-level rows (enemy taken strictly from the
opposite team via `player_slot < 128`):

| pair | observations |
| --- | --- |
| Sniper vs PA | 1 |
| Sniper vs Axe | 0 |
| Bane vs Puck | 0 |
| Anti-Mage vs Sniper | 0 |
| Kunkka vs Puck | 0 |
| Kunkka vs Sniper | 0 |
| Anti-Mage vs PA | 0 |
| Puck vs Anti-Mage | 0 |

Hero × Enemy: 2 005 cells, **median 1 observation**, p90 = 2, and 2 004 of 2 005
cells hold fewer than 10. Hero × Enemy × Item: 9 703 cells, also median 1.

The full grid the project would need is 127 × 5 × 126 = **80 010 cells**. §14
says not to assume a threshold, so none is asserted: the honest statement is
that the sample is far too small to populate a grid, and that position is
missing entirely regardless of scale.

## 7. Sampling stability is poor

Two equal 100-match samples at adjacent cursors, compared on `game_mode`:

```
mode 1   A= 16.0%  B=  4.0%  delta=12.0pp
mode 13  A=  8.0%  B=  1.0%  delta= 7.0pp
mode 22  A= 11.0%  B=  5.0%  delta= 6.0pp
mode 23  A= 65.0%  B= 90.0%  delta=25.0pp
```

**25 pp of drift between adjacent samples**, with turbo (mode 23) at 65–90 %.
The endpoint is documented as randomly sampled, and at 100 rows per page that
randomness swamps any single-page statistic. Any future use must average over
many pages and report that averaging.

## 8. Verdict

| dimension | result |
| --- | --- |
| population | **OK** — public/ranked, 0/60 league, rank filter exact |
| discovery | **OK** — 100/page, no duplicates, backward cursor works |
| items | **OK** — 73.3 % of player rows |
| position | **FAIL** — 0/3000 rows |
| purchase timing | **FAIL** — 0 entries |
| volume | **FAIL** — median 1 observation per cell |
| stability | **FAIL** — 25 pp drift |

**PARTIAL.** The population question that ТЗ §11 left open is now answered
*yes*, and this endpoint is a strictly better discovery layer than anything
previously found. But the Level-2 tuple needs a position, and position is 0 %
here. The blocker has moved from **population** to **coverage**, and
`Hero + Position + Enemy + Item` cannot be assembled from this source as it
stands.

## 9. What would change the verdict

1. **Position.** Either OpenDota starts populating `lane_role` for these
   matches, or a different rank-scoped source is needed. Without it, no amount
   of volume helps.
2. **Volume.** Hero × Enemy at median 1 observation per 60 matches implies
   multi-million-match crawls to approach a meaningful grid — which §13's
   extrapolation cannot justify at this stability.
3. **Stability.** Any production use must average over many pages, because
   single pages are not self-consistent.

## 10. Note on method

Network was used deliberately: the question is what a remote source can
deliver, so it has to be asked. Nothing is written outside the cache directory
and no token is involved.

The aggregation helpers here (`matchRows`, percentiles, cell counting) are
plain and local to the script. Per ТЗ §22 this is an exception to the "typed
helpers with tests" rule, made because the script is one-off: **the numbers in
this document are therefore not unit-tested**, and the exit-code check plus the
printed distributions are the only guard.

  must be carried across from the listing, not re-read.
