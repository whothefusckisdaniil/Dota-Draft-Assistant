# Position model (ТЗ №9)

The app used to decide whether a hero could be recommended on a lane from
OpenDota's generic `roles` array — `Carry`, `Support`, `Disabler`, `Nuker` …
Those are **ability tags, not positions**. They produced real mistakes:
Wraith King carries a "Support" tag (it *can* be forced), Meepo carries
"Disabler"/"Nuker"/"Escape", so a strong counter pick could drag either onto
position 4/5 and the recommendation would look plausible.

This document records where the real position data comes from, how the
thresholds were derived, and what changed.

## 1. Why OpenDota roles are not enough

`roles` answers "what can this hero do", not "where is this hero played". The
two only correlate loosely, and they correlate worst exactly where it hurts:

- a tag set is **binary per hero** — Meepo is either "a Disabler" or not, with no
  notion of "9% of Meepo games are offlane";
- the tag list is hand-maintained upstream and applied to the hero in the
  abstract, so a situational pick (Wraith King support, Pudge mid) looks
  identical to a genuine one;
- the old gate was a score threshold (`minPositionScore = 4.5`) over a heuristic
  built from those tags plus a hand-curated `EXTRA_AFFINITY` table. It was tuned
  by hand, and it was demonstrably not tight enough.

## 2. Where the position data comes from

Discovered by **schema introspection**, not assumed (`npx tsx
scripts/stratz/probe-positions.mjs schema` re-runs it):

```graphql
heroStats {
  stats(
    heroIds: [1, 2, 3, ...]        # a LIST — this is what makes batching possible
    week: 1704067200               # epoch seconds
    bracketBasicIds: [HERALD_GUARDIAN, ...]
    groupByPosition: true
  ) { heroId position matchCount }
}
```

- return type: `[HeroPositionTimeDetailType]`, a flat row of
  `{ heroId, position, matchCount, … }`
- `position` is the enum `MatchPlayerPositionType`:
  `POSITION_1, POSITION_2, POSITION_3, POSITION_4, POSITION_5, UNKNOWN, FILTERED, ALL`
- `UNKNOWN` and `FILTERED` rows are **dropped**, never coerced into a lane.

### Position-id semantics (§2) — verified, not assumed

`POSITION_N → lane N`. Confirmed against heroes whose real roles are not in
dispute, over the production window:

| Hero | POSITION_1 | _2 | _3 | _4 | _5 |
| --- | --- | --- | --- | --- | --- |
| Lion | 0.5% | 11.7% | 0.7% | 32.3% | **54.8%** |
| Rubick | 1.0% | 2.5% | 2.2% | **74.6%** | 19.7% |
| Tusk | 0.3% | 10.0% | 1.6% | **51.1%** | 36.8% |
| Meepo | 13.9% | **79.5%** | 4.5% | 1.0% | 1.1% |

The ids mean what they say. Had they been reversed or offset, these four heroes
would have come out nonsensical.

## 3. Window, brackets, same-snapshot guarantee

Identical to the matchup layer, in the same run:

| | |
| --- | --- |
| Source | STRATZ |
| Window | sum of the 4 last **fully completed** weekly buckets (current partial excluded) |
| Buckets (this run) | 2956, 2957, 2958, 2959 (excluded 2960) |
| Population | rank brackets `HERALD_GUARDIAN`, `CRUSADER_ARCHON`, `LEGEND_ANCIENT`, `DIVINE_IMMORTAL` |
| Batching | **4 GraphQL requests** total — one per bucket, all 127 heroes in each |

`positions.json` is published in the **same atomic directory swap** as
`heroes.json`, `matchups.json` and `meta.json`. A swap can never leave positions
from a different week beside matchups from this one, and both
`validatePositionData` and `verifyStagedDataset` refuse a roster/snapshot
mismatch.

## 4. Position share distribution (127 heroes, 4 weeks, 4 brackets)

