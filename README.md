# Dota Counterpick Assistant

A counterpick tool for Dota 2: pick the enemy heroes and get the heroes that statistically perform best against that draft. Matchup statistics are aggregated from STRATZ rank-bracket data (calibrated ranks: Herald through Immortal), and you can pick your rank bracket — counters differ a lot between Herald and Divine+; hero metadata comes from OpenDota.

**Only the last 30 days of the current patch are counted.** The statistics window slides every day: each daily refresh drops the oldest day and adds the newest one. Matches from before the latest patch are cut off, so two metas are never mixed after a balance patch (during the first 7 days of a new patch the window is the last 7 days, with pre-patch days at a quarter weight). Deploys to Vercel as a static Vite app.

## What it does

1. Choose 1–5 enemy heroes (search in English, RU aliases for common heroes; no duplicates, remove one or clear the draft).
2. Choose **All Positions** or a position 1–5.
3. Get the Top-15 counterpicks per position (in All Positions mode: the best pick per role).
4. Open **View analysis** for a recommended hero: its Counterpick Score against your draft, per-enemy matchup statistics (win rate, games played), Team Score, Median Matchup, Coverage and the explanation of the recommendation.

The app recommends heroes only. It does not recommend items, item builds or purchase orders (removed in ТЗ №77).

## Run

```bash
npm install
npm run dev      # http://127.0.0.1:5173
npm run build    # dist/
npm test         # vitest: scoring engine, dataset and pipeline tests
```

## Deploy (Vercel)

- Framework preset: Vite
- Build command: `npm run build`
- Output directory: `dist`
- No environment variables needed.
- Production does not call third-party APIs at runtime.
- The frontend loads the committed dataset from `public/data/` and scores locally.

## Dev tools

- **Scoring lab** (dev mode only) — replay of the scoring math on synthetic presets.
- **Draft validation** (dev only) — run the real engine on a real enemy draft, with every score component, coverage and best/worst matchup per candidate.
- **Live suite** — `LIVE=1 npx vitest run src/scoring/live.validate.test.ts` runs the regression set (4 hand-picked drafts with expected-vs-actual) **and** the evaluation set (10 fresh drafts, A/M/W rank-agreement metrics incl. Spearman ρ) through the real engine against live data. Skipped in normal `npm test`.

## Dataset

The frontend loads four static files from `public/data/` (plus the per-rank tables on demand) — no runtime API calls:

| File | Content |
|---|---|
| `heroes.json` | OpenDota hero metadata (id, `npc_dota_hero_*` key, name, portrait, roles) |
| `matchups.json` | STRATZ hero-vs-hero games and wins over the last 30 days |
| `positions.json` | STRATZ per-position pick share and games — the hard position eligibility gate |
| `meta.json` | Provenance, matchup window, rank brackets, data-quality summary, freshness |
| `matchups-by-bracket.json` | Optional. Matchup tables per rank bracket (Herald–Guardian, Crusader–Archon, Legend–Ancient, Divine–Immortal) for the rank selector; loaded only when a rank is chosen. Absent in the OpenDota fallback (the selector is then hidden). |

## Languages (EN / RU)

- The whole UI is available in English and Russian (`src/i18n/strings.ts`); the EN/RU switch is in the header. Language: `?lang=ru|en` in the URL → the remembered choice → the browser language (ru/uk/be/kk/… → Russian) → English. A Russian shared link carries `lang=ru`.
- Hero names: every hero has a full Russian name and community slang/abbreviations for search (`src/i18n/heroNamesRu.ts`, keyed by `npc_dota_hero_*`): "сф", "вд", "фурион", "бара", "квопа", "ам", "ёж"… In Russian the English game name is shown next to the Russian one (the Russian Dota 2 client keeps hero names in English).
- Ranks use the official Russian client names (Рекрут, Страж, Рыцарь, Герой, Легенда, Властелин, Божество, Титан); roles, positions, plurals ("1 пик / 2 пика / 5 пиков") and the analysis text are localized.
- Tests fail if a new hero has no Russian name or if a UI string is missing in either language.

## Shareable links

