# Position validation on parsed public matches (ТЗ §24)

> Research only. No production data, no position adapter, no change to the
> existing STRATZ position model.

**Verdict: POSITION_PARTIAL** — and the reason is sharper than that label
suggests: one of the two fields carries no information at all.

Reproduce: `node scripts/public-position-research.mjs all` (read-only; rank is
taken only from the discovery row).

## 1. Corpus

99 parsed PUBLIC matches (`leagueid === 0`), 990 player rows, 3 game modes, all
structurally sane (10 players, 5 per side). Candidates came from
`/parsedMatches`, then hydrated and filtered — the discovery pages and the parsed
index overlap only thinly, so sourcing candidates from discovery yielded **1**
match out of 200 scanned.

## 2. The decisive finding: `position_est` is a round-robin

| field | value counts (990 rows) |
| --- | --- |
| `lane_role` | `{1: 394, 2: 207, 3: 387, 4: 2}` |
| `position_est` | `{1: 198, 2: 198, 3: 198, 4: 198, 5: 198}` |

`position_est` is **exactly 198 in each of the five buckets** — 990 / 5 — and
**99 of 99 matches give each team exactly one player per value**. That is a
structural split, not an estimate of who played where.

Consequently the headline **field agreement of 56.7 %** is agreement with a
round-robin. It is reported because it was asked for, but it must not be read as
a quality figure: a field that is uniform by construction agrees with any other
field roughly by chance. This is also why `position_est` is *not* treated here as
a second opinion on `lane_role`, despite being present on 990/990 rows.

## 3. `lane_role` is real — but it is a LANE

`lane_role` shows a genuine, skewed distribution with almost no outliers. But:

- it never takes the value **5** (only 2 rows carry a 4);
- its three heavy values are consistent with safe / mid / offlane lanes;
- per team it splits roughly 40 / 21 / 39, i.e. two safes, one mid, two off.

So `lane_role` is a **lane**, not a position. The project's model
(`1 Carry, 2 Mid, 3 Offlane, 4 Soft Support, 5 Hard Support`) has **no direct
counterpart** in this field: supports are simply not represented.

## 4. Coverage

| field | present | valid 1..5 |
| --- | --- | --- |
| `lane_role` | 990/990 | 990/990 |
| `position_est` | 990/990 | 990/990 |
| `lane` | 990/990 | 990/990 |
| `is_roaming` | 990/990 | 0/990 (boolean, not a position) |

## 5. Game-mode split (§8)

| mode | matches | players | lane_role | position_est | field agreement |
| --- | --- | --- | --- | --- | --- |
| 18 | 20 | 200 | 200/200 | 200/200 | 56.5 % |
| 22 Ranked All Draft | 30 | 300 | 300/300 | 300/300 | 60.0 % |
| 23 Turbo | 49 | 490 | 490/490 | 490/490 | 54.7 % |

Coverage is uniform across modes; the agreement figures vary only as the
round-robin would be expected to.

## 6. Rank split (§9) — mostly unavailable

All four calibrated buckets report **unavailable**. The parsed matches fall
almost entirely outside the scanned discovery pages, so their rank tier cannot be
established from the discovery row. Rather than infer it, those rows are counted
under "no discovery row" and excluded from the bucket table.

This is a real limitation, and it is a coverage one: the rank-filtered public
population from ТЗ §22 and the parsed corpus from ТЗ §23 barely intersect.

## 7. Lane correlation (§12, exploratory)

`lane` also uses 1..3 plus a rare 5. `lane_role → lane` shows the expected
structure (`2→2` 207 rows, `3→1` 201, `1→3` 190 — lanes are assigned per player,
not per team). `position_est → lane` is uniform across `1..5`, as expected from
§2.

## 8. Benchmark heroes (§11)

| hero | n | lane_role | position_est | agreement |
| --- | --- | --- | --- | --- |
| Anti-Mage | 14 | 1,2,3 * | 1,2,3,5 * | 92.9 % |
| Wraith King | 15 | 1,2,3 * | 1,2,3,5 * | 80.0 % |
| Puck | 3 | 1,2 * | 1,2,5 * | 66.7 % |
| Kunkka | 3 | 1,3 * | 3,5 * | 66.7 % |
| Bane | 6 | 1,2,3 * | 1,2,4,5 * | 50.0 % |
| Sniper | 11 | 1,2,3 * | 2,3,4,5 * | 45.5 % |

Every hero is flagged ambiguous on both fields. With n as low as 3 for Puck and
Kunkka these numbers cannot separate pos2/pos3 or pos4/pos5 — the exact
distinction this corpus was supposed to settle.

## 9. Temporal stability (§14)

**Unavailable.** The corpus carries almost no `start_time` spread, because the
parsed matches are not in the scanned discovery pages (§6). The script reports
this rather than splitting on a degenerate axis.

## 10. Verdict

| | |
| --- | --- |
| `position_est` | **UNUSABLE** — provably a structural round-robin, zero position information |
| `lane_role` | **real signal, wrong axis** — a 3-valued lane, not a 5-valued position |
| rank coverage | **unavailable** — no discovery overlap |
| corpus size | 99 matches — too small for hero-level position splits |

**POSITION_PARTIAL.** `lane_role` is a usable *lane* signal and might support a
future "safe/mid/off" model, but neither field can be mapped onto the project's
1..5 position model without inventing the mapping, which §15 forbids.

The existing STRATZ position model stands unchanged, which is the correct
outcome: nothing here improves on it.

## 11. What this means for the roadmap

The ТЗ §23 parser finding and this one combine as follows:

- the parser **can** supply `lane_role` and `purchase_log` (ТЗ §23);
- but `position_est` is not the position source it appeared to be, and
  `lane_role` is a different axis from the one the app models.

So the parse-success-rate experiment is still worth running, but it should be
framed as acquiring **match-level items and timings**, not as acquiring
positions. Positions would still have to come from the STRATZ layer.

## Reproducing

```bash
npx vitest run scripts/public-position-lib.test.ts   # 18 tests
node scripts/public-position-research.mjs all
```

The maths lives in `scripts/public-position-lib.mjs` and is unit-tested:
value validation, coverage, field agreement, team structure, ambiguity and
temporal drift. No third position implementation was added to `src/scoring/`.