Reproduce with `npx tsx scripts/stratz/probe-positions.mjs`.

| pos | min | p50 | p75 | p90 | p95 | max | median games |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0.1% | 1.3% | 27.1% | 86.0% | 91.9% | 96.8% | 5 901 |
| 2 | 0.4% | 9.4% | 28.2% | 70.3% | 86.3% | 96.1% | 31 368 |
| 3 | 0.2% | 7.4% | 32.5% | 85.7% | 91.8% | 94.8% | 19 777 |
| 4 | 0.2% | 10.3% | 32.0% | 42.1% | 50.4% | 74.4% | 26 297 |
| 5 | 0.3% | 5.0% | 35.1% | 60.9% | 68.7% | 73.4% | 15 816 |

**The distribution is bimodal.** A dense cluster of off-role picks sits at 0–2%
(73 / 24 / 41 / 33 / 49 heroes for pos1…pos5); above it the curve is a long
sparse tail of genuine positions. The p50→p75 jump on pos1 (1.3% → 27.1%) is the
valley.

## 5. Thresholds and why

```js
POSITION_ELIGIBILITY = { minShare: 0.08, minGames: 500 };
```

A hero is eligible on a lane only if `share >= 8%` **and** `games >= 500`.
One rule for every hero; there is no per-hero exception anywhere.

The threshold was **not** chosen by eye. It is the midpoint of the interval that
the data and the required behaviour jointly allow:

| bound | value | hero | why it binds |
| --- | --- | --- | --- |
| must **drop** (upper edge of off-role) | 4.9% | Kunkka on pos4 | a core with a stray support game count |
| must **keep** (lower edge of real flex) | 10.5% | Tusk on pos3 | a genuine secondary lane for a support |

Every threshold in (4.9%, 10.5%] satisfies both. 8% was picked as the middle of
that interval so it sits ~3.1pp away from **either** edge: choosing an endpoint
would leave no margin, and a hero whose real share drifts by a point between
weekly refreshes would silently lose a lane.

Coverage at 8% — heroes clearing the bar per lane:

| share ≥ | pos1 | pos2 | pos3 | pos4 | pos5 |
| --- | --- | --- | --- | --- | --- |
| 5% | 47 | 76 | 68 | 72 | 63 |
| **8%** | **42** | **67** | **57** | **67** | **59** |
| 12% | 38 | 58 | 49 | 61 | 53 |
| 20% | 33 | 44 | 42 | 54 | 43 |

Every lane keeps far more than `topN = 15`, so the gate removes off-role noise
without emptying any lane.

**The 500-game floor is a guard, not the active constraint.** The least-picked
hero still has 18 837 games over the window, and 8% of that is ~1 500 — above
the floor. It exists for a future much thinner snapshot, where a single stray
position should not be trusted (fail-closed, §13).

## 6. Architecture

```
real position data (STRATZ)
        ↓  HARD GATE   isEligibleAt()  — share + games, before any scoring
heuristic positionScore()  (OpenDota roles + curated affinity)
        ↓  secondary   positionBonus, worth at most wPosition × positionBonusRange
                         = 0.2 × 4 = 0.8 points of the final score
finalScore
```

The empirical gate runs in `scoreCandidates` **before** `positionBonus` and
`finalScore` are computed, so counter advantage cannot pull an off-role hero into
the results at all.

## 7. Before / after

Same draft (Anti-Mage, Juggernaut, Puck, Vengeful Spirit, Lion), real snapshot.
"Removed" = heroes that pass the matchup coverage + sample checks and were
role-eligible under the old heuristic, but are not actually played on that lane.

