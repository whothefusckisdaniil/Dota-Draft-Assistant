# LASTPICK — counterpick tool for Dota 2

*Win the draft before the game starts.* Not affiliated with Valve.

A counterpick tool for Dota 2: pick the enemy heroes and get the heroes that statistically perform best against that draft. Matchup statistics are aggregated from STRATZ rank-bracket data (calibrated ranks: Herald through Immortal), and you can pick your rank bracket — counters differ a lot between Herald and Divine+; hero metadata comes from OpenDota.

**Only the last 30 days of the current patch are counted.** The statistics window slides every day: each daily refresh drops the oldest day and adds the newest one. Matches from before the latest patch are cut off, so two metas are never mixed after a balance patch (during the first 7 days of a new patch the window is the last 7 days, with pre-patch days at a quarter weight). Deploys to Vercel as a static Vite app.

## What it does

1. Choose 1–5 enemy heroes (search in English, RU aliases for common heroes; no duplicates, remove one or clear the draft).
2. Choose **All Positions** or a position 1–5.
3. Get the Top-15 counterpicks per position (in All Positions mode: the best pick per role).
4. Open **View analysis** for a recommended hero: its Counterpick Score against your draft, per-enemy matchup statistics (win rate, games played), Team Score, Median Matchup, Coverage and the explanation of the recommendation.

The app recommends heroes and shows the **statistical build** of your own hero (what players of your rank buy and pick on that hero and position). It does not adapt items to the enemy draft yet: research in ТЗ §36–§38 found no robust item-vs-enemy signal in the data, so that part will be rule-based and labelled as such.

## Design and brand

- **Name:** LASTPICK (no "Dota" in the name: it is a Valve trademark; the subtitle says "counterpick tool for Dota 2").
- **Logo:** `public/brand/` — mark (rounded diamond = the 5th draft slot, with an "advantage" arrow cut out, kept fully inside the diamond), horizontal and vertical lockups, mono white/black, app icon, maskable icon. The wordmark is outlined (Unbounded Bold), so the files need no font. Up to 32 px the mark uses a bolder arrow (`lastpick-mark-small.svg`, favicon). Regenerate: `scripts/brand/generate-logo.mjs`; PNG icons and `og-image.png`: `node scripts/brand/render-brand.mjs`.
- **Tokens:** `src/index.css` (`--bg #090B0F`, surfaces `#11151C` / `#181E28`, border `#232B38`, text `#E8ECF2` / `#8A94A6`, accent `#FFB43A`, plus `#3DDC97`, minus `#FF5C5C`). Amber is only for the brand and primary actions; green/red only for advantage numbers, always with a `+`/`−` sign.
- **Type:** Unbounded 700 (headings, numbers), Inter 400/600/700 (UI, tabular numbers).
- **Layout:** phones — sticky enemy strip, role tabs, results, the hero search in a bottom bar (thumb zone) opening a bottom-sheet picker that stays open until the list is full or "Done"; tablets (768+) — sticky draft panel + results, analysis in a 420 px side panel; desktop (1280+) — the hero grid is always visible on the left, draft in the middle, results on the right (max 1360 px).
- **Background:** CSS-only animation (`.bg-fx` in `src/index.css`): a slowly drifting amber glow, a faint sliding diamond grid and five small diamonds lighting up in turn. Only `transform`/`opacity` are animated (compositor, no repaint, no JS): measured 60 fps with ~0.02 s main-thread time per 3 s on desktop and phone; paused by the browser in background tabs, still under `prefers-reduced-motion`. The sticky draft strip has no backdrop blur (it would be recomputed every frame over the moving background).
- **Motion:** 150–220 ms ease-out; the loader is five diamonds lighting up in turn; `prefers-reduced-motion` keeps only opacity fades.

- **PWA / offline:** `public/manifest.webmanifest` + `public/sw.js` (registered in production only). Pages and `/data/*.json` are network-first with an offline fallback; hashed assets, portraits, medals and fonts are cache-first. Installable to the home screen; works without a connection once opened. Bump `VERSION` in `sw.js` to drop old caches.
- **Portraits:** WebP from our own origin (`public/heroes/<key>.webp`, ~8 KB each, 1.1 MB total, explicit `width`/`height`, lazy in the grid). `node scripts/fetch-portraits.mjs` downloads new heroes (needs Playwright; `--force` re-encodes all). A hero without a local file falls back to the Steam CDN image, so a new hero never breaks the page.

