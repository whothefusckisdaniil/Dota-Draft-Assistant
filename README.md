# Dota Draft Assistant — MVP

Find statistically favorable counter picks against the enemy draft. OpenDota data only, no paid APIs, no backend. Deploys to Vercel as a static Vite app.

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
- Production does not call OpenDota at runtime.
- The frontend loads the committed dataset from `public/data/` and scores locally.

## Dev tools

- **Scoring lab** (dev mode only) — replay of the scoring math on synthetic presets.
- **Draft validation** (dev only) — run the real engine on a real enemy draft, with every score component, coverage and best/worst matchup per candidate.
- **Live suite** — `LIVE=1 npx vitest run src/scoring/live.validate.test.ts` runs the regression set (4 hand-picked drafts with expected-vs-actual) **and** the evaluation set (10 fresh drafts, A/M/W rank-agreement metrics incl. Spearman ρ) through the real engine against live OpenDota data. Skipped in normal `npm test`.

## Data refresh

Matchup dataset is a static snapshot — no runtime OpenDota calls:

- `scripts/update-data.mjs` fetches heroes + matchup tables (retry/backoff, concurrency 3) and writes `public/data/{heroes,matchups,meta}.json` atomically; on critical errors the previous dataset is kept.
- `.github/workflows/update-data.yml` runs it every 24h (`cron`) and on `workflow_dispatch`, validates the result, and commits only when the dataset changed. If the run fails, the old dataset stays committed.
- Local manual run: `node scripts/update-data.mjs` (Node 20+, ~3–5 min first time, cached afterwards).

Frontend loads `public/data/*.json` once, scores locally, and shows `Data updated …` freshness from `meta.generatedAt`.

## How scoring works (MVP model, see `src/scoring/engine.ts` + `src/config.ts`)

For each candidate vs each selected enemy (1–5):

- OpenDota `/heroes/{enemyId}/matchups` stores **enemy wins** → candidate winrate = `1 - wins/games`, delta = `winrate − 50`.
- **Shrinkage**: `delta × games/(games + 60)` so 2-game 100% rows can't dominate.
- **Team score**: weighted average of deltas, weight `√games` — stable-against-whole-lineup beats one spiky matchup.
- **Confidence**: `min(1, √(avgGames/400))`, final score blended toward 0 when data is thin.
- **Position**: heuristic role fit 0–10 (role tags + curated lane nudges, NOT measured per-position winrates) → bonus ±4 pts (`0.8 counter / 0.2 role`), per-lane minimum 4.5.
- **Strict full coverage (V2)**: candidate must have usable data vs EVERY selected enemy; a failed matchup table blocks ranking instead of silently ranking partial heroes.
- Filters: pair needs ≥20 games, candidate avg ≥40 games, enemies can't be recommended against themselves.

Explanations are plain-JS template sentences ("Statistically favorable…"), never "will win".

## Acceptance checklist (§34)

1. EN partial search for all heroes + RU aliases for the covered subset (`jug`, `пак`) — `src/data/heroes.ts`, `ruNames.ts`
2. 1–5 enemies, no duplicates — `useDraftData`
3. Position filter All/1–5 — `config.POSITIONS`
4–5. Top-5 per lane over **all** selected enemies — `scoreCandidates`
6. Shrinkage + confidence + minimum samples — `config.scoring`
7. `OpenDota data · Latest patch: X` badge (`/constants/patch` is display-only; matchup tables are aggregate, NOT patch-filtered), `Latest patch unavailable` fallback
8. Loading/error/empty states; patch/heroStats failures degrade gracefully, matchup-table failure blocks ranking honestly
9. Responsive: 1 col mobile → 2–3 col desktop (`ResultsGrid`)
10–11. OpenDota only, static build + `vercel.json`
12. Matchup breakdown + reasons per card (`CandidateCard`)