| lane | top picks after the gate | off-role heroes removed |
| --- | --- | --- |
| pos1 | Meepo, Phantom Assassin, Phantom Lancer, Spectre, Sven | 83 (incl. Bane, Crystal Maiden, Earthshaker, Mirana, Pudge) |
| pos2 | Meepo, Visage, Arc Warden, Bloodseeker, Riki | 58 (incl. Bane, Crystal Maiden, Morphling) |
| pos3 | Visage, Wraith King, Night Stalker, Legion Commander, Sven | 66 (incl. Bane, Drow Ranger, Shadow Fiend) |
| pos4 | Visage, Shadow Shaman, Bounty Hunter, Omniknight, Mirana | 57 (incl. Axe, Bloodseeker, Phantom Lancer) |
| pos5 | Visage, Shadow Shaman, Omniknight, Mirana, Witch Doctor | 65 (incl. Axe, Bloodseeker, Morphling) |

Per-hero, as the gate now sees them:

| hero | eligible lanes | shares pos1…5 |
| --- | --- | --- |
| Wraith King | 1, 3 | 27.1% 2.0% 68.7% **1.6%** **0.6%** |
| Meepo | 1, 2 | 14.0% 79.0% 4.7% **1.1%** **1.1%** |
| Bane | 4, 5 | 0.2% 4.3% 0.5% 34.1% 60.9% |
| Tusk | 3, 4, 5 | 0.6% 6.1% 10.5% 40.6% 42.2% |
| Rubick | 2, 4, 5 | 0.3% 16.7% 1.3% 50.4% 31.3% |
| Kunkka | 2, 3 | 1.8% 32.5% 58.6% **4.9%** 2.2% |
| Puck | 2 | 0.4% 95.7% 0.9% 1.9% 1.1% |

Two of these are worth calling out because they are *not* what a hand-written
rule would produce:

- **Rubick keeps pos2** (16.7%, 233k games). Disabling is not a support-only
  act and the data says so; a curated list would probably have said no.
- **Pudge keeps pos2** (12.6%, 228k games). The regression test originally
  expected him to be mid-blocked — the real data disagreed, so the test was
  corrected, not the threshold.

## 8. What survived, what became the gate

**Survived, now secondary:** `LANE_AFFINITY`, `EXTRA_AFFINITY`,
`positionScoreBase()`. They still produce `positionScore`, which now only nudges
ranking by at most 0.8 points. They can no longer remove a candidate.

**Became the hard gate:** `src/scoring/positionEligibility.ts`, fed by
`public/data/positions.json`.

**Removed:** `APP_CONFIG.scoring.minPositionScore`. The old `4.5` role-score gate
is gone — it was the thing being replaced, and keeping it would have meant two
disagreeing hard gates. The scoring weights (`wCounter`, `wPosition`,
`shrinkageK`, `topN`, the confidence curve) are untouched.

## 9. What was explicitly not done

- No hero-specific blacklist. `positionEligibility.ts` contains no hero names
  and no `if (hero.name === …)`.
- No UI change. No badges, no percentages, no new filters — the gate is
  invisible to the user beyond the picks being correct now.
- No change to matchup data, the 4-week window, or the score formula.

## 10. Tests

| suite | what it pins |
| --- | --- |
| `src/scoring/positionEligibility.test.ts` | the rule on **synthetic** fixtures: Meepo/Wraith King blocked on 4/5, Bane kept, flex 45/35/20, rare off-pick rejected, both thresholds required, fail-closed on missing data, thresholds match the shipped `meta.json` |
| `src/scoring/position-model.test.ts` | the **real** snapshot: §8 edge cases resolve correctly, Wraith King / Meepo never appear on pos4/5 across 6 drafts, every ranked candidate is empirically eligible on its lane, and real supports are still reachable on 4/5 |
| `scripts/stratz/positions.mjs` | `validatePositionData` — roster match, positions 1..5 present, `games >= 0`, `0 <= share <= 1`, games sum == totalGames, shares sum to 1 within `1e-9`, buckets and brackets identical to the matchup layer |

The two suites are deliberately separated: the synthetic one must not depend on
this week's pick rates (or the thresholds would be "tuned" to the examples), and
the real one must not depend on fixtures (or it would not catch a bad refresh).