- **Share:** the Share menu copies the draft link or makes a draft card image — enemies + top counterpicks, LASTPICK branding, site address — as 1080×1920 (stories / TikTok, content kept out of the top/bottom 250 px) or 1200×630 (post). Drawn on a canvas in the browser (`src/share/shareCard.ts`); phones get the system share sheet with the file, desktops download it.

- **Analytics:** Vercel Web Analytics (`@vercel/analytics`, mounted in `src/main.tsx`): cookieless visitor and page-view counts, countries, devices, referrers in the Vercel dashboard → Analytics (enable it there once). The draft query string is stripped before sending (`src/analytics.ts`), one view per page per visit, and visits that opened a shared draft link are reported as `/?via=draft-link`. Mentioned on the Privacy page.

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
| `synergy.json`, `synergy-by-bracket.json` | Optional pair. Same-team ("with") tables: for every hero pair, games and wins **of the team with both heroes**, all ranks and per rank. Used for your-team synergy and ban suggestions; loaded only once a draft exists. Absent → allies are only excluded and ban suggestions use matchups only. |
| `matchups-by-bracket.json` | Optional. Matchup tables per rank bracket (Herald–Guardian, Crusader–Archon, Legend–Ancient, Divine–Immortal) for the rank selector; loaded only when a rank is chosen. Absent in the OpenDota fallback (the selector is then hidden). |

## Languages (EN / RU)

- The whole UI is available in English and Russian (`src/i18n/strings.ts`); the EN/RU switch is in the header. Language: `?lang=ru|en` in the URL → the remembered choice → the browser language (ru/uk/be/kk/… → Russian) → English. A Russian shared link carries `lang=ru`.
- Hero names: every hero has a full Russian name and community slang/abbreviations for search (`src/i18n/heroNamesRu.ts`, keyed by `npc_dota_hero_*`): "сф", "вд", "фурион", "бара", "квопа", "ам", "ёж"… In Russian the English game name is shown next to the Russian one (the Russian Dota 2 client keeps hero names in English).
- Ranks use the official Russian client names (Рекрут, Страж, Рыцарь, Герой, Легенда, Властелин, Божество, Титан); roles, positions, plurals ("1 пик / 2 пика / 5 пиков") and the analysis text are localized.
- Tests fail if a new hero has no Russian name or if a UI string is missing in either language.

## Shareable links

The draft lives in the URL, so a link can be pasted into Discord / Telegram and opens the same draft:

```
/?enemy=13,29,8&ally=26,2&ban=14&pos=3&rank=divine
```

| Param | Meaning |
|---|---|
| `enemy` | enemy hero ids (Valve/OpenDota ids), comma-separated, pick order, up to 5 |
| `ally` | your team's hero ids, up to 4 |
| `ban` | banned hero ids, up to 14 |
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
- **A newly released hero** joins automatically: the roster comes from OpenDota every day. While it has under 3% of the median hero's games (the rarest established hero, Chen, has ~6%), pairs it has not played yet are published as 0-game rows ("no data") instead of failing the contract, its win rate is not held to the 40–60% band, and missing lane stats become an all-zero entry (not recommended for any lane yet). It shows up in search and as an enemy right away and enters the recommendations as games accumulate; the refresh keeps running for every other hero. Zero-game pairs between established heroes still fail, and more than 3 such "new" heroes is treated as broken data. The daily job downloads its WebP portrait (`scripts/fetch-portraits.mjs`, CDN image until then) and warns if `src/i18n/heroNamesRu.ts` has no Russian name for it (`scripts/check-hero-assets.mjs`; the RU UI shows the English name meanwhile).
- `scripts/update-data.mjs` is preserved as an OpenDota rollback fallback (it carries the committed `positions.json` forward).
- `.github/workflows/update-data.yml` refreshes the dataset **every day** via GitHub Actions (daily `cron` at 03:17 UTC and manual `workflow_dispatch`), validates it, runs `npm test`, typecheck and build, and commits the new 30-day window. If the run fails, the old dataset stays committed.
- `npm test` covers the app and the production pipeline. The frozen STRATZ research suites (FIX9–FIX17) pin the hashes of the snapshot they were recorded with, so they run separately via `npm run test:research` and are expected to fail once the data has been refreshed.
- Local manual run: `node scripts/update-data-stratz.mjs` (Node 20+, requires `STRATZ_API_TOKEN`).
- STRATZ is called over plain HTTPS with `User-Agent: STRATZ_API` and the bearer token (no browser, no Cloudflare workaround); ~21 requests per refresh.
- **Terms, attribution, monetization risks and what to do if the STRATZ token stops working: [`docs/data-sources.md`](docs/data-sources.md).**