The draft lives in the URL, so a link can be pasted into Discord / Telegram and opens the same draft:

```
/?enemy=13,29,8&pos=3&rank=divine
```

| Param | Meaning |
|---|---|
| `enemy` | enemy hero ids (Valve/OpenDota ids), comma-separated, pick order, up to 5 |
| `pos` | `1`–`5`; absent = all positions |
| `rank` | `herald` \| `crusader` \| `legend` \| `divine`; absent = all ranks |
| `lang` | `ru` for Russian; absent = English / the viewer's choice |

The URL updates as you edit the draft (`history.replaceState`, no history spam) and the tab title names the enemies. **Copy link** copies it without tracking tags. Parsing is forgiving: unknown ids, junk and an invalid `pos`/`rank` are dropped instead of breaking the page; a shared rank does not overwrite the viewer's own remembered rank. Code: `src/data/draftUrl.ts`. Link previews use `public/og-image.png` (crawlers do not render SVG or run JS).

## Data refresh

- `scripts/update-data-stratz.mjs` fetches fresh OpenDota hero metadata, then STRATZ matchup tables and position statistics for the last 30 days (calibrated rank brackets), validates the 13-point matchup data contract and the position layer, and publishes the four files as one atomic directory swap; on any error the previous dataset is kept byte-for-byte.
- **Rank brackets**: matchups are fetched once per STRATZ bracket (Herald–Guardian, Crusader–Archon, Legend–Ancient, Divine–Immortal). `matchups.json` ("All ranks") is the sum of the four raw tables, which equals the combined all-bracket query (STRATZ's bracket groups partition it exactly, verified in FIX12). Within a single bracket STRATZ's A→B and B→A rows differ a lot (median 3–6.5%, up to 72% in Herald), i.e. the bracket filter applies to one player of the pair, not to the match; each rank table therefore averages both directions (matches where either hero was played in that bracket). Every rank table passes the same data contract (zero-game pairs are allowed there, e.g. Herald on the first day of a patch). Positions are always all-bracket (the eligibility gate needs ≥ 500 games per lane). In the app each rank uses its own baselines for the advantage.
- **Patch cut**: the window never starts before the current patch release (`/constants/patch` date from OpenDota). If the patch is younger than 7 days, the window is the last 7 days and the pre-patch part counts at weight 0.25, so the new meta dominates while the sample stays usable. A new patch triggers a refresh the same day. `meta.json → matchupWindow.patch` records the patch, its release time and which rule applied.
- **Rolling 30-day window** (`getRollingWindow` in `scripts/stratz/buckets.mjs`): STRATZ publishes matchup and position statistics only per weekly bucket (Thursday 00:00 UTC), so the window `[max(today − 30 days, patch release), now)` is built from weeks: the current week is taken as-is (STRATZ fills it live, so it already holds the days elapsed so far), complete weeks inside the window count fully, and the oldest week that is only partly inside is scaled by the share of its 7 days still in the window (it loses 1/7 per day until it drops out). `meta.json → matchupWindow` records the exact dates, buckets and weights.
- Reverse-pair asymmetry: STRATZ returns slightly different `matchCount` for A→B and B→A (known, reported to STRATZ). Up to 0.1% of rows may exceed 3% / 15 games and are logged as warnings; any row above 10%, or more rows than that, still blocks the refresh.
- `scripts/update-data.mjs` is preserved as an OpenDota rollback fallback (it carries the committed `positions.json` forward).
- `.github/workflows/update-data.yml` refreshes the dataset **every day** via GitHub Actions (daily `cron` at 03:17 UTC and manual `workflow_dispatch`), validates it, runs `npm test`, typecheck and build, and commits the new 30-day window. If the run fails, the old dataset stays committed.
- `npm test` covers the app and the production pipeline. The frozen STRATZ research suites (FIX9–FIX17) pin the hashes of the snapshot they were recorded with, so they run separately via `npm run test:research` and are expected to fail once the data has been refreshed.
- Local manual run: `node scripts/update-data-stratz.mjs` (Node 20+, requires `STRATZ_API_TOKEN`).
- STRATZ is called over plain HTTPS with `User-Agent: STRATZ_API` and the bearer token (no browser, no Cloudflare workaround); ~21 requests per refresh.
- **Terms, attribution, monetization risks and what to do if the STRATZ token stops working: [`docs/data-sources.md`](docs/data-sources.md).**

Frontend loads `public/data/*.json` once, scores locally, and shows `Data updated …` freshness from `meta.generatedAt`.

Details and measured impact of the OpenDota → STRATZ switch: [`docs/stratz-migration.md`](docs/stratz-migration.md). The research spike behind it (schema, direction proof, the former Cloudflare workaround — no longer used) is in [`docs/stratz-research.md`](docs/stratz-research.md).

## How scoring works (MVP model, see `src/scoring/engine.ts` + `src/config.ts`)

For each candidate vs each selected enemy (1–5):

- `matchups.json` stores **enemy wins** vs candidate → candidate winrate = `1 - wins/games`.
- **Matchup advantage** (like Dotabuff's “disadvantage”): each hero's baseline win rate is computed over the whole snapshot (`src/scoring/baseline.ts`); the expected win rate of A vs B is `base(A) − (base(B) − 50)` and the delta is `advantage = winrate − expected`. A hero that is simply strong in the patch is therefore not ranked as a counter to everyone. Raw win rate is still shown in the analysis.
- **Shrinkage**: `advantage × games/(games + 60)` so rare matchups cannot dominate.
- **Team score**: median advantage across the selected enemies (model M; the `√games`-weighted mean is kept for the dev lab) — stable-against-whole-lineup beats one spiky matchup.
- **Confidence**: `min(1, √(avgGames/400))`, final score blended toward 0 when data is thin.
- **Position — hard gate**: a hero is ranked on a lane only where it is actually picked. `positions.json` (STRATZ, same 30-day window and rank brackets as the matchups) must show `share ≥ 8%` and `≥ 500` games. OpenDota `roles` are *not* used for eligibility. See `docs/position-model.md`.
- **Position — secondary**: heuristic role fit 0–10 (role tags + curated lane nudges, NOT measured per-position winrates) → bonus ±4 pts, weighted `0.8 counter / 0.2 role`. It can nudge the order by at most 0.8 points, but can no longer remove a candidate.
- **Strict full coverage (V2)**: candidate must have usable data vs EVERY selected enemy; a failed matchup table blocks ranking instead of silently ranking partial heroes.
- Filters: pair needs ≥20 games, candidate avg ≥40 games, enemies can't be recommended against themselves.

Explanations are plain-JS template sentences ("Statistically favorable…"), never "will win".

## Acceptance checklist (§34)

1. EN partial search for all heroes + RU aliases for the covered subset (`jug`, `пак`) — `src/data/heroes.ts`, `ruNames.ts`
2. 1–5 enemies, no duplicates — `useDraftData`
3. Position filter All/1–5 — `config.POSITIONS`
4–5. Top-15 per lane over **all** selected enemies — `scoreCandidates`
6. Shrinkage + confidence + minimum samples — `config.scoring`
7. `Matchups: STRATZ · Heroes: OpenDota` footer badge + `Latest patch: X` (`latestPatch` is display-only; matchup tables are aggregate, NOT patch-filtered), `Latest patch unavailable` fallback
8. Loading/error/empty states; patch/heroStats failures degrade gracefully, matchup-table failure blocks ranking honestly
9. Responsive per-role view: dominant Best Pick (#1) + compact 2-col Top-15 ranked-alternatives rows (`ResultsGrid` / `RankingRow`); ALL mode keeps one card per role
10–11. Third-party data only at build time, static build + `vercel.json`
12. Matchup breakdown + reasons per card (`CandidateCard`)

## Research

- STRATZ matchup data quality (reverse-pair asymmetry, FIX9–FIX17): `research/data-quality/`, scripts `scripts/stratz-*.mjs`, commands `npm run stratz:diagnostic:*`.
- The retired item/build features and their research (recommended builds, item priors, threat/response item taxonomy) were removed in ТЗ №77; they remain available in the git history before that commit.
