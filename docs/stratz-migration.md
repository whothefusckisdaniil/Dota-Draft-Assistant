# Production data pipeline (ТЗ №6 migration + ТЗ №7 defect fixes)

**Hero metadata comes from OpenDota. Matchup statistics come from STRATZ.** Every
`public/data` file is refreshed from scratch on the weekly run, and all three are
published as one atomic directory swap. This document records **what** runs now, **why**
the numbers changed, and **how** to roll back.

## 1. What runs now

| Concern | Source | Refreshed |
| --- | --- | --- |
| Hero names, roles, portraits, pub/pro stats | OpenDota `/heroes` + `/heroStats` | **Every run** |
| Latest patch | OpenDota `/constants/patch` (highest patch id) | **Every run** |
| Matchup win rates | STRATZ GraphQL `heroStats.matchUp` | Every run (weekly) |
| Population | — | Calibrated rank brackets `HERALD_GUARDIAN`, `CRUSADER_ARCHON`, `LEGEND_ANCIENT`, `DIVINE_IMMORTAL` |
| Time window | — | Sum of the 4 last **fully completed** weekly buckets; current partial bucket always excluded |
| Transport | — | headless Chromium (Playwright) — `api.stratz.com` sits behind a Cloudflare interstitial |
| Generator | — | `scripts/update-data-stratz.mjs` (`npm run update:data`) |
| Schedule | — | weekly, Friday 03:00 UTC (data can only change when a bucket closes) |
| Publication | — | `scripts/dataset-publish.mjs`, directory swap |

`src/data/dataset.ts` still loads the same three static files; no runtime API calls were added.

### 1.1 The pipeline, in order

```
OpenDota /heroes + /heroStats + /constants/patch   (fresh metadata, every run)
        ↓  normalizeHero() -> heroes[], latestPatch
canonical heroIds
        ↓
STRATZ 4-week matchup query  ← asked for EXACTLY the ids above
        ↓
validateProductionContract(heroes, matchups)      (13 gates, fresh roster)
        ↓
public/data.__next/  {heroes.json, matchups.json, meta.json}
        ↓  re-read from disk + cross-check
atomic directory swap  →  public/data/
```

The ordering is load-bearing, and it is enforced by structure rather than by convention:
OpenDota is fetched *before* anything else, and any throw propagates out of `buildDataset()`
before the publish step is ever reached. So a dead OpenDota cannot produce a snapshot, and it
cannot produce a STRATZ request either.

**STRATZ is never asked about a hero that OpenDota did not report this run.** New heroes,
retired heroes, changed roles, new portraits, changed pub/pro stats and patch bumps therefore
flow into production automatically, and `heroes.json` / `matchups.json` / `meta.json` are always
guaranteed to describe the *same* snapshot.

### 1.2 Failure policy

There is no fallback and no partial write. If OpenDota metadata fetch, the STRATZ query, or
validation fails, the generator exits non-zero and `public/data` is left byte-for-byte as it
was. In particular `latestPatch` is **never** carried over from the previous `meta.json` — a
failed metadata fetch means no new dataset at all, rather than a fresh one wearing a stale
patch number.

## 2. Weekly buckets

STRATZ buckets are 604800 s wide and open **Thursday 00:00:00 UTC** (`bucket = floor(t/604800)`).
`scripts/stratz/buckets.mjs` exports `getCompleteWeeklyBuckets(referenceDate, count)`:

- the bucket containing `referenceDate` is the in-progress one and is never used;
- the window is the `count` buckets ending at `currentBucket - 1`, in ascending order;
- the exact Thursday boundary needs no special case: at `2960 * 604800 * 1000` ms the running
  second is already `2960 * 604800`, so `Math.floor` returns the freshly opened bucket and the
  window closes at 2959. One millisecond earlier it still returns 2959/2958.
- the excluded partial bucket is recorded in `meta.json` under
  `matchupWindow.excludedBuckets` — it is never mixed into production data.