Frontend loads `public/data/*.json` once, scores locally, and shows `Data updated …` freshness from `meta.generatedAt`.

Details and measured impact of the OpenDota → STRATZ switch: [`docs/stratz-migration.md`](docs/stratz-migration.md). The research spike behind it (schema, direction proof, the former Cloudflare workaround — no longer used) is in [`docs/stratz-research.md`](docs/stratz-research.md).

## Lane partner (ally positions)

Each ally gets a position chip under its slot: guessed from its usual positions (dashed — Shadow Shaman → 5, Undying → 4; never your own role), tap to cycle 1→5 (solid; kept in the link as `allypos=85-4,27-5`). Positions define your **lane partner**: safe lane 1 + 5, off lane 3 + 4, mid alone. Recommendations for a role then add how well each candidate **lanes with that ally**:

- Data: STRATZ `laneOutcome(isWith: true)` — laning-stage won / drawn / lost lanes of a hero at a position with each partner on the same lane, per rank bracket, same 30-day window. Collected in the weekly builds job (same requests, extra fields) into `public/builds/lanes/<heroId>.json`; each hero's usual lane win share per position and rank is in `public/builds/index.json → laneAvg`. Only allies' files are loaded.
- Score: lane win share with the ally (won / (won + lost)) minus what both usually get (candidate's share + ally's share − 50%), shrunk by `lanes / (lanes + 150)`, ≥ 30 decided lanes; `draft += 0.15 × lane` (the lane is only the first ~10 minutes). No coverage gate: no data, no adjustment.
- Shown on the best-pick card, in the analysis and in the explanation: "Lane with Undying: won 75% of lanes, expected 66% +8.57".
- Example (Crusader–Archon, Undying pos 4 who wins 66% of his lanes on average): Bristleback pos 3 wins 60% with him vs 58% expected — slightly better than expected, not worse; the data replaces the "two melee heroes can't lane" intuition with actual lane results.

## Top supports (no draft needed)

Before any hero is picked, the main screen shows **Strongest supports right now**: the top 10 heroes on position 4 or 5 by their **win rate when played at that position**, for the rank chosen in the block or the header chip (each bracket or all ranks), over the same 30-day window. Only heroes really played there count (≥ 20% of their games at that position, ≥ 500 games in a bracket / 2 000 across all ranks); the ranking pulls small samples toward 50% (`games / (games + 1000)`), and each row shows the raw win rate, its distance from 50% and the number of games. Code: `src/scoring/topByRole.ts`, `src/components/TopSupports.tsx`.

