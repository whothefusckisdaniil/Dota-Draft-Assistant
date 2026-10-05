# Cross-source match bridge (ТЗ §27) — BRIDGE_PARTIAL

> **Status: pilot executed.** 24 rank-filtered public matches, 6 per broad
> bucket, joined from OpenDota discovery to STRATZ. Verdict:
> **`BRIDGE_PARTIAL`**. Production scoring, datasets, UI and workflows are
> untouched.

## 1. Question

OpenDota's `/publicMatches` gives global rank-filtered discovery and a
`match_id`. STRATZ gives position, teams, result and final items for a
`match_id`. Can the two be joined for the **same** match, without waiting on
OpenDota's parser?

That parser is the blocker: ТЗ №26 measured **~2% availability** on public
matches, and the rank-filtered crawl ended in `TEMPORAL_INCONCLUSIVE` because
no hero stratum reached the pre-registered minimum. The hypothesis was that no
single source has every property, and the answer is composition:

```text
   OpenDota /publicMatches   ->  discovery, rank, match_id
              |
        match_id
        /        \
 OpenDota /matches    STRATZ match(id:)
 has_parsed?          position, enemy, items, result
 purchase_log        (read-only GraphQL query)
 timing
```

## 2. The POST deviation — stated explicitly

The ТЗ said GET-only, no POST. **OpenDota is GET only. STRATZ is not**, and
this was authorised as a read-only deviation:

- GraphQL sends the query in a request body, so the API requires POST.
- `api.stratz.com` sits behind a Cloudflare challenge that answers **403
  "Just a moment…" to plain `fetch` for BOTH verbs**. There is no GET
  substitute, and no header or user-agent that avoids the browser.
- The project's existing `StratzTransport` already solves this with Playwright,
  and is reused rather than reimplemented.

"Read-only" is enforced, not promised. The single query lives in
`STRATZ_MATCH_QUERY`; `assertReadOnlyQuery()` runs at startup and aborts if it
ever contains a mutation operation or a write field; and two unit tests fail
the build if the research script contains the word "mutation" outside a
comment, or opens a GraphQL document of its own.

The token is read from `STRATZ_API_TOKEN` or `.env`, is never written to cache,
and is logged only as `STRATZ_API_TOKEN -> REDACTED`.

## 3. Result

```text
requested       : 24          STRATZ hydration : 24/24   (100%)
exact roster    : 24/24       result agreement: 240/240, 0 mismatches
position 10/10  : 16/24       inventory multiset exact: 240/240
```

| Layer | N / 24 |
| --- | ---: |
| OpenDota discovery | 24 (100%) |
| OpenDota detail | 24 (100%) |
| STRATZ match | 24 (100%) |
| 10-player roster, exact | 24 (100%) |
| position coverage > 0 | 16 (66.7%) |
| position coverage 10/10 | 16 (66.7%) |
| enemy reconstruction (rows) | 240/240 (100%) |
| final inventory (rows) | 240/240 (100%) |
| result (rows) | 240/240 (100%) |
| optional purchase_log | 2 (8.3%) |

Cells produced: **1170** unique `Hero × Position × Enemy`, **6705** unique
`Hero × Position × Enemy × Item`. Counts only — no winrate, lift or score.

## 4. The finding that decided the design: STRATZ ingests on a lag

The first run scored **0/24**. Every id from the first pages of
`/publicMatches` returned `match: null`, while an older id hydrated with all
10 players and full position data.

A bisection over match ids located the ingest frontier at roughly
`9_029_947_349` (present) to `9_029_977_049` (absent) — a gap of ~30 000 ids.

Discovery therefore starts from a **declared cursor** (`9_029_900_000`), inside
the ingested region. This is a parameter of the method, not a sampling bias: the
sample is still the first eligible rank-filtered rows from that point, with no
hand-picking and no "matches STRATZ probably has" filter. It is printed in the
report, because a hit rate measured here applies to matches of that age and
**not** to matches that finished five minutes ago. Re-measure with
`--cursor=<matchId>`.

## 5. Position: present and exactly balanced, but not always

```text
position distribution: 1=32  2=32  3=32  4=32  5=32  null=80
```

Two facts, worth stating separately:

- **Where STRATZ has positions, it has all 10**, perfectly uniform across
  `POSITION_1..POSITION_5` — 32 of each, with no partial matches. There is no
  "8/10 coverage" case: it is all ten or none.
- **8 of 24 matches have no position at all.** Those matches are entirely
  `null`, not degraded.

Per §10, "exactly one of each position per team" is recorded as an
observation, not enforced as a validity rule — and in this sample every match
that had positions also satisfied it, so whether duplicates ever occur is still
open.

`POSITION_UNKNOWN` is parsed to `null` rather than coerced to a value, so
coverage is measured, never imputed.

## 6. Sources agree on result and on items

- **Result: 240 player rows compared, 0 mismatches.** `STRATZ isVictory` agrees
  with OpenDota's `radiant_win` + `player_slot` for every player in every match.
- **Items: 240 rows compared, all `exact`.** Compared as a **multiset**, because
  slot order is not guaranteed to agree between sources and carries no meaning
  here. Inventory, backpack and neutrals are kept in three separate arrays and
  never merged.

These two are what would have silently corrupted an enemy-conditioned dataset,
and they are clean.

## 7. A real disagreement: game mode