Covered by `scripts/stratz/buckets.test.ts` (4 cases: mid-week, a second reference week, a
custom 6-week window with a strictly-increasing sequence, and the exact/±1 ms boundary).

## 3. Data contract (13 gates, all must pass before write)

Hero-id set matches `heroes.json` exactly · every table has exactly `heroCount - 1` opponents ·
no self rows · no duplicate opponents · `games_played > 0` · `0 <= wins <= games_played` ·
no unknown opponent ids · every reverse pair present · reverse-pair games asymmetry within
tolerance · wins-sum skew within tolerance · per-hero aggregate winrate inside 40–60 % ·
row/column total skew `<= 1.5 %` · total rows `= heroCount × (heroCount - 1)`.

Tolerance note: STRATZ ingests the two faces of a pair independently, so the same pair can be
reported with a slightly different match count from each side. A pair is therefore rejected only
when the difference is **both** relatively large (`> 3 %`) **and** absolutely large (`> 15`
games). Without the absolute term, rare pairs (a few hundred games) fail on ±5-match rounding
noise while genuinely broken pairs of the same size pass unnoticed. Observed distribution on the
current snapshot: reverse-pair asymmetry median 0.32 %, p99 1.62 %, max 3.38 %; wins-sum skew
median 0.18 %, p99 0.89 %, max 2.61 %; row/column skew max 1.0 %.

Every gate above is exercised against deliberately corrupted synthetic data in
`scripts/update-data-stratz.test.ts` (50 tests), and the same file asserts that the committed
`public/data/matchups.json` is accepted by the validator — so a "green" dataset is proven green
rather than assumed. The suite imports the generator, which is safe because `main()` is guarded
behind a direct-run check (`import.meta.url === pathToFileURL(process.argv[1]).href`); importing
never launches a browser or hits the network.

`wins` keeps the OpenDota convention: wins of the **key** hero (the enemy facing the candidates),
so `src/scoring/engine.ts` still inverts it (`winsForCandidate = games - wins`). Direction is
proven in `docs/stratz-research.md` §13 and independently by the wins-sum gate above.

The validator receives the **fresh** OpenDota roster, never the previously committed
`heroes.json`. That is what makes adding or retiring a hero safe: the expected hero-id set moves
with the roster instead of pinning the dataset to whatever shipped last week.

## 3.1 Atomic publication

`scripts/dataset-publish.mjs` refuses to produce a mixed snapshot:

1. the three files are written to a sibling staging directory `public/data.__next/`;
2. they are **re-read from disk** and cross-checked (all present, valid JSON, no duplicate hero
   ids, one matchup table per hero, no table for an unknown hero, `meta.heroCount` equal to the
   roster actually written);
3. only then is `public/data` renamed to `public/data.__prev` and the staging directory renamed
   into place — two `rename(2)` calls on the same filesystem, so the switch is instantaneous;
4. the backup is deleted.

If any step fails, the swap is rolled back (including the case where the first rename succeeded
and the second did not) and the staging directory is removed, leaving the previous `public/data`
byte-for-byte intact. Both temporary names are dot-prefixed, so a half-finished run is visible and
is never picked up by a static host or by `git add public/data`. CI additionally fails the job if
either directory is found.

### 3.2 Fail-closed on a recovery snapshot

`data.__next` and `data.__prev` are **not** the same kind of directory, and the difference matters
after a crash:

| Directory | Meaning | Deleted at the start of a run? |
| --- | --- | --- |
| `data.__next` | a half-written staging area — never authoritative | **yes**, always safe |
| `data.__prev` | the last *good* dataset, parked after a failed swap | **never** |

If both the swap-in rename and the restore rename fail, the live tree is gone and `data.__prev`
holds the only surviving copy. An earlier version swept that directory on the *next* run, so the
recovery copy was destroyed before anyone could act on it — a recoverable incident became total
data loss. The publisher now refuses to start instead:

```
Recovery snapshot already exists at:
  public/data.__prev

Refusing to delete or overwrite it automatically.
It is the last good dataset, and the publisher cannot know whether it is the
right thing to restore. Restore it first, then re-run:

  mv public/data.__prev public/data
```