Data: `public/data/role-stats.json` — `{ ALL | <bracket>: { heroId: [[games, wins] for positions 1..5] } }`, from STRATZ `heroStats.stats(groupByPosition: true)` with `winCount`, one request per weekly bucket for all four brackets (`scripts/stratz/role-stats.mjs`). Checked before publishing (the five position totals of a bracket must match within 10% — every match has two players per position — and each position's population win rate must sit within 45–55%). It is an optional layer: if STRATZ fails or the check fails, the refresh publishes everything else and the block is hidden.

## Hero builds (MVP)

Pick **your hero** in the "You" slot (or press **Build** in a recommended hero's analysis) and the results column shows its build for a position and the selected rank: starting items (with quantities), boots and laning items, core (bought in ≥ 35% of games), situational items, skill order (level at which each ability is usually maxed; the ultimate at 6/12/18) and talents with pick shares. Each item shows the share of games it is bought in and the typical minute. If the rank has too few games on that position (< 300), the all-ranks build is shown with a notice. The build follows the **Role** tab — one switch for the recommendations and the build (the panel's position buttons switch the Role tab; "All" shows the hero's main position; **Build** in a hero's analysis sets the role it was recommended for). If the hero is (almost) never played at the chosen position (not eligible there: < 8% of its games or < 500 games), **no build is shown** — another role's items under that role's name would mislead — only a note and buttons for the positions it is really played on. URL: `?hero=26`.

- **Data:** STRATZ `heroStats` — `itemStartingPurchase`, `itemBootPurchase`, `itemFullPurchase` (by game minute), `talent`, `abilityMaxLevel`, `abilityMinLevel` — filtered by hero, week, rank bracket and **position**; one request per hero per weekly bucket covering all its positions and brackets. Names: OpenDota constants (item keys, costs, hero ability lists) and STRATZ constants (talent texts with numbers, EN + RU).
- **Denominator:** the item endpoints count a larger population than `heroStats.stats`, so shares are taken against the number of matches in the item population itself — every basic ability is first skilled once per match, and those totals agree to ~0.1% (Lion pos 5 Divine: 27 289 / 27 292 / 27 264 / 27 275).
- **Not available:** neutral items (STRATZ returns none for the current patch), facets, exact skill-by-level order.
- **Pipeline:** `scripts/update-builds-stratz.mjs` + `scripts/stratz/builds.mjs` → `public/builds/<heroId>.json` (loaded only for the chosen hero) and `public/builds/index.json` (names). Same 30-day patch window, brackets and position eligibility as the matchups. `.github/workflows/update-builds.yml` runs daily after the data job but rebuilds only when due (weekly, new patch, new hero, or forced) — ~640 requests / ~25 min, inside the token's limits (8/s, 150/min, 1 500/h, 15 000/day). Validated before an atomic directory swap; on failure the old builds stay.

### Ideal build

The top of the build panel is one row: **boots + 6 slots in buying order** (`src/scoring/idealBuild.ts`):
1. **core** — items this hero buys in ≥ 35% of games at this position and rank;
2. **draft** — up to 2 slots for the enemy draft, only items this hero actually buys (labelled "vs Hoodwink");
3. **situational** — the hero's next most popular items fill the rest.

Components most players complete are shown as the finished item (a component leaves the list when its upgrade is bought in at least half as many games: Yasha → Manta, Perseverance → Battle Fury, Crystalys → Daedalus; Maelstrom stays when Mjollnir is rare, and then the upgrade gets no slot of its own: Skull Basher 41% + Abyssal 19% is one slot). Two upgrades of the same intermediate item are alternatives — Hurricane Pike and Hydra's Breath both need Dragon Lance, so having both would mean two Lances: only the more popular one is kept. The same goes for the first big farming item (Radiance / Maelstrom–Mjollnir / Battle Fury): heroes go one way, so a non-core one is dropped when a more popular one is in the build (the data has each item's share, not how often two are bought together). Aghanim's Shard and Blessing take no slot: the shard is shown after the slots as a "no slot" tile with its purchase share and typical minute when ≥ 10% of games buy it — purchases only, so a shard from a Tormentor (free) is not counted and the real share is higher, which the note says; order = typical purchase minute. A **My rank / Divine+** switch rebuilds the whole panel from Divine–Immortal games ("how strong players build it"); it is hidden when the selected rank already is Divine–Immortal. No extra STRATZ requests: everything comes from the weekly build files (item recipes are in `public/builds/index.json`).

### For your team (rules)

The ideal build also looks at your **allies** (`src/scoring/teamNeeds.ts`, hero traits from `heroTags.ts`, at least two allies): no right-click carry among them and you play 1–3 → **damage** first; at most one hard disable in total → **control** first; you play 3–5 and no ally heals or saves → **saves** first; you play 3–5 next to two carries → damage is covered, **keep them alive** (saves). Up to 2 of the slots left after core and draft items go to items of that role **that this hero buys** (≥ 5%), labelled "team: damage / control / saves"; the core is never displaced; the rest of the fill prefers those roles too. Item roles: `src/data/itemTags.ts` (hand-authored; new items are left untagged rather than guessed).

