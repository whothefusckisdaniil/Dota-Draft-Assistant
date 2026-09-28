# Dota Draft Assistant — MVP

Find statistically favorable counter picks against the enemy draft. Matchup statistics aggregated from STRATZ rank-bracket data (calibrated ranks: Herald through Immortal, 4 complete weeks); hero metadata from OpenDota. Deploys to Vercel as a static Vite app.

## Run

```bash
npm install
npm run dev      # http://127.0.0.1:5173
npm run build    # dist/
npm test         # vitest: scoring engine cases
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

## Data refresh

Matchup dataset is a static snapshot — no runtime API calls:

- `scripts/update-data-stratz.mjs` fetches matchup tables from STRATZ GraphQL across 4 complete weekly buckets (calibrated rank brackets, atomic write, 13-point data contract validation); on critical errors the previous dataset is kept.
- `scripts/update-data.mjs` is preserved as an OpenDota rollback fallback.
- `.github/workflows/update-data.yml` runs dataset refresh via GitHub Actions (`cron` and `workflow_dispatch`), validates the result, and commits only when the dataset changed. If the run fails, the old dataset stays committed.
- Local manual run: `node scripts/update-data-stratz.mjs` (Node 20+, requires `STRATZ_API_TOKEN`).

Frontend loads `public/data/*.json` once, scores locally, and shows `Data updated …` freshness from `meta.generatedAt`.

Details and measured impact of the OpenDota → STRATZ switch: [`docs/stratz-migration.md`](docs/stratz-migration.md). The research spike behind it (schema, direction proof, Cloudflare workaround) is in [`docs/stratz-research.md`](docs/stratz-research.md).

## How scoring works (MVP model, see `src/scoring/engine.ts` + `src/config.ts`)

For each candidate vs each selected enemy (1–5):

- `matchups.json` stores **enemy wins** vs candidate → candidate winrate = `1 - wins/games`, delta = `winrate − 50`.
- **Hard position gate**: a hero is only ranked on a lane where it is actually picked — `positions.json` (STRATZ, same 4-week window and rank brackets as the matchups) must show `share ≥ 8%` and `≥ 500` games. OpenDota `roles` are *not* used for eligibility. See `docs/position-model.md`.
- **Shrinkage**: `delta × games/(games + 60)` so rare matchups cannot dominate.
- **Team score**: weighted average of deltas, weight `√games` — stable-against-whole-lineup beats one spiky matchup.
- **Confidence**: `min(1, √(avgGames/400))`, final score blended toward 0 when data is thin.
- **Position — hard gate**: a hero is ranked on a lane only where it is actually picked. `positions.json` (STRATZ, same 4-week window and rank brackets as the matchups) must show `share ≥ 8%` and `≥ 500` games. OpenDota `roles` are *not* used for eligibility.
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