This is deliberately **fail-closed**. The publisher does not auto-restore, because it has no way to
know whether `__prev` is the correct thing to put back, and guessing is worse than stopping. The
weekly job fails, nothing is committed, and `public/data.__prev` survives untouched until a human
runs the command printed above. Covered by `scripts/dataset-publish.rollback.test.ts`, including
the regression test that drives critical failure → second invocation → manual recovery.

Table completeness (every hero having exactly `heroCount - 1` opponents) is enforced at the last
gate, as an opt-in `requireCompleteTables` flag. STRATZ always returns a full matrix, so the
production generator sets it. OpenDota does **not** — its `/matchups` tables omit opponents it
has no data for (15 978 rows instead of 16 002) — so the flag is off for the fallback path,
which must remain usable as a rollback.

## 4. Measured effect of the migration

Sample size per hero pair (16 002 rows):

| Metric | OpenDota (last snapshot) | STRATZ (current) |
| --- | --- | --- |
| pair rows | 15 978 (24 missing) | 16 002 (complete) |
| total pair games | 1 152 450 | 427 906 575 (×371) |
| min / median / mean games | 1 / 49 / 72 | 113 / 15 898 / 26 740 |
| pairs below the 20-game usability floor | 3 164 (19.8 %) | 0 |
| rankable candidates for a random 3–5 enemy draft | mean 64 (min 6) | mean 123 (min 122) |

Old-vs-new winrate agreement over the 992 pairs with ≥200 games on **both** sides:
Pearson **r = −0.027**, mean |Δ| = 3.9 pp, per-enemy Spearman median −0.04. The two snapshots
carry no shared signal — exactly what the 19.8 % / median-49-games sample predicts: the
OpenDota rows were sampling noise, not matchup information.

Consequence, stated plainly: **rankings change substantially.** Top-15 overlap between the old
and the new snapshot is 4.6 % on average across 120 sampled drafts, and the candidate pool grows
from ~64 to all 123 non-enemy heroes. Expect the app to look different after this deploy; it is
the intended effect of removing the noise floor, not a regression. The scoring math
(`shrinkageK`, weights, confidence, role model) was **not** retuned.

Side effect worth knowing: with 1000s of games per pair, `confidence = min(1, √(avgGames/400))`
now saturates at 1 for every candidate and the `minMatchesPerPair` / `minimumSampleAvg` filters
never trigger. They are kept as a safety net for future data sources; the explanations
("Large statistical sample — high confidence") are now always true rather than informative.

## 5. Operational requirements

- `STRATZ_API_TOKEN` — free Default Token (Steam login at <https://stratz.com/api> → My Tokens).
  Local: `.env` (git-ignored, see `.env.example`). CI: repository secret of the same name.
- `playwright` (devDependency) plus browser binaries: `npx playwright install --with-deps chromium chromium-headless-shell`.
- The generator exits non-zero without ever touching `public/data` if any gate fails; the CI job
  then commits nothing.

End-to-end run verified against the live API (2026-09-28): 4 GraphQL chunks in ~6 s, Cloudflare
cleared on the first navigation, all 13 gates passed, both files written atomically. A second run
on the same buckets reproduced the snapshot to within 150 games out of 428 M (STRATZ keeps
backfilling closed buckets by a trickle), so the weekly cron diff stays tiny when nothing changed.

## 6. Rollback

`scripts/update-data.mjs` is kept intact as the OpenDota fallback:

```bash
npm run update:data:opendota-fallback   # restores the OpenDota-shaped dataset
```

Two things must be reverted with it, because the dataset tests and the UI attribution assert the
STRATZ contract: `src/data/dataset.test.ts` (expects `source: "STRATZ"`, `matchupWindow`,
`population`) and the STRATZ wording in `src/App.tsx` / `src/components/HeroDetailsDrawer.tsx` /
`index.html`. `.github/workflows/update-data.yml` must be pointed back at
`node scripts/update-data.mjs` (and can drop the Playwright install step and the token).