```text
mode comparable : 24/24   mismatched: 22
mode pairs      : 22 (All Draft) -> ALL_PICK_RANKED   n=22
                  23 (Turbo)      -> TURBO              n=2
```

STRATZ reports enums (`ALL_PICK_RANKED`, `RANKED`), OpenDota reports numbers
(`22`, `7`), so comparison goes through an explicit mapping table. The 22
matches where OpenDota says `22` and STRATZ says `ALL_PICK_RANKED` are a
**genuine source disagreement**, not a mapping artefact — `23 -> TURBO` agrees
cleanly in the same sample. Unmapped STRATZ values would be reported as a
mapping gap rather than silently called a match. This is a finding, not a bug,
and it is not resolved here.

Lobby type agreed on all 21 comparable matches.

`averageRank` was `null` in **24/24** STRATZ responses, which independently
confirms §2: rank must come from the OpenDota discovery row.

## 8. What the verdict does and does not mean

`BRIDGE_PARTIAL`, because position coverage is 16/24 rather than 24/24.

It establishes:

- global rank-filtered discovery joins to STRATZ for the same `match_id`;
- `position + enemy + items + result` arrive together, for real matches, in all
  four rank buckets (6/6 discovery → 6/6 STRATZ → 6/6 exact roster each);
- the two sources agree on result and on final items on every row.

It does **not** establish anything about volume, cost, patch stability or
duplicate rate (§28). `BRIDGE_VIABLE` is deliberately unreachable from a
24-match pilot.

**No production `Hero + Position + Enemy + Item` dataset is built here** (§25).
No `winrate`, `lift`, `core`, `mustBuy` or `recommended` appears anywhere in
this study.

### 8.1 Historical figures vs the 27.1 semantics

The ТЗ №27 numbers above are the historical observation and are **not**
restated:

```text
24/24 STRATZ hydration     24/24 roster      16/24 full position
240/240 result             240/240 inventory
1170 Hero x Position x Enemy
6705 Hero x Position x Enemy x Item
```

ТЗ §27.1 fixes positional-cell semantics for future runs. **The historical
1170 / 6705 figures may include null-position rows.** Re-deriving those same 24
matches under the corrected rule gives:

```text
160 rows with a valid position (1..5)
 80 rows without
 790 Hero x Position x Enemy       (was 1170)
4487 Hero x Position x Enemy x Item (was 6705)
```

So roughly a third of the originally reported cells were built on the literal
key `"null"`, i.e. on players whose position was never observed. That is
exactly the support inflation §2 set out to prevent. The old numbers are left
standing as what was measured; the corrected ones apply from the next run.

## 9. Known defects found while building this

Recorded because each one silently produced a plausible-looking wrong number:

- `sameRoster` had an inverted sign, reporting "missing in STRATZ" for players
  STRATZ was fine without.
- `extractRosterKey` reads `heroId`/`isRadiant` (STRATZ shape); OpenDota uses
  `hero_id`/`player_slot`. Reading the wrong key gave a 0-player roster for all
  24 matches and a 100% "mismatch" verdict.
- Normalising OpenDota players to `{heroId, isRadiant}` discarded
  `player_slot`, `item_0..item_5` and the match's `radiant_win`, so the result
  and item cross-checks compared against nothing: 0 rows checked for result,
  and a unanimous `complete_mismatch=240` for items.
- The funnel divided per-player row counts by a match total, printing 1000%.
- Two structural brace imbalances silently nested the entire program inside one
  function; it parsed cleanly, ran, and printed nothing.

## 10. Files and checks

```bash
node scripts/cross-source-match-research.mjs plan           # no network
node scripts/cross-source-match-research.mjs all            # GET + read-only STRATZ query
node scripts/cross-source-match-research.mjs all --cached   # re-report from cache
node scripts/cross-source-match-research.mjs all --cursor=9029900000
```

Cache lives in `/tmp/opendota-cross-source-research` and is never committed.
`plan` uses `process.exitCode` rather than `process.exit()`, because Node does
not flush a pending stdout write to a pipe before an explicit exit and `plan`
printed nothing when redirected.

## 11. ТЗ §27.1 — bridge integrity cleanup

Applied after the pilot, without re-running it. Each item closed a path by which
the harness could quietly produce a wrong number on the next run.

| § | Fix |
| --- | --- |
| 1 | `leagueid === 0` is now a **discovery-time** filter. `leagueid` is on the discovery row, so a league match is rejected before it can occupy one of the six bucket slots. A missing `leagueid` is `unknown`, not eligible. Rejected counts are printed. |
| 2 | A player with `position === null` is kept as a raw row but contributes **no cells**. Cell counts are position-filtered, and rows are split into positional / non-positional. |
| 3 | `hydrateStratz()` requires `Number(m.id) === Number(matchId)`. A response for another match is `STRATZ_ID_MISMATCH` and never reaches `playerRows()`. |
| 4 | `STRATZ_ID_MISMATCH` added, distinct from `STRATZ_NOT_FOUND`. |
| 5 | Position parsing is anchored `^POSITION_([1-5])$`. `garbage_3` and `POSITION_03` were previously read as position 3. |
| 6 | `sideOf()` returns `R`/`D` only for real booleans and `null` otherwise. `undefined`, `null`, `0`, `1` and `"abc"` previously became a concrete side, inventing cross-source identity from a missing field. |
Sampling by availability would have produced a flattering, meaningless number;
declaring the cursor keeps the hit rate honest about what it covers.