### For this draft (rules, not statistics)

With enemies in the draft, the build panel adds **For this draft**: up to 4 items with the reason and the enemies behind it ("Black King Bar — vs Lion, Bane, Earthshaker · hard disables on the enemy team: 6"). Items already in the statistical build that match get an amber frame. This is rule-based on purpose (the data showed no robust item-vs-enemy signal, ТЗ §36–§38) and is labelled as such in the UI.

- **Hero traits** — `src/data/heroTags.ts`, one line per hero: damage type (magic / physical / mixed), number of hard disables, flags (invisible, healing, illusions, summons, evasion, silence, slippery, right-click carry). **Hand-authored draft — worth a review by a strong player**; a hero without tags adds nothing (tests allow up to 3 untagged, e.g. a just-released hero).
- **Rules** — `src/scoring/itemRules.ts`: disables ≥ 4 → BKB / Lotus / Glimmer / Aeon; magic ≥ 60% → BKB / Pipe / Mage Slayer / Glimmer; invisible → Dust / Sentry / Gem; heal ≥ 2 → Spirit Vessel / Skadi / Shiva's; evasion → MKB / Bloodthorn; ≥ 2 physical carries → Ghost / Force / Crimson / Halberd / Blade Mail; illusions or summons ≥ 2 → Mjollnir / Battle Fury (melee) / Shiva's; ≥ 2 slippery → Orchid / Abyssal / Atos / Gleipnir / Scythe; ≥ 2 silences → Manta (agi/universal) / Lotus / Eul's. Items are filtered by position (cores vs supports) and **only items this hero buys at this position** (≥ 5% of games) are suggested — a top item nobody builds on this hero is not recommended (e.g. BKB on Juggernaut, who has Blade Fury); consumables are the exception. An item it already buys in ≥ 60% of games is not repeated; the more often it buys an item, the higher it ranks. An item nobody buys this patch (not in any build, e.g. the removed Eternal Shroud) is never suggested; consumables (Dust, Gem, Sentry) are exempt because builds leave them out.

## Draft win chance (full 5 v 5)

When both teams are complete (four allies + your hero, five enemies) a card shows each team's chance (`src/scoring/winChance.ts`). The edge in win-rate points is hero strength (Σ base win rate − 50, yours minus theirs) + all 25 matchup advantages + teammate synergy (your 10 pairs minus theirs), shrunk by sample size like the picks, for the selected rank. Chance = logistic(0.0345 × edge): the slope was fitted on ~4000 public ranked matches (OpenDota); the three parts got nearly equal weights, and on held-out matches the draft alone picked the winner ~60% of the time. The card also lists the part sizes and the best / worst single matchup.

## Allies, synergy and bans

The draft has three lists: **enemies** (up to 5), **your team** (up to 4 — you are the 5th) and **bans** (up to 14). The search adds to whichever is selected ("Add to: Enemies / My team / Bans"); a hero lives in one list only.

- **Synergy** comes from STRATZ `matchUp … with { … }` rows — the same requests as the matchups, no extra calls. For a candidate C and ally A: `synergy = team win rate of C+A − (base(C) + base(A) − 50)`, shrunk like matchups. Per rank, both directions are averaged (the bracket filter applies to one player, as with matchups).
- **Ranking with allies**: `draft = median counter advantage + 0.5 × median synergy` (`APP_CONFIG.scoring.wSynergy`) — synergy is usually smaller and noisier, the main question stays "who beats the enemy". Strict coverage applies to allies too. Without allies the ranking is exactly the counterpick ranking. With allies but no enemies, heroes are ranked by synergy alone.
- **Ban suggestions** (`src/scoring/bans.ts`): `ban = median advantage of the hero against your heroes + 0.5 × median synergy with the enemy heroes`; top 8, not role-specific, never a picked or banned hero. Click one to ban it.
- Bans are excluded from recommendations and from ban suggestions. All three lists are in the shareable link (`ally=`, `ban=`).

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
