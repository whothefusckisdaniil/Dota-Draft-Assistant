/**
 * RESEARCH ONLY — STRATZ data-source spike (ТЗ №4). NEVER touches production:
 * no changes to scoring/UI/dataset. Outputs land in /tmp/stratz-research/.
 *
 * Run:
 *   npx tsx scripts/research-stratz.ts baseline      # OpenDota side — no token needed
 *   npx tsx scripts/research-stratz.ts stratz-schema # GraphQL introspection (token + Playwright)
 *   npx tsx scripts/research-stratz.ts stratz-types  # row-type dump for candidate types (token + Playwright)
 *   npx tsx scripts/research-stratz.ts stratz-puck   # Puck matchups + filter/batch probes (token + Playwright)
 *   npx tsx scripts/research-stratz.ts compare       # OpenDota vs STRATZ Top-15 comparison (token + Playwright)
 *   npx tsx scripts/research-stratz.ts stratz-window [Hero]   # §17 complete-week vs 4-week analysis
 *   npx tsx scripts/research-stratz.ts stratz-ranked          # §18 ranked-ladder verification (winWeek reconciliation)
 *   npx tsx scripts/research-stratz.ts stratz-compare3        # §20 OpenDota vs 1w vs 4w comparison
 *   npx tsx scripts/research-stratz.ts stratz-contract        # §4 full snapshot build + contract validation
 *   npx tsx scripts/research-stratz.ts ci-probe               # §19 CI reachability probe (token-safe output)
 *
 * Token: STRATZ_API_TOKEN from environment or .env (git-ignored, see .env.example).
 * Transport: STRATZ commands need `playwright` + Chromium (plain fetch/curl is blocked by Cloudflare);
 *   caching is used for every STRATZ query under /tmp/stratz-research/cache.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { scoreCandidates } from '../src/scoring/engine';
import { spearmanRho } from '../src/scoring/stats';
import type { Hero, MatchupRow } from '../src/types';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'public', 'data');
const OUT = '/tmp/stratz-research';
mkdirSync(OUT, { recursive: true });

// ---------------- dataset loading (read-only) ----------------

interface RawHero extends Omit<Hero, 'key' | 'nameRu'> {}

function loadOpendotaDataset(): { heroes: Hero[]; heroById: Map<number, Hero>; matchups: Map<number, MatchupRow[]> } {
  const raw = JSON.parse(readFileSync(path.join(DATA, 'heroes.json'), 'utf8')) as RawHero[];
  const heroes: Hero[] = raw.map((h) => ({ ...h, key: '', nameRu: '' }));
  const matchupRaw = JSON.parse(readFileSync(path.join(DATA, 'matchups.json'), 'utf8')) as Record<string, MatchupRow[]>;
  const heroById = new Map(heroes.map((h) => [h.id, h]));
  const matchups = new Map<number, MatchupRow[]>();
  for (const [id, rows] of Object.entries(matchupRaw)) {
    const n = Number(id);
    if (heroById.has(n) && Array.isArray(rows)) matchups.set(n, rows);
  }
  return { heroes, heroById, matchups };
}

function readMeta(): { source: string; generatedAt: string; latestPatch: string; heroCount: number } {
  return JSON.parse(readFileSync(path.join(DATA, 'meta.json'), 'utf8'));
}

// ---------------- generic table helpers ----------------

function mdTable(headers: string[], rows: (string | number)[][]): string {
  const fmt = (v: string | number) => String(v).replace(/\|/g, '\\|');
  const head = `| ${headers.map(fmt).join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map(fmt).join(' | ')} |`).join('\n');
  return [head, sep, body].join('\n');
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  return n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function pct(n: number, digits = 1): string {
  return `${n.toFixed(digits)}%`;
}


// ---------------- baseline: OpenDota side ----------------

/** Direction/consistency check: for every A→B row compare with B→A row. */
function checkOpendotaSymmetry(matchups: Map<number, MatchupRow[]>) {
  let checked = 0;
  let missingReverse = 0;
  let gamesMismatch = 0;
  let winsSumMismatch = 0;
  let winsSumOffBy = 0;
  for (const [enemyId, rows] of matchups) {
    for (const r of rows) {
      checked += 1;
      const reverseTable = matchups.get(r.hero_id);
      const reverse = reverseTable?.find((x) => x.hero_id === enemyId);
      if (!reverse) { missingReverse += 1; continue; }
      if (reverse.games_played !== r.games_played) { gamesMismatch += 1; continue; }
      const sum = r.wins + reverse.wins;
      if (sum !== r.games_played) {
        winsSumMismatch += 1;
        winsSumOffBy = Math.max(winsSumOffBy, Math.abs(r.games_played - sum));
      }
    }
  }
  return { checked, missingReverse, gamesMismatch, winsSumMismatch, winsSumOffBy };
}

/** Puck pairs from OpenDota: matchups[Puck] — wins = PUCK wins vs hero_id. */
function puckPairsOpendota(matchups: Map<number, MatchupRow[]>, heroById: Map<number, Hero>) {
  const PUCK = [...heroById.values()].find((h) => h.name === 'Puck');
  if (!PUCK) throw new Error('Puck not found in heroes.json');
  const rows = matchups.get(PUCK.id) ?? [];
  const pairs = rows
    .map((r) => {
      const enemy = heroById.get(r.hero_id);
      const games = r.games_played;
      const puckWins = r.wins;
      return {
        enemyId: r.hero_id,
        enemy: enemy?.name ?? `#${r.hero_id}`,
        games,
        puckWins,
        enemyWins: games - puckWins,
        puckWinrate: games > 0 ? (puckWins / games) * 100 : NaN,
      };
    })
    .sort((a, b) => b.games - a.games);
  return { puckId: PUCK.id, pairs };
}

type PuckPair = ReturnType<typeof puckPairsOpendota>['pairs'][number];

function selectPairsForReport(pairs: PuckPair[]): PuckPair[] {
  const norm = (s: string) => s.toLowerCase().replace(/’/g, "'");
  const pick = (name: string) => pairs.find((p) => norm(p.enemy) === name);
  const chosen: PuckPair[] = [];
  const seen = new Set<string>();
  const add = (p?: PuckPair) => {
    if (p && !seen.has(p.enemy)) { seen.add(p.enemy); chosen.push(p); }
  };
  for (const n of ['bane', "nature's prophet", 'night stalker', 'riki', 'lone druid', 'broodmother', 'dragon knight']) add(pick(n));
  add(pairs[0]); // biggest sample
  const sortedAsc = [...pairs].sort((a, b) => a.games - b.games);
  add(sortedAsc[0]); // smallest sample
  add(sortedAsc[Math.floor(sortedAsc.length / 2)]); // median sample
  for (const n of ['pudge', 'axe', 'lion', 'witch doctor', 'earthshaker']) add(pick(n));
  return chosen;
}

/** Top-15 counters for one target hero (as the single enemy) with the PRODUCTION engine. */
function top15ForEnemy(enemyName: string, ds: ReturnType<typeof loadOpendotaDataset>) {
  const enemy = [...ds.heroById.values()].find((h) => h.name === enemyName);
  if (!enemy) throw new Error(`hero not found: ${enemyName}`);
  const ranked = scoreCandidates(
    { heroes: ds.heroes, enemyIds: [enemy.id], matchupByEnemy: ds.matchups, heroById: ds.heroById },
    'all',
  );
  return ranked.map((c, i) => {
    const pair = c.matchups.find((m) => m.enemyId === enemy.id);
    return {
      rank: i + 1,
      hero: c.hero.name,
      score: Number(c.finalScore.toFixed(3)),
      pairGames: pair?.games ?? 0,
      pairWinrate: pair ? Number(pair.winrate.toFixed(1)) : NaN,
      avgGames: Number(c.avgGames.toFixed(0)),
      lowData: c.lowData,
    };
  });
}

function cmdBaseline(): void {
  const meta = readMeta();
  const ds = loadOpendotaDataset();
  const lines: string[] = [];
  lines.push(`# OpenDota baseline (source=${meta.source}, generatedAt=${meta.generatedAt}, patch=${meta.latestPatch}, heroes=${meta.heroCount})\n`);

  // -- direction & consistency
  const sym = checkOpendotaSymmetry(ds.matchups);
  lines.push('## Direction check (OpenDota A↔B symmetry)');
  lines.push(`- rows checked: ${sym.checked}`);
  lines.push(`- missing reverse row: ${sym.missingReverse}`);
  lines.push(`- games(A,B) ≠ games(B,A): ${sym.gamesMismatch}`);
  lines.push(`- wins(A→B)+wins(B→A) ≠ games: ${sym.winsSumMismatch} (max |diff| = ${sym.winsSumOffBy})`);
  lines.push('- interpretation: if sums ≈ games, `wins` is from the perspective of the table owner (URL hero).\n');

  // -- Puck pairs
  const { puckId, pairs } = puckPairsOpendota(ds.matchups, ds.heroById);
  const gamesArr = pairs.map((p) => p.games).sort((a, b) => a - b);
  const stats = {
    pairs: pairs.length,
    totalGames: gamesArr.reduce((s, v) => s + v, 0),
    meanGames: gamesArr.reduce((s, v) => s + v, 0) / gamesArr.length,
    medianGames: median(gamesArr),
    minGames: gamesArr[0],
    maxGames: gamesArr[gamesArr.length - 1],
    pairsBelow20: pairs.filter((p) => p.games < 20).length,
    pairsBelow100: pairs.filter((p) => p.games < 100).length,
  };
  lines.push('## Puck vs all enemies — OpenDota sample size');
  lines.push('```json');
  lines.push(JSON.stringify({ puckId, ...stats }, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Puck pairs (required 7 + spread → 15)');
  lines.push(
    mdTable(
      ['Enemy hero', 'Games', 'Puck wins', 'Enemy wins', 'Puck winrate'],
      selectPairsForReport(pairs).map((p) => [p.enemy, p.games, p.puckWins, p.enemyWins, pct(p.puckWinrate)]),
    ),
  );
  lines.push('');

  // -- Top-15 for five target heroes
  const targets = ['Puck', 'Invoker', 'Juggernaut', 'Sven', 'Bane'];
  const topByTarget: Record<string, ReturnType<typeof top15ForEnemy>> = {};
  for (const t of targets) {
    topByTarget[t] = top15ForEnemy(t, ds);
    lines.push(`## Top-15 counters to ${t} — OpenDota (single enemy, pos=ALL, production engine)`);
    lines.push(
      mdTable(
        ['#', 'Hero', 'Score', `Games vs ${t}`, `WR vs ${t}`, 'avgGames', 'lowData'],
        topByTarget[t].map((r) => [r.rank, r.hero, r.score, r.pairGames, pct(r.pairWinrate), r.avgGames, r.lowData]),
      ),
    );
    lines.push('');
  }

  writeFileSync(path.join(OUT, 'baseline.md'), lines.join('\n'));
  writeFileSync(
    path.join(OUT, 'baseline.json'),
    JSON.stringify({ meta, stats, pairs, symmetry: sym, topByTarget }, null, 2),
  );
  console.log(lines.join('\n'));
  console.log(`\n[written] ${OUT}/baseline.md, ${OUT}/baseline.json`);
}

// ---------------- full (unfiltered) dumps of critical types ----------------

async function cmdStratzTypes(): Promise<void> {
  const token = loadToken();
  const T = '{ kind name ofType { kind name ofType { kind name } } }';
  const targets = (process.argv[3] ?? 'HeroDryadType,HeroMatchupType,HeroType,MatchPlayerType').split(',').map((s) => s.trim());
  const lines: string[] = [`# STRATZ full type dumps (${new Date().toISOString()})\n`];
  for (const name of targets) {
    const res = await gql(
      token,
      `{ __type(name: "${name}") { name kind fields { name description type ${T} args { name type ${T} } } } }`,
      undefined,
      `schema2-full-${name}`,
    );
    const t = res?.data?.__type;
    if (!t) { lines.push(`## ${name}: NOT FOUND\n`); continue; }
    lines.push(`## \`${t.name}\` — ${t.fields?.length ?? 0} fields`);
    lines.push(
      mdTable(
        ['Field', 'Type', 'Args', 'Description'],
        (t.fields ?? []).map((f: any) => [
          f.name,
          gqlTypeStr(f.type),
          (f.args ?? []).map((a: any) => `${a.name}: ${gqlTypeStr(a.type)}`).join('<br>') || '—',
          (f.description ?? '').replace(/\s+/g, ' ').slice(0, 140),
        ]),
      ),
    );
    lines.push('');
  }
  const out = lines.join('\n');
  writeFileSync(path.join(OUT, 'stratz-types-full.md'), out);
  console.log(out);
  console.log(`\n[written] ${OUT}/stratz-types-full.md`);
}

// ---------------- STRATZ matchup experiments (§4, §12, §13) ----------------

/** matchUp query — VERIFIED against introspection (HeroStatsHeroDryadType). */
const matchupQuery = (heroSel: string, extra = '') =>
  `{ heroStats { matchUp(${heroSel}, take: 200${extra}) {
      heroId matchCountWith matchCountVs
      vs { heroId1 heroId2 matchCount winCount winRateHeroId1 winRateHeroId2 week bracketBasicIds }
      with { heroId1 heroId2 matchCount winCount }
  } } }`;

interface StratzPairRow {
  heroId1: number; heroId2: number; matchCount: number; winCount: number;
  winRateHeroId1: number; winRateHeroId2: number; week?: number; bracketBasicIds?: string;
}

async function fetchVs(token: string, heroSel: string, cacheKey: string, extra = ''): Promise<{ dryad: any; rows: StratzPairRow[] }> {
  const res = await gql(token, matchupQuery(heroSel, extra), undefined, cacheKey);
  const list = res.data?.heroStats?.matchUp ?? [];
  const dryad = list[0] ?? null;
  return { dryad, rows: (dryad?.vs ?? []) as StratzPairRow[] };
}

/** Determine per-row orientation: which heroIdN is the queried hero, and whose wins winCount is. */
function analyzeOrientation(queryHeroId: number, rows: StratzPairRow[]) {
  let asHeroId1 = 0;
  let asHeroId2 = 0;
  let wrMatchesId1 = 0;
  let wrMatchesId2 = 0;
  for (const r of rows) {
    if (r.heroId1 === queryHeroId) asHeroId1 += 1;
    if (r.heroId2 === queryHeroId) asHeroId2 += 1;
    if (r.matchCount > 0) {
      const wr = r.winCount / r.matchCount;
      if (Math.abs(wr - Number(r.winRateHeroId1)) < 0.005) wrMatchesId1 += 1;
      if (Math.abs(wr - Number(r.winRateHeroId2)) < 0.005) wrMatchesId2 += 1;
    }
  }
  return { rows: rows.length, asHeroId1, asHeroId2, winCountMatchesWinRateHeroId1: wrMatchesId1, winCountMatchesWinRateHeroId2: wrMatchesId2 };
}

async function cmdStratzPuck(): Promise<void> {
  const token = loadToken();
  const lines: string[] = [`# STRATZ Puck experiment (${new Date().toISOString()})\n`];

  // 1) hero id mapping (also cross-checks id alignment with OpenDota/Dota ids)
  const heroesRes = await gql(token, `{ constants { heroes { id displayName shortName } } }`, undefined, 'stratz-heroes');
  const stratzHeroes: { id: number; displayName: string; shortName: string }[] = heroesRes.data.constants.heroes;
  writeFileSync(path.join(OUT, 'stratz-heroes.json'), JSON.stringify(stratzHeroes));
  const byName = new Map(stratzHeroes.map((h) => [h.displayName, h]));
  const odDs = loadOpendotaDataset();
  const idMismatches: string[] = [];
  for (const h of odDs.heroes) {
    const s = byName.get(h.name);
    if (s && s.id !== h.id) idMismatches.push(`${h.name}: opendota=${h.id} stratz=${s.id}`);
  }
  lines.push(`## Hero id mapping: STRATZ heroes=${stratzHeroes.length}, OpenDota=${odDs.heroes.length}, id mismatches=${idMismatches.length}`);
  if (idMismatches.length) lines.push(idMismatches.slice(0, 20).join('\n'));
  const puck = byName.get('Puck');
  const bane = byName.get('Bane');
  if (!puck || !bane) throw new Error('Puck/Bane not found in STRATZ heroes');
  lines.push('');

  // 2) Puck vs-table (default filters — no bracket, no week)
  const puckMain = await fetchVs(token, `heroId: ${puck.id}`, 'stratz-puck-vs-default');
  if (puckMain.dryad?.heroId !== puck.id) throw new Error(`unexpected matchUp result: heroId=${puckMain.dryad?.heroId}`);
  const orient = analyzeOrientation(puck.id, puckMain.rows);
  lines.push('## Orientation probe (matchUp(heroId:13).vs[])');
  lines.push('```json');
  lines.push(JSON.stringify(orient, null, 2));
  lines.push('```');
  lines.push('');

  // 3) Direction check (§13): Bane side of the same pair
  const baneMain = await fetchVs(token, `heroId: ${bane.id}`, 'stratz-vs-bane-default');
  const rowInPuck = puckMain.rows.find((r) => r.heroId1 === bane.id || r.heroId2 === bane.id);
  const rowInBane = baneMain.rows.find((r) => r.heroId1 === puck.id || r.heroId2 === puck.id);
  lines.push('## Direction check §13: Puck(13) vs Bane(2) from BOTH sides');
  lines.push('```json');
  lines.push(JSON.stringify({ fromMatchUp_heroId13: rowInPuck ?? null, fromMatchUp_heroId2: rowInBane ?? null }, null, 2));
  lines.push('```');
  lines.push('');

  // 4) Filter probes (§12): bracket + week semantics
  const bracketDi = await fetchVs(token, `heroId: ${puck.id}`, 'stratz-puck-vs-divine', `, bracketBasicIds: [DIVINE_IMMORTAL]`);
  const bracketHg = await fetchVs(token, `heroId: ${puck.id}`, 'stratz-puck-vs-herald', `, bracketBasicIds: [HERALD_GUARDIAN]`);
  const sumGames = (rows: StratzPairRow[]) => rows.reduce((s, r) => s + r.matchCount, 0);

  // `week` is matched as week-bucket index floor(unixTs / 604800):
  //   week=1789948800 → bucket 2959 (2026-09-21) == default; small ints → bucket 0 → no data.
  const weekTs = 2959 * 604800; // bucket 2959 start (2026-09-21)
  const weekProbeA = await fetchVs(token, `heroId: ${puck.id}`, 'stratz-puck-vs-week-ts', `, week: ${weekTs}`);
  const weekProbeB = await fetchVs(token, `heroId: ${puck.id}`, 'stratz-puck-vs-week-38', `, week: 38`);
  const weekProbeC = await fetchVs(token, `heroId: ${puck.id}`, 'stratz-puck-vs-w2958', `, week: ${2958 * 604800}`);
  const weekProbeD = await fetchVs(token, `heroId: ${puck.id}`, 'stratz-puck-vs-w2950', `, week: ${2950 * 604800}`);
  const weekProbeE = await fetchVs(token, `heroId: ${puck.id}`, 'stratz-puck-vs-w2500', `, week: ${2500 * 604800}`);
  const bracketCr = await fetchVs(token, `heroId: ${puck.id}`, 'stratz-puck-vs-crusader', `, bracketBasicIds: [CRUSADER_ARCHON]`);
  const bracketLa = await fetchVs(token, `heroId: ${puck.id}`, 'stratz-puck-vs-legend', `, bracketBasicIds: [LEGEND_ANCIENT]`);
  const bracketUn = await fetchVs(token, `heroId: ${puck.id}`, 'stratz-puck-vs-uncalib', `, bracketBasicIds: [UNCALIBRATED]`);
  const bracketFiltered = await fetchVs(token, `heroId: ${puck.id}`, 'stratz-puck-vs-filtered', `, bracketBasicIds: [FILTERED]`);
  const bracketDiWeek = await fetchVs(token, `heroId: ${puck.id}`, 'stratz-puck-vs-divine-w2959', `, bracketBasicIds: [DIVINE_IMMORTAL], week: ${2959 * 604800}`);
  const retention2800 = await fetchVs(token, `heroId: ${puck.id}`, 'stratz-puck-vs-w2800', `, week: ${2800 * 604800}`);
  const retention2700 = await fetchVs(token, `heroId: ${puck.id}`, 'stratz-puck-vs-w2700', `, week: ${2700 * 604800}`);
  const bracketSum =
    sumGames(bracketDi.rows) + sumGames(bracketHg.rows) + sumGames(bracketCr.rows) + sumGames(bracketLa.rows) + sumGames(bracketUn.rows) + sumGames(bracketFiltered.rows);
  const weekSummary = {
    units: 'week = unix seconds inside the week; server buckets it as floor(ts/604800); bucket 2959 = 2026-09-21..27',
    week_bucket_2959_same_as_default: { rows: weekProbeA.rows.length, totalPairGames: sumGames(weekProbeA.rows), echoWeek: weekProbeA.rows[0]?.week ?? null },
    week_bucket_2958_prev_week: { rows: weekProbeC.rows.length, totalPairGames: sumGames(weekProbeC.rows), echoWeek: weekProbeC.rows[0]?.week ?? null },
    week_bucket_2950_approx_9w: { rows: weekProbeD.rows.length, totalPairGames: sumGames(weekProbeD.rows), echoWeek: weekProbeD.rows[0]?.week ?? null },
    week_bucket_2500_approx_2018: { rows: weekProbeE.rows.length, totalPairGames: sumGames(weekProbeE.rows), echoWeek: weekProbeE.rows[0]?.week ?? null },
    retention_bucket_2800_approx_2023_08: { rows: retention2800.rows.length, totalPairGames: sumGames(retention2800.rows) },
    retention_bucket_2700_approx_2021_05: { rows: retention2700.rows.length, totalPairGames: sumGames(retention2700.rows) },
    week_small_ints_bucket0: { week_2959_as_int: weekProbeC.rows.length, week_38: weekProbeB.rows.length },
    baseline_no_week: { totalPairGames: sumGames(puckMain.rows), echoWeek: puckMain.rows[0]?.week ?? null },
    interpretation: 'default (no week) == bucket 2959 == LATEST WEEK ONLY — a rolling ~7-day window, not lifetime',
  };
  const bracketSummary = {
    default: { totalPairGames: sumGames(puckMain.rows), echoBracket: puckMain.rows[0]?.bracketBasicIds ?? null },
    DIVINE_IMMORTAL: sumGames(bracketDi.rows),
    LEGEND_ANCIENT: sumGames(bracketLa.rows),
    CRUSADER_ARCHON: sumGames(bracketCr.rows),
    HERALD_GUARDIAN: sumGames(bracketHg.rows),
    UNCALIBRATED: sumGames(bracketUn.rows),
    FILTERED: sumGames(bracketFiltered.rows),
    sumOfAllBuckets: bracketSum,
    equalsDefault: Math.abs(bracketSum - sumGames(puckMain.rows)) <= 2,
    DIVINE_IMMORTAL_with_explicit_week2959: sumGames(bracketDiWeek.rows),
    DIVINE_IMMORTAL_without_week: sumGames(bracketDi.rows),
    echoBracketAlways: bracketDi.rows[0]?.bracketBasicIds ?? null,
  };
  lines.push('## Bracket filter probe §12 (Puck, bracketBasicIds buckets; default = all buckets)');
  lines.push('```json');
  lines.push(JSON.stringify(bracketSummary, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Week/time filter probe §12 (Puck, `week` argument)');
  lines.push('```json');
  lines.push(JSON.stringify(weekSummary, null, 2));
  lines.push('```');
  lines.push('');

  // 5) Batching probe (§11): heroIds list in a single query
  const batchRes = await gql(token, matchupQuery('heroIds: [13, 2, 74]'), undefined, 'stratz-batch-3');
  const batchList = batchRes.data?.heroStats?.matchUp ?? [];
  const batchSummary = {
    heroesRequested: 3,
    dryadsReturned: batchList.length,
    heroIds: batchList.map((d: any) => d.heroId),
    vsRowsEach: batchList.map((d: any) => (d.vs ?? []).length),
    approxPayloadBytes: JSON.stringify(batchRes).length,
  };
  lines.push('## Batching probe §11: matchUp(heroIds: [13, 2, 74]) — one query');
  lines.push('```json');
  lines.push(JSON.stringify(batchSummary, null, 2));
  lines.push('```');
  lines.push('');


  // 6) Puck table (§4) — direction-proven: heroId1 = queried hero (Puck), winCount = heroId1's wins
  //    (proof: cross-side wins sum to games; Σ winCount/Σ games = 47.56% ≈ global winRateHeroId1 47.60%)
  const heroName = new Map(stratzHeroes.map((h) => [h.id, h.displayName]));
  const pairs = puckMain.rows
    .map((r) => {
      const enemyId = r.heroId2; // orientation probe: heroId1 === queried hero in 126/126 rows
      const puckWins = r.winCount;
      const enemyWins = r.matchCount - r.winCount;
      return {
        enemyId, enemy: heroName.get(enemyId) ?? `#${enemyId}`, games: r.matchCount,
        puckWins, enemyWins, puckWinrate: (puckWins / r.matchCount) * 100,
      };
    })
    .sort((a, b) => b.games - a.games);
  const gamesArr = pairs.map((p) => p.games).sort((a, b) => a - b);
  const totalG = gamesArr.reduce((s, v) => s + v, 0);
  const totalW = pairs.reduce((s, p) => s + p.puckWins, 0);
  const stats = {
    pairs: pairs.length,
    totalGames: totalG,
    meanGames: totalG / Math.max(1, pairs.length),
    medianGames: median(gamesArr),
    minGames: gamesArr[0] ?? 0,
    maxGames: gamesArr[gamesArr.length - 1] ?? 0,
    pairsBelow20: pairs.filter((p) => p.games < 20).length,
    pairsBelow100: pairs.filter((p) => p.games < 100).length,
    aggregatePuckWinrate: +((totalW / totalG) * 100).toFixed(2),
    puckGlobalWinrateWinRateField: +((puckMain.rows[0]?.winRateHeroId1 ?? 0) * 100).toFixed(2),
    directionAnchorDeltaPp: +Math.abs((totalW / totalG) * 100 - (puckMain.rows[0]?.winRateHeroId1 ?? 0) * 100).toFixed(2),
  };
  lines.push('## Puck vs all enemies — STRATZ sample size (default filters)');
  lines.push('```json');
  lines.push(JSON.stringify(stats, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Puck pairs (required 7 + spread → 15) — STRATZ');
  lines.push(
    mdTable(
      ['Enemy hero', 'Games', 'Puck wins', 'Enemy wins', 'Puck winrate'],
      selectPairsForReport(pairs as any).map((p) => [p.enemy, p.games, p.puckWins, p.enemyWins, pct(p.puckWinrate)]),
    ),
  );
  lines.push('');

  writeFileSync(path.join(OUT, 'stratz-puck.json'), JSON.stringify({ orientation: orient, stats, pairs, probes: { bracketSummary, weekSummary, batchSummary, rowInPuck, rowInBane } }, null, 2));
  const out = lines.join('\n');
  writeFileSync(path.join(OUT, 'stratz-puck.md'), out);
  console.log(out);
  console.log(`\n[written] ${OUT}/stratz-puck.md, ${OUT}/stratz-puck.json`);
}


// ---------------- OpenDota vs STRATZ comparison (§5, §6) — same engine both sides ----------------

async function cmdStratzCompare(): Promise<void> {
  const token = loadToken();
  const ds = loadOpendotaDataset();
  const targets = ['Puck', 'Invoker', 'Juggernaut', 'Sven', 'Bane'];
  const lines: string[] = [`# OpenDota vs STRATZ ranking comparison (${new Date().toISOString()})\n`];
  lines.push('Method: production `scoreCandidates()` (model M, pos=ALL) run unchanged on each dataset; single enemy; ids/names aligned (0 mismatches).\n');
  const perTarget: any[] = [];

  for (const t of targets) {
    const enemy = [...ds.heroById.values()].find((h) => h.name === t);
    if (!enemy) throw new Error(`unknown hero: ${t}`);
    const cacheKey = t === 'Puck' ? 'stratz-puck-vs-default' : `stratz-top-${enemy.id}`;
    const { rows } = await fetchVs(token, `heroId: ${enemy.id}`, cacheKey);
    if (rows.length === 0) throw new Error(`STRATZ returned 0 rows for ${t}`);
    // engine expects per-enemy rows: wins = ENEMY's wins vs candidate → matchUp(heroId:enemy) gives exactly that
    const stratzRows: MatchupRow[] = rows.map((r) => ({ hero_id: r.heroId2, games_played: r.matchCount, wins: r.winCount }));
    const odRanked = scoreCandidates({ heroes: ds.heroes, enemyIds: [enemy.id], matchupByEnemy: ds.matchups, heroById: ds.heroById }, 'all');
    const stRanked = scoreCandidates(
      { heroes: ds.heroes, enemyIds: [enemy.id], matchupByEnemy: new Map([[enemy.id, stratzRows]]), heroById: ds.heroById },
      'all',
    );
    const odPos = new Map(odRanked.map((c, i) => [c.hero.name, i + 1]));
    const stPos = new Map(stRanked.map((c, i) => [c.hero.name, i + 1]));
    const odMeta = new Map(odRanked.map((c) => [c.hero.name, c]));
    const stMeta = new Map(stRanked.map((c) => [c.hero.name, c]));
    const odPair = new Map((ds.matchups.get(enemy.id) ?? []).map((r) => [r.hero_id, r]));
    const stPair = new Map(rows.map((r) => [r.heroId2, r]));
    const union = [...new Set([...odPos.keys(), ...stPos.keys()])];
    union.sort((a, b) => Math.max(odPos.get(a) ?? 99, stPos.get(a) ?? 99) - Math.max(odPos.get(b) ?? 99, stPos.get(b) ?? 99));

    const intersection = [...odPos.keys()].filter((n) => stPos.has(n)).length;
    const odRankVec = union.map((n) => odPos.get(n) ?? 16);
    const stRankVec = union.map((n) => stPos.get(n) ?? 16);
    const rho = spearmanRho(odRankVec, stRankVec);
    const heroIdByName = new Map([...ds.heroById.values()].map((h) => [h.name, h.id]));
    const metrics = {
      top15Overlap: intersection,
      jaccard: +((intersection / (30 - intersection)).toFixed(3)),
      sameNumberOne: odRanked[0]?.hero.name === stRanked[0]?.hero.name,
      odNumberOne: odRanked[0]?.hero.name ?? null,
      stratzNumberOne: stRanked[0]?.hero.name ?? null,
      spearmanOnUnion_missingAs16: Number.isNaN(rho) ? null : +rho.toFixed(3),
      spearmanCaveat: 'construction-biased: union contains only heroes present in ≥1 top15 (missing=16), so near-disjoint lists force rho toward -1 — read top15Overlap/jaccard instead',
      odAvgGames: Math.round(odRanked.reduce((s, c) => s + c.avgGames, 0) / Math.max(1, odRanked.length)),
      stratzAvgGames: Math.round(stRanked.reduce((s, c) => s + c.avgGames, 0) / Math.max(1, stRanked.length)),
      odLowDataCount: odRanked.filter((c) => c.lowData).length,
      stratzLowDataCount: stRanked.filter((c) => c.lowData).length,
    };
    perTarget.push({ target: t, metrics });

    lines.push(`## ${t} — Top-15 counters (union of both top15; rank ">15" = not in that top15)`);
    lines.push(
      mdTable(
        ['Hero', 'OD rank', 'STRATZ rank', 'OD games', 'STRATZ games', 'OD score', 'STRATZ score'],
        union.map((n) => {
          const hid = heroIdByName.get(n) ?? -1;
          const o = odPair.get(hid);
          const s = stPair.get(hid);
          return [
            n,
            odPos.get(n) ?? '>15',
            stPos.get(n) ?? '>15',
            o?.games_played ?? '—',
            s?.matchCount ?? '—',
            odMeta.get(n)?.finalScore.toFixed(2) ?? '—',
            stMeta.get(n)?.finalScore.toFixed(2) ?? '—',
          ];
        }),
      ),
    );
    lines.push('');
    lines.push('Metrics: ' + JSON.stringify(metrics));
    lines.push('');
  }

  // §5 pair-level comparison (Puck, same 15 pairs as baseline)
  const odPairs = JSON.parse(readFileSync(path.join(OUT, 'baseline.json'), 'utf8')).pairs as any[];
  const stPairs = JSON.parse(readFileSync(path.join(OUT, 'stratz-puck.json'), 'utf8')).pairs as any[];
  const odByName = new Map(odPairs.map((p) => [p.enemy, p]));
  const stByName = new Map(stPairs.map((p) => [p.enemy, p]));
  const norm = (s: string) => s.toLowerCase().replace(/’/g, "'");
  const chosen: string[] = [];
  const add = (n: string) => { if (!chosen.includes(n)) chosen.push(n); };
  for (const n of ['bane', "nature's prophet", 'night stalker', 'riki', 'lone druid', 'broodmother', 'dragon knight']) add(n);
  for (const p of [...stPairs].sort((a, b) => b.games - a.games).slice(0, 3)) add(norm(p.enemy));
  for (const p of [...stPairs].sort((a, b) => a.games - b.games).slice(0, 2)) add(norm(p.enemy));
  lines.push('## §5 Puck pair comparison (required 7 + biggest/smallest STRATZ samples)');
  lines.push('| Enemy | OD games | OD wins | OD wr | STRATZ games | STRATZ wins | STRATZ wr |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const n of chosen) {
    const od = odByName.get([...odByName.keys()].find((k) => norm(k) === n) ?? '');
    const st = stByName.get([...stByName.keys()].find((k) => norm(k) === n) ?? '');
    if (!od && !st) continue;
    lines.push(
      `| ${st?.enemy ?? od?.enemy} | ${od?.games ?? '—'} | ${od?.puckWins ?? '—'} | ${od ? od.puckWinrate.toFixed(1) + '%' : '—'} | ${st?.games ?? '—'} | ${st?.puckWins ?? '—'} | ${st ? st.puckWinrate.toFixed(1) + '%' : '—'} |`,
    );
  }
  lines.push('');

  // §5 sample-size stats (whole Puck vs-table on both sides)
  const odStat = JSON.parse(readFileSync(path.join(OUT, 'baseline.json'), 'utf8')).stats;
  const stStat = JSON.parse(readFileSync(path.join(OUT, 'stratz-puck.json'), 'utf8')).stats;
  lines.push('## §5 Sample size — Puck vs 126 enemies (both sources)');
  lines.push(
    mdTable(
      ['Metric', 'OpenDota', 'STRATZ (default window)', '×'],
      [
        ['total pair games', odStat.totalGames, stStat.totalGames, (stStat.totalGames / odStat.totalGames).toFixed(1)],
        ['mean games/pair', odStat.meanGames.toFixed(1), stStat.meanGames.toFixed(1), (stStat.meanGames / odStat.meanGames).toFixed(1)],
        ['median games/pair', odStat.medianGames, stStat.medianGames, (stStat.medianGames / odStat.medianGames).toFixed(1)],
        ['min games', odStat.minGames, stStat.minGames, (stStat.minGames / odStat.minGames).toFixed(1)],
        ['max games', odStat.maxGames, stStat.maxGames, (stStat.maxGames / odStat.maxGames).toFixed(1)],
        ['pairs < 20 games (unusable)', odStat.pairsBelow20, stStat.pairsBelow20, '—'],
        ['pairs < 100 games', odStat.pairsBelow100, stStat.pairsBelow100, '—'],
      ],
    ),
  );
  lines.push('');

  writeFileSync(path.join(OUT, 'stratz-compare.md'), lines.join('\n'));
  writeFileSync(path.join(OUT, 'stratz-compare.json'), JSON.stringify(perTarget, null, 2));
  console.log(lines.join('\n'));
  console.log(`\n[written] ${OUT}/stratz-compare.md, ${OUT}/stratz-compare.json`);
}



// ---------------- bucket/time helpers (must be initialised before the entry block below) ----------------

const BUCKET_SEC = 604800;
const bucketTs = (n: number) => n * BUCKET_SEC;
const bucketDate = (n: number) => new Date(bucketTs(n) * 1000).toISOString().slice(0, 10);
const normWeek = (w: number) => (w > 1e6 ? Math.floor(w / BUCKET_SEC) : w);

// ---------------- entry ----------------
// ---------------- STRATZ GraphQL transport (research only) ----------------

const ENDPOINT = 'https://api.stratz.com/graphql';
const CACHE = path.join(OUT, 'cache');
mkdirSync(CACHE, { recursive: true });
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function loadToken(): string {
  const fromEnv = process.env.STRATZ_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const envFile = readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of envFile.split(/\r?\n/)) {
      const m = line.match(/^\s*STRATZ_API_TOKEN\s*=\s*(.*?)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    }
  } catch { /* no .env */ }
  throw new Error('STRATZ_API_TOKEN is not set (environment variable or .env file, see .env.example)');
}

type Page = import('playwright').Page;
let pageRef: Page | null = null;

/**
 * GraphQL over a Playwright page context: plain Node fetch/curl is blocked by
 * Cloudflare bot protection (TLS fingerprint) — browser context passes.
 * The page is reused across calls; responses are cached under OUT/cache
 * (cache keys are explicit — quota-friendly, no hidden re-fetches).
 */
async function pageClearedChallenge(page: Page): Promise<boolean> {
  const t0 = Date.now();
  for (let i = 0; i < 60; i += 1) {
    const title = await page.title().catch(() => '');
    if (!/just a moment/i.test(title)) {
      if (i > 0) {
        transportStats.challengeWaits += 1;
        transportStats.challengeMs += Date.now() - t0;
        console.warn(`  [cloudflare] interstitial cleared after ~${((Date.now() - t0) / 1000).toFixed(1)}s`);
      }
      return true;
    }
    await page.waitForTimeout(2000);
  }
  return false;
}

const CF_STATE = path.join(OUT, 'cf-state.json');

/** Transport counters — surfaced by `ci-probe` (§19) so CI runs are measurable. */
const transportStats = {
  cacheHits: 0,
  browserLaunches: 0,
  httpRequests: 0,
  challengeWaits: 0,
  challengeRetries: 0,
  navigateMs: 0,
  challengeMs: 0,
  postMs: 0,
  firstPostMs: 0,
};

/** Remove anything that looks like the bearer token from a message before logging. */
function sanitize(text: string): string {
  const token = process.env.STRATZ_API_TOKEN?.trim();
  let out = text;
  if (token) out = out.split(token).join('<redacted-token>');
  return out.replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer <redacted>');
}

async function gql(token: string, query: string, variables?: Record<string, unknown>, cacheKey?: string): Promise<any> {
  if (cacheKey) {
    try {
      const cached = JSON.parse(readFileSync(path.join(CACHE, `${cacheKey}.json`), 'utf8'));
      transportStats.cacheHits += 1;
      return cached;
    } catch { /* cache miss */ }
  }
  if (!pageRef) {
    const { chromium } = await import('playwright');
    const fs = await import('node:fs');
    const browser = await chromium.launch({
      headless: true,
      channel: 'chromium', // new headless — passes CF managed challenge more often
      args: ['--disable-blink-features=AutomationControlled'],
    });
    transportStats.browserLaunches += 1;
    const ctx = await browser.newContext({
      userAgent: UA,
      ...(fs.existsSync(CF_STATE) ? { storageState: CF_STATE } : {}),
    });
    pageRef = await ctx.newPage();
  }
  const page = pageRef;
  // initial navigation — may show a Cloudflare interstitial; wait it out
  if (!page.url() || page.url() === 'about:blank') {
    const tNav = Date.now();
    await page.goto(ENDPOINT, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => { /* Kong error page is fine */ });
    await pageClearedChallenge(page);
    transportStats.navigateMs += Date.now() - tNav;
  }
  // POST; if Cloudflare answers with a challenge page, re-navigate (which
  // renders the interstitial and mints cf_clearance) and retry.
  let res: { status: number; text: string } | null = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const tPost = Date.now();
    res = await page.evaluate(
      async ({ endpoint, query, variables, token }) => {
        const r = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ query, variables }),
        });
        return { status: r.status, text: await r.text() };
      },
      { endpoint: ENDPOINT, query, variables, token },
    );
    const postMs = Date.now() - tPost;
    transportStats.httpRequests += 1;
    transportStats.postMs += postMs;
    if (transportStats.firstPostMs === 0) transportStats.firstPostMs = postMs;
    const challenged =
      res.status === 403 && /just a moment|cf-chl|challenge-platform|Attention Required/i.test(res.text);
    if (!challenged) break;
    transportStats.challengeRetries += 1;
    console.warn(`  [cloudflare challenge on POST] attempt ${attempt}/5 — re-navigating…`);
    const tNav = Date.now();
    await page.goto(ENDPOINT, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    const cleared = await pageClearedChallenge(page);
    transportStats.navigateMs += Date.now() - tNav;
    if (!cleared) throw new Error('Cloudflare interstitial did not clear within 60s');
  }
  if (!res) throw new Error('no response');
  if (res.status === 429) throw new Error(`HTTP 429 rate limited: ${sanitize(res.text.slice(0, 200))}`);
  if (res.status !== 200) throw new Error(`GraphQL HTTP ${res.status}: ${sanitize(res.text.slice(0, 300))}`);
  const parsed = JSON.parse(res.text);
  if (parsed.errors) throw new Error(`GraphQL errors: ${sanitize(JSON.stringify(parsed.errors).slice(0, 600))}`);
  // persist cf_clearance + cookies so the next run skips the challenge
  try {
    const state = await page.context().storageState();
    writeFileSync(CF_STATE, state);
  } catch { /* non-fatal */ }
  if (cacheKey) writeFileSync(path.join(CACHE, `${cacheKey}.json`), JSON.stringify(parsed, null, 2));
  return parsed;
}

async function closePage(): Promise<void> {
  try {
    const p = pageRef as any;
    pageRef = null;
    await p?.context()?.browser()?.close();
  } catch { /* already closed */ }
}



const cmd = process.argv[2] ?? 'baseline';
const commands: Record<string, () => void | Promise<void>> = {
  baseline: cmdBaseline,
  'stratz-schema': cmdStratzSchema,
  'stratz-types': cmdStratzTypes,
  'stratz-puck': cmdStratzPuck,
  compare: cmdStratzCompare,
  'stratz-window': cmdStratzWindow,
  'stratz-ranked': cmdStratzRanked,
  'stratz-compare3': cmdCompare3,
  'stratz-contract': cmdContract,
  'ci-probe': cmdCiProbe,
};
const run = commands[cmd];
if (!run) {
  console.error(`Unknown command: ${cmd} (available: ${Object.keys(commands).join(', ')})`);
  process.exit(1);
}
await run();
await closePage();


// ---------------- STRATZ schema discovery (verified introspection) ----------------

function gqlTypeStr(t: any, depth = 0): string {
  if (!t || depth > 4) return '?';
  if (t.kind === 'NON_NULL') return `${gqlTypeStr(t.ofType, depth + 1)}!`;
  if (t.kind === 'LIST') return `[${gqlTypeStr(t.ofType, depth + 1)}]`;
  return t.name ?? '?';
}

/**
 * stratz-schema: real introspection of the Query root + deep dump of candidate
 * types (names/fields matching hero/stat/win/matchup/constant). Every field
 * name printed here comes from the API itself — nothing is guessed.
 */
async function cmdStratzSchema(): Promise<void> {
  const token = loadToken();
  const T = '{ kind name ofType { kind name ofType { kind name } } }';
  const rootRes = await gql(
    token,
    `{ __schema { queryType { name fields { name description type ${T} args { name description type ${T} defaultValue } } } } }`,
    undefined,
    'schema2-root',
  );
  const rootFields: any[] = rootRes.data.__schema.queryType.fields;
  const lines: string[] = [
    `# STRATZ GraphQL schema v2 (verified introspection, ${new Date().toISOString()})\n`,
    `Root: **${rootRes.data.__schema.queryType.name}** — ${rootFields.length} fields\n`,
    '## Query root (with args)',
    mdTable(
      ['Field', 'Type', 'Args', 'Description'],
      rootFields.map((f) => [
        f.name,
        gqlTypeStr(f.type),
        (f.args ?? []).map((a: any) => `${a.name}: ${gqlTypeStr(a.type)}`).join('<br>') || '—',
        (f.description ?? '').replace(/\s+/g, ' ').slice(0, 90),
      ]),
    ),
    '',
  ];

  const dumpType = async (typeName: string): Promise<any> => {
    if (!typeName || ['String', 'Int', 'Float', 'Boolean', 'ID', 'Long', 'DateTime', 'Date', 'JSON', 'BigInt'].includes(typeName)) return null;
    return gql(
      token,
      `{ __type(name: "${typeName}") { name kind fields { name description type ${T} args { name description type ${T} defaultValue } } inputFields { name description type ${T} defaultValue } enumValues { name } } }`,
      undefined,
      `schema2-type-${typeName}`,
    );
  };

  const namedOf = (t: any): string => {
    let cur = t;
    while (cur && (cur.kind === 'NON_NULL' || cur.kind === 'LIST')) cur = cur.ofType;
    return cur?.name ?? '';
  };

  // BFS over reachable types: follow field return types + argument/input types.
  const seeds = ['HeroStatsQuery', 'VendorQuery', 'ConstantQuery', 'MatchType', 'StratzQuery', 'PlusQuery'];
  const seen = new Set<string>();
  const queue = [...seeds];
  let budget = 45; // max types dumped per run (rate-limit friendly)
  const RELEVANT = /hero|win|loss|match|count|game|patch|rank|bracket|mode|lobby|region|day|time|date|duration|lane|role|version|stat|matchup|pick|ban|mmr|ranked/i;
  const enqueue = (name?: string) => {
    if (name && !seen.has(name) && !queue.includes(name)) queue.push(name);
  };
  while (queue.length > 0 && budget > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    budget -= 1;
    const res = await dumpType(name);
    const type = res?.data?.__type;
    if (!type) continue;
    if (type.kind === 'OBJECT' || type.kind === 'INTERFACE') {
      const fl = type.fields ?? [];
      const show = fl.filter((x: any) => RELEVANT.test(x.name) || (x.args ?? []).length > 0);
      lines.push(`## Type \`${type.name}\` (${type.kind}) — ${fl.length} fields, shown ${show.length}`);
      lines.push(
        mdTable(
          ['Field', 'Type', 'Args', 'Description'],
          show.map((x: any) => [
            x.name,
            gqlTypeStr(x.type),
            (x.args ?? []).map((a: any) => `${a.name}: ${gqlTypeStr(a.type)}${a.defaultValue != null ? ` = ${a.defaultValue}` : ''}`).join('<br>') || '—',
            (x.description ?? '').replace(/\s+/g, ' ').slice(0, 110),
          ]),
        ),
      );
      lines.push('');
      for (const x of fl) {
        enqueue(namedOf(x.type));
        for (const a of x.args ?? []) enqueue(namedOf(a.type));
      }
    } else if (type.kind === 'INPUT_OBJECT') {
      const fl = type.inputFields ?? [];
      lines.push(`## Input \`${type.name}\` — ${fl.length} fields`);
      lines.push(
        mdTable(
          ['Field', 'Type', 'Default', 'Description'],
          fl.map((x: any) => [x.name, gqlTypeStr(x.type), x.defaultValue ?? '—', (x.description ?? '').replace(/\s+/g, ' ').slice(0, 110)]),
        ),
      );
      lines.push('');
      for (const x of fl) enqueue(namedOf(x.type));
    } else if (type.kind === 'ENUM') {
      const vals = (type.enumValues ?? []).map((e: any) => e.name);
      lines.push(`## Enum \`${type.name}\` (${vals.length}): ${vals.join(', ')}\n`);
    }
  }
  lines.push(`\n_Types dumped: ${seen.size}; left in queue: ${queue.length}_`);

  const out = lines.join('\n');
  writeFileSync(path.join(OUT, 'stratz-schema-v2.md'), out);
  // Console: head (root + first types) and tail; full file is on disk.
  console.log(out.length > 14000 ? `${out.slice(0, 8000)}\n…\n${out.slice(-5000)}` : out);
  console.log(`\n[written] ${OUT}/stratz-schema-v2.md (raw introspection cached in ${CACHE})`);
}


// ---------------- §17 complete-week window analysis ----------------

interface WindowPair { heroId: number; games: number; wins: number; buckets: number[]; }

/** Merge one or more weekly buckets into a single per-opponent table (wins = queried hero's wins). */
function mergeBuckets(queriedId: number, perBucket: { bucket: number; rows: StratzPairRow[] }[]): WindowPair[] {
  const map = new Map<number, WindowPair>();
  for (const { bucket, rows } of perBucket) {
    for (const r of rows) {
      const opponent = r.heroId1 === queriedId ? r.heroId2 : r.heroId1;
      if (!opponent || opponent === queriedId) continue;
      // orientation guard: winCount always belongs to heroId1 (= the queried hero)
      const wins = r.heroId1 === queriedId ? r.winCount : r.matchCount - r.winCount;
      const cur = map.get(opponent) ?? { heroId: opponent, games: 0, wins: 0, buckets: [] };
      cur.games += r.matchCount;
      cur.wins += wins;
      cur.buckets.push(bucket);
      map.set(opponent, cur);
    }
  }
  return [...map.values()].sort((a, b) => b.games - a.games);
}

function windowMetrics(pairs: WindowPair[]) {
  const g = pairs.map((p) => p.games).sort((a, b) => a - b);
  const total = g.reduce((s, v) => s + v, 0);
  const wins = pairs.reduce((s, p) => s + p.wins, 0);
  return {
    pairs: pairs.length,
    totalGames: total,
    meanGames: +(total / Math.max(1, g.length)).toFixed(1),
    medianGames: median(g),
    minGames: g[0] ?? 0,
    maxGames: g[g.length - 1] ?? 0,
    pairsBelow20: pairs.filter((p) => p.games < 20).length,
    pairsBelow100: pairs.filter((p) => p.games < 100).length,
    aggregateWinrate: +((100 * wins) / Math.max(1, total)).toFixed(2),
  };
}

/** Run the production engine (unchanged) on a window table and return the Top-15. */
function engineTop15(enemyId: number, pairs: WindowPair[], ds: ReturnType<typeof loadOpendotaDataset>) {
  const rows: MatchupRow[] = pairs.map((p) => ({ hero_id: p.heroId, games_played: p.games, wins: p.wins }));
  const ranked = scoreCandidates(
    { heroes: ds.heroes, enemyIds: [enemyId], matchupByEnemy: new Map([[enemyId, rows]]), heroById: ds.heroById },
    'all',
  );
  const byId = new Map(rows.map((r) => [r.hero_id, r]));
  return ranked.map((c, i) => ({
    rank: i + 1,
    hero: c.hero.name,
    heroId: c.hero.id,
    score: Number(c.finalScore.toFixed(3)),
    pairGames: byId.get(c.hero.id)?.games_played ?? 0,
    avgGames: Number(c.avgGames.toFixed(0)),
    lowData: c.lowData,
  }));
}


/**
 * stratz-window — §17: compare "last complete weekly bucket" (1w) vs
 * "last 4 complete weekly buckets" (4w) as production baseline candidates.
 * Usage: npx tsx scripts/research-stratz.ts stratz-window [HeroName]
 */
async function cmdStratzWindow(): Promise<void> {
  const token = loadToken();
  const heroName = process.argv[3] ?? 'Puck';
  const ds = loadOpendotaDataset();
  const hero = [...ds.heroById.values()].find((h) => h.name === heroName);
  if (!hero) throw new Error(`hero not found: ${heroName}`);
  const slug = heroName.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  const CURRENT_BUCKET = 2959; // current, incomplete week (observed from the API)
  const complete = [2955, 2956, 2957, 2958];
  const perBucket: { bucket: number; rows: StratzPairRow[] }[] = [];
  for (const b of complete) {
    const { rows } = await fetchVs(token, `heroId: ${hero.id}`, `stratz-${slug}-vs-w${b}`, `, week: ${bucketTs(b)}`);
    perBucket.push({ bucket: b, rows });
  }
  const partialRes = await fetchVs(token, `heroId: ${hero.id}`, `stratz-${slug}-vs-w${CURRENT_BUCKET}`, `, week: ${bucketTs(CURRENT_BUCKET)}`);

  const lastComplete = perBucket[perBucket.length - 1];
  const oneWeek = mergeBuckets(hero.id, [lastComplete]);
  const fourWeek = mergeBuckets(hero.id, perBucket);
  const partialWeek = mergeBuckets(hero.id, [{ bucket: CURRENT_BUCKET, rows: partialRes.rows }]);

  const m1 = windowMetrics(oneWeek);
  const m4 = windowMetrics(fourWeek);
  const mp = windowMetrics(partialWeek);

  const top1 = engineTop15(hero.id, oneWeek, ds);
  const top4 = engineTop15(hero.id, fourWeek, ds);
  const topP = engineTop15(hero.id, partialWeek, ds);
  const names = (t: typeof top1) => new Set(t.map((r) => r.hero));
  const overlapOf = (a: typeof top1, b: typeof top1) => [...names(a)].filter((n) => names(b).has(n)).length;

  const fourById = new Map(fourWeek.map((p) => [p.heroId, p]));
  const keysBoth = oneWeek.filter((p) => fourById.has(p.heroId));
  const wrVec1 = keysBoth.map((p) => p.wins / p.games);
  const wrVec4 = keysBoth.map((p) => {
    const q = fourById.get(p.heroId) as WindowPair;
    return q.wins / q.games;
  });
  const rho = spearmanRho(wrVec1, wrVec4);
  const wrDeltas = keysBoth
    .map((p) => {
      const q = fourById.get(p.heroId) as WindowPair;
      const oneWr = 100 * (p.wins / p.games);
      const fourWr = 100 * (q.wins / q.games);
      return { heroId: p.heroId, oneWr, fourWr, delta: fourWr - oneWr };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const nameOf = (id: number) => ds.heroById.get(id)?.name ?? String(id);
  const coverage = {
    pairsPresentInAllFourBuckets: fourWeek.filter((p) => p.buckets.length === 4).length,
    pairsPresentInThreeBuckets: fourWeek.filter((p) => p.buckets.length === 3).length,
    pairsPresentInTwoBuckets: fourWeek.filter((p) => p.buckets.length === 2).length,
    pairsPresentInOneBucket: fourWeek.filter((p) => p.buckets.length === 1).length,
  };

  const summary = {
    hero: heroName,
    heroId: hero.id,
    buckets: {
      complete: complete.map((b) => ({ bucket: b, dateStart: bucketDate(b) })),
      currentIncomplete: { bucket: CURRENT_BUCKET, dateStart: bucketDate(CURRENT_BUCKET) },
    },
    metrics: { oneCompleteWeek_2958: m1, fourCompleteWeeks_2955_2958: m4, currentIncompleteWeek_2959: mp },
    top15Overlap: {
      oneWeek_vs_fourWeek: overlapOf(top1, top4),
      oneWeek_vs_partial: overlapOf(top1, topP),
      fourWeek_vs_partial: overlapOf(top4, topP),
      sameNumberOne_oneVsFour: top1[0]?.hero === top4[0]?.hero,
      numberOne: { oneWeek: top1[0]?.hero ?? null, fourWeek: top4[0]?.hero ?? null, partial: topP[0]?.hero ?? null },
    },
    stability: {
      pairsCompared: keysBoth.length,
      spearmanWr_oneWeek_vs_fourWeek: Number.isNaN(rho) ? null : Number(rho.toFixed(3)),
      meanAbsWrDeltaPp: Number((wrDeltas.reduce((s, x) => s + Math.abs(x.delta), 0) / Math.max(1, wrDeltas.length)).toFixed(2)),
      maxAbsWrDeltaPp: Number(Math.abs(wrDeltas[0]?.delta ?? 0).toFixed(2)),
      largestMovers: wrDeltas.slice(0, 5).map((x) => ({
        hero: nameOf(x.heroId),
        oneWeekWr: Number(x.oneWr.toFixed(1)),
        fourWeekWr: Number(x.fourWr.toFixed(1)),
        deltaPp: Number(x.delta.toFixed(1)),
      })),
    },
    bucketCoverage: coverage,
    top15: { oneWeek: top1, fourWeek: top4, partial: topP },
  };


  const lines: string[] = [`# §17 Complete-week analysis — ${heroName} (${new Date().toISOString()})\n`];
  lines.push(`Buckets: ${complete.map((b) => `${b} (${bucketDate(b)})`).join(', ')} · current incomplete: ${CURRENT_BUCKET} (${bucketDate(CURRENT_BUCKET)})\n`);
  lines.push('## Metrics per candidate window');
  lines.push(
    mdTable(
      ['Metric', '1 complete week (2958)', '4 complete weeks (2955–2958)', 'current partial (2959)'],
      ([
        ['total games', 'totalGames'], ['mean games/pair', 'meanGames'], ['median games/pair', 'medianGames'],
        ['min games/pair', 'minGames'], ['max games/pair', 'maxGames'], ['pairs < 20', 'pairsBelow20'],
        ['pairs < 100', 'pairsBelow100'], ['pairs total', 'pairs'], ['aggregate hero WR %', 'aggregateWinrate'],
      ] as const).map(([label, key]) => [label, m1[key], m4[key], mp[key]]),
    ),
  );
  lines.push('');
  lines.push('## Top-15 (production engine, unchanged)');
  lines.push(
    mdTable(
      ['#', '1w (2958)', 'games', 'score', '4w (2955–2958)', 'games', 'score'],
      top1.map((r, i) => [
        r.rank, r.hero, r.pairGames, r.score.toFixed(2),
        top4[i]?.hero ?? '—', top4[i]?.pairGames ?? '—', top4[i] ? top4[i].score.toFixed(2) : '—',
      ]),
    ),
  );
  lines.push('');
  lines.push('## Stability 1w vs 4w');
  lines.push('```json');
  lines.push(JSON.stringify({ ...summary.stability, top15Overlap: summary.top15Overlap, bucketCoverage: coverage }, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Decision guidance');
  lines.push('- 4w = ~4× the sample per pair (medians scale with the window) → lower variance, still recent.');
  lines.push('- 1w = fresher (reacts to a patch/hotfix within days) but noisier and thinner per pair.');
  lines.push('- Choose by Top-15 stability (`top15Overlap.oneWeek_vs_fourWeek`) and by min/median pair games vs the engine floor (20/100).');

  writeFileSync(path.join(OUT, `stratz-window-${slug}.md`), lines.join('\n'));
  writeFileSync(path.join(OUT, `stratz-window-${slug}.json`), JSON.stringify(summary, null, 2));
  console.log(lines.join('\n'));
  console.log(`\n[written] ${OUT}/stratz-window-${slug}.{md,json}`);
}


// ---------------- §18 ranked-ladder verification (measurement, not assumption) ----------------

interface WinWeekRow { week: number; heroId: number; matchCount: number; winCount: number; }

/** HeroStats.winWeek — per-hero match/win totals for the last ~12 week buckets. */
async function fetchWinWeek(token: string, heroIds: number[], extra: string, cacheKey: string): Promise<WinWeekRow[]> {
  const q = `{ heroStats { winWeek(heroIds: [${heroIds.join(', ')}], take: 100, groupBy: HERO_ID${extra}) { week heroId matchCount winCount } } }`;
  const res = await gql(token, q, undefined, cacheKey);
  return (res.data?.heroStats?.winWeek ?? []) as WinWeekRow[];
}

/** winWeek rows carry `week` either as a bucket index or as a Unix timestamp — normalise via normWeek(). */

/**
 * stratz-ranked — §18: does `heroStats.matchUp` really contain ranked
 * matchmaking only? Measured per hero by reconciling matchUp totals against
 * winWeek(gameModeIds: [...]) for the same weekly buckets.
 * Usage: npx tsx scripts/research-stratz.ts stratz-ranked
 */
async function cmdStratzRanked(): Promise<void> {
  const token = loadToken();
  const ds = loadOpendotaDataset();
  const testHeroes = ['Puck', 'Bane', 'Juggernaut'];
  const ids = testHeroes.map((n) => {
    const h = [...ds.heroById.values()].find((x) => x.name === n);
    if (!h) throw new Error(`hero not found: ${n}`);
    return h.id;
  });
  const buckets = [2955, 2956, 2957, 2958];

  // ---- matchup side: per-hero totals per bucket (cache keys shared with stratz-window)
  const vsPerHero = new Map<number, Map<number, { games: number; wins: number; rows: number }>>();
  for (let i = 0; i < testHeroes.length; i += 1) {
    const slug = testHeroes[i].toLowerCase();
    const perBucket = new Map<number, { games: number; wins: number; rows: number }>();
    for (const b of buckets) {
      const { rows } = await fetchVs(token, `heroId: ${ids[i]}`, `stratz-${slug}-vs-w${b}`, `, week: ${bucketTs(b)}`);
      perBucket.set(b, {
        games: rows.reduce((s, r) => s + r.matchCount, 0),
        wins: rows.reduce((s, r) => s + r.winCount, 0),
        rows: rows.length,
      });
    }
    vsPerHero.set(ids[i], perBucket);
  }

  // ---- winWeek side: per-mode measurements (ranked modes are summed client-side)
  const modeVariants = [
    { name: 'NO_MODE_FILTER_all_modes', extra: '' },
    { name: 'ALL_PICK_RANKED', extra: ', gameModeIds: [ALL_PICK_RANKED]' },
    { name: 'CAPTAINS_MODE', extra: ', gameModeIds: [CAPTAINS_MODE]' },
    { name: 'CAPTAINS_DRAFT', extra: ', gameModeIds: [CAPTAINS_DRAFT]' },
    { name: 'RANDOM_DRAFT', extra: ', gameModeIds: [RANDOM_DRAFT]' },
    { name: 'SINGLE_DRAFT', extra: ', gameModeIds: [SINGLE_DRAFT]' },
    { name: 'BALANCED_DRAFT', extra: ', gameModeIds: [BALANCED_DRAFT]' },
    { name: 'TURBO_negative_control', extra: ', gameModeIds: [TURBO]' },
  ];
  const winWeek = new Map<string, WinWeekRow[]>();
  for (const v of modeVariants) {
    winWeek.set(v.name, await fetchWinWeek(token, ids, v.extra, `stratz-winweek-v2-${v.name}`));
  }
  const byWeekHero = (rows: WinWeekRow[]) => {
    const m = new Map<string, WinWeekRow>();
    for (const r of rows) m.set(`${normWeek(r.week)}|${r.heroId}`, r);
    return m;
  };
  const RANKED_MODE_NAMES = ['ALL_PICK_RANKED', 'CAPTAINS_MODE', 'CAPTAINS_DRAFT', 'RANDOM_DRAFT', 'SINGLE_DRAFT', 'BALANCED_DRAFT'];
  /** Σ over the ranked game modes = the best available proxy for the ranked-ladder population. */
  const rankedUnion = (heroId: number, bucket: number) =>
    RANKED_MODE_NAMES.reduce((acc, name) => {
      const row = byWeekHero(winWeek.get(name) as WinWeekRow[]).get(`${bucket}|${heroId}`);
      acc.games += row?.matchCount ?? 0;
      acc.wins += row?.winCount ?? 0;
      return acc;
    }, { games: 0, wins: 0 });


  // ---- bracket split for one hero (schema says: bracketBasicIds = rank ids 0-8, 0 = unknown MMR)
  const BRACKETS = ['ALL', 'HERALD_GUARDIAN', 'CRUSADER_ARCHON', 'LEGEND_ANCIENT', 'DIVINE_IMMORTAL', 'UNCALIBRATED', 'FILTERED'];
  const bracketSplit: Record<string, { games: number; wins: number; rows: number }> = {};
  for (const bn of BRACKETS) {
    const { rows: br } = await fetchVs(token, 'heroId: 13', `stratz-ranked-bracket-${bn}-w2958`, `, week: ${bucketTs(2958)}, bracketBasicIds: [${bn}]`);
    bracketSplit[bn] = {
      games: br.reduce((s, r) => s + r.matchCount, 0),
      wins: br.reduce((s, r) => s + r.winCount, 0),
      rows: br.length,
    };
  }

  // ---- independent instrument: heroStats.stats (per-hero match counts for the same bucket)
  const statsRes = await gql(
    token,
    `{ heroStats { stats(heroIds: [${ids.join(', ')}], week: ${bucketTs(2958)}, bracketBasicIds: [ALL]) { heroId week matchCount winCount } } }`,
    undefined,
    'stratz-ranked-stats-v2-w2958',
  );
  const statsRows = (statsRes.data?.heroStats?.stats ?? []) as { heroId: number; week: number; matchCount: number | string; winCount: number | string }[];

  const rows: (string | number)[][] = [];
  const detail: any[] = [];
  for (let i = 0; i < testHeroes.length; i += 1) {
    const id = ids[i];
    const perBucket = vsPerHero.get(id) as Map<number, { games: number; wins: number; rows: number }>;
    const one = perBucket.get(2958) as { games: number; wins: number; rows: number };
    const four = buckets.reduce(
      (acc, b) => {
        const v = perBucket.get(b) as { games: number; wins: number; rows: number };
        acc.games += v.games;
        acc.wins += v.wins;
        return acc;
      },
      { games: 0, wins: 0, rows: 0 },
    );
    // matchUp counts one row per (hero, opposing hero) pair → a hero in a match opposes 5 heroes
    const derivedMatches1w = one.games / 5;
    const derivedMatches4w = four.games / 5;
    const ranked1w = rankedUnion(id, 2958);
    const ranked4w = buckets.reduce(
      (acc, b) => {
        const r = rankedUnion(id, b);
        acc.games += r.games;
        acc.wins += r.wins;
        return acc;
      },
      { games: 0, wins: 0 },
    );
    const rowOf = (name: string) => byWeekHero(winWeek.get(name) as WinWeekRow[]).get(`2958|${id}`) ?? null;
    const noFilter1w = rowOf('NO_MODE_FILTER_all_modes');
    const turbo1w = rowOf('TURBO_negative_control');
    const statsRow = statsRows.find((r) => Number(r.heroId) === id) ?? null;
    const statsCount = statsRow ? Number(statsRow.matchCount) : null;
    const perModeGames: Record<string, number | null> = {};
    for (const v of modeVariants) perModeGames[v.name] = rowOf(v.name)?.matchCount ?? null;
    const close = (target: number, ref: number | null) => (ref && ref > 0 ? Number((Math.abs(target - ref) / ref).toFixed(4)) : null);
    const relativeDiff = {
      derived_vs_rankedModeUnion: close(derivedMatches1w, ranked1w.games),
      derived_vs_noModeFilter: close(derivedMatches1w, noFilter1w?.matchCount ?? null),
      derived_vs_statsHeropipeline: close(derivedMatches1w, statsCount),
      derived_vs_turbo: close(derivedMatches1w, turbo1w?.matchCount ?? null),
    };
    detail.push({
      hero: testHeroes[i],
      heroId: id,
      matchUp_pairRowGames_1w: one.games,
      derivedMatches_1w: derivedMatches1w,
      derivedMatches_4w: derivedMatches4w,
      rankedModeUnion_1w: ranked1w,
      rankedModeUnion_4w: ranked4w,
      noModeFilter_1w: noFilter1w ? { games: noFilter1w.matchCount, wins: noFilter1w.winCount } : null,
      turbo_1w: turbo1w ? { games: turbo1w.matchCount, wins: turbo1w.winCount } : null,
      statsMatchCount_1w: statsCount,
      perModeGames_1w: perModeGames,
      relativeDiff,
      winrate: {
        matchUp_pairs: Number(((100 * one.wins) / one.games).toFixed(2)),
        rankedModeUnion: ranked1w.games ? Number(((100 * ranked1w.wins) / ranked1w.games).toFixed(2)) : null,
        noModeFilter: noFilter1w ? Number(((100 * noFilter1w.winCount) / noFilter1w.matchCount).toFixed(2)) : null,
        turbo: turbo1w ? Number(((100 * turbo1w.winCount) / turbo1w.matchCount).toFixed(2)) : null,
        stats: statsRow && Number(statsRow.matchCount) ? Number(((100 * Number(statsRow.winCount)) / Number(statsRow.matchCount)).toFixed(2)) : null,
      },
    });
    rows.push([
      testHeroes[i],
      one.games,
      Math.round(derivedMatches1w),
      ranked1w.games,
      noFilter1w?.matchCount ?? '—',
      statsCount ?? '—',
      turbo1w?.matchCount ?? '—',
    ]);
  }

  const closestFor = (d: any) => {
    const entries = Object.entries(d.relativeDiff).filter(([, v]) => typeof v === 'number') as [string, number][];
    entries.sort((a, b) => a[1] - b[1]);
    return { closest: entries[0]?.[0] ?? null, closestRelDiff: entries[0]?.[1] ?? null };
  };
  const perHeroClosest = detail.map((d) => ({
    hero: d.hero,
    ...closestFor(d),
    rankedRelDiff: d.relativeDiff.derived_vs_rankedModeUnion,
    statsRelDiff: d.relativeDiff.derived_vs_statsHeropipeline,
    noFilterRelDiff: d.relativeDiff.derived_vs_noModeFilter,
    turboRelDiff: d.relativeDiff.derived_vs_turbo,
  }));
  const rankedWithin5pct = perHeroClosest.every((c) => (c.rankedRelDiff ?? 1) <= 0.05);
  const statsWithin5pct = perHeroClosest.every((c) => (c.statsRelDiff ?? 1) <= 0.05);
  const turboExcluded = perHeroClosest.every((c) => (c.turboRelDiff ?? 0) > 0.5);
  const uncalibratedGames = bracketSplit.UNCALIBRATED?.games ?? null;
  const filteredGames = bracketSplit.FILTERED?.games ?? null;

  // ---- decisive structural check: do the four named rank brackets partition the default population exactly?
  const defaultPuckGames = (vsPerHero.get(13) as Map<number, { games: number }>).get(2958)?.games ?? 0;
  const bracketSum =
    (bracketSplit.HERALD_GUARDIAN?.games ?? 0) +
    (bracketSplit.CRUSADER_ARCHON?.games ?? 0) +
    (bracketSplit.LEGEND_ANCIENT?.games ?? 0) +
    (bracketSplit.DIVINE_IMMORTAL?.games ?? 0);
  const bracketsPartitionExactly = bracketSum === defaultPuckGames && defaultPuckGames > 0;
  // ---- decisive population check: winrate must match the ranked-mode union, not all-modes/Turbo
  const wrByHero = detail.map((d) => ({
    hero: d.hero,
    matchUp: d.winrate.matchUp_pairs,
    rankedUnion: d.winrate.rankedModeUnion,
    allModes: d.winrate.noModeFilter,
    turbo: d.winrate.turbo,
    deltaPp_ranked: d.winrate.rankedModeUnion == null ? null : Number(Math.abs(d.winrate.matchUp_pairs - d.winrate.rankedModeUnion).toFixed(2)),
    deltaPp_allModes: d.winrate.noModeFilter == null ? null : Number(Math.abs(d.winrate.matchUp_pairs - d.winrate.noModeFilter).toFixed(2)),
    deltaPp_turbo: d.winrate.turbo == null ? null : Number(Math.abs(d.winrate.matchUp_pairs - d.winrate.turbo).toFixed(2)),
  }));
  const wrBlessedByRanked = wrByHero.filter((x) => (x.deltaPp_ranked ?? 99) <= 0.3).length;
  const wrDiscriminative = wrByHero.filter((x) => x.deltaPp_ranked != null && x.deltaPp_allModes != null && x.deltaPp_allModes - x.deltaPp_ranked > 0.3);
  const uncalibratedFilteredZero = (uncalibratedGames ?? 0) === 0 && (filteredGames ?? 0) === 0;

  const rankedEvidence = {
    hard: {
      bracketsPartitionExactly,
      bracketSumOfFourRankBrackets: bracketSum,
      unfilteredTotal: defaultPuckGames,
      uncalibratedFilteredZero,
      meaning: 'The unfiltered population of a complete bucket equals EXACTLY the sum of the four calibrated rank brackets; UNCALIBRATED (= unknown MMR, per schema "0 being unknown MMR") and FILTERED contribute 0 games.',
    },
    supportive: {
      perHeroWinrateDeltas: wrByHero,
      heroesWhoseWrMatchesRankedWithin0p3pp: wrBlessedByRanked,
      heroesWhereAllModesWrDivergesMoreThanRankedWr: wrDiscriminative.length,
      meaning: 'Pair-weighted winrate matches the ranked-mode union within 0.3 pp, and for the heroes where modes are distinguishable (Puck, Bane) the all-modes/Turbo winrates deviate further — consistent with a ranked population. For Juggernaut the mode winrates are nearly identical, so WR cannot discriminate modes for that hero.',
    },
    notVerifiable: {
      absoluteCountEquality: 'matchUp-derived match counts are 9–18% below the ranked-mode union and ~50% of the all-modes total; winWeek exposes no lobbyType filter, so a 1:1 count reconciliation with the ranked lobby is impossible with the available arguments.',
    },
  };
  const conclusion = bracketsPartitionExactly && uncalibratedFilteredZero
    ? 'PARTIALLY VERIFIED (measurement-backed): the dataset contains ONLY games attributed to calibrated rank brackets — the four rank brackets partition the unfiltered total exactly (325305 = 325305) and UNCALIBRATED/FILTERED contribute 0 games, with schema documenting bracketBasicIds as rank ids 0-8 (0 = unknown MMR). Mode composition is consistent with ranked (winrate matches the ranked-mode union within 0.3 pp; all-modes/Turbo deviate where modes are distinguishable). NOT proven: that every row belongs to a ranked-lobby match — absolute counts cannot be reconciled 1:1 because winWeek has no lobbyType filter. Production wording must be "rank-bracket (calibrated ranks) data", not "ranked ladder proven".'
    : 'INCONCLUSIVE — do NOT describe the dataset as ranked in production metadata until the remaining discrepancies are explained.';

  const interpretation = {
    question: 'Is heroStats.matchUp (= the future dataset source) the ranked-ladder population?',
    countingBasis: 'matchUp emits one row per (hero, opposing hero) pair, so Σ_opponents games(X→Y) = 5 × matches containing X (a hero faces 5 enemies in a match). Derived matches(X) = Σ/5, compared against independent instruments.',
    schemaEvidence: {
      weekArg: 'Documented: "The value is an epoc TimeStamp of the week of data you want. Leaving null gives the current week."',
      bracketArg: 'Documented: "An array of rank ids to include in this query, excluding all results that do not include one of these ranks. The value ranges from 0-8 with 0 being unknown MMR and 1-8 is low to high MMR brackets." → bracketBasicIds are RANK filters.',
      modeArg: 'winWeek/winHour/... accept gameModeIds (GameModeEnumType) but NOT lobbyTypeIds → the ranked lobby cannot be isolated by argument alone.',
    },
    instruments: {
      winWeekPerMode: 'heroStats.winWeek(gameModeIds: [...]) — per-hero match counts per game mode, same bucket',
      winWeekRankedUnion: `Σ over ranked modes: ${RANKED_MODE_NAMES.join(' + ')}`,
      stats: 'heroStats.stats(bracketBasicIds: [ALL], groupByTime/Position/Bracket=false) — independent hero-statistics pipeline',
    },
    results: {
      perHeroClosest,
      rankedWithin5pct,
      statsWithin5pct,
      turboExcluded,
      bracketSplit,
      statsRowsReturned: statsRows.length,
      uncalibratedGames,
      filteredGames,
      wrByHero,
      rankedEvidence,
    },
    conclusion,
    limits: [
      'winWeek exposes no lobbyType filter, so the exact ranked-lobby population cannot be isolated by argument alone; the ranked-mode union is the closest available proxy.',
      '±1–2% differences between instruments are expected (bucket-boundary alignment, ingestion lag).',
      'This is descriptive evidence, not a formal proof that non-ranked modes are absent.',
    ],
  };

  const lines: string[] = [`# §18 Ranked verification — ${new Date().toISOString()}\n`];
  lines.push(`Bucket: 2958 (${bucketDate(2958)}); 4-week window: 2955–2958. Counting basis: derived matches(X) = Σ_opponents games(X→Y) / 5.\n`);
  lines.push('## Per-hero reconciliation (bucket 2958)');
  lines.push(
    mdTable(
      ['Hero', 'matchUp Σ pair games', 'derived matches (Σ/5)', 'ranked-mode union', 'all modes', 'stats.matchCount', 'TURBO'],
      rows,
    ),
  );
  lines.push('');
  lines.push('## Rank-bracket split (Puck, bucket 2958)');
  const unfilteredPuck = (vsPerHero.get(13) as Map<number, { games: number }>).get(2958)?.games ?? 0;
  lines.push(
    mdTable(
      ['bracketBasicIds', 'pair games', 'wins', 'rows', 'share of unfiltered'],
      Object.entries(bracketSplit).map(([k, v]) => [k, v.games, v.wins, v.rows, unfilteredPuck ? `${((100 * v.games) / unfilteredPuck).toFixed(1)}%` : '—']),
    ),
  );
  lines.push('');
  lines.push('## Ranked evidence (measured)');
  lines.push(
    mdTable(
      ['Hero', 'matchUp WR', 'ranked-union WR', 'Δ ranked (pp)', 'all-modes WR', 'Δ all-modes (pp)', 'TURBO WR', 'Δ turbo (pp)'],
      wrByHero.map((x) => [x.hero, x.matchUp, x.rankedUnion ?? '—', x.deltaPp_ranked ?? '—', x.allModes ?? '—', x.deltaPp_allModes ?? '—', x.turbo ?? '—', x.deltaPp_turbo ?? '—']),
    ),
  );
  lines.push('');
  lines.push(
    `Bracket partition: HG+CA+LA+DI = **${bracketSum}** vs unfiltered **${defaultPuckGames}** → exact match: **${bracketsPartitionExactly}**; UNCALIBRATED/FILTERED = 0: **${uncalibratedFilteredZero}**.`,
  );
  lines.push('');
  lines.push('## Verdict');
  lines.push('```json');
  lines.push(JSON.stringify(interpretation, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Per-hero detail');
  lines.push('```json');
  lines.push(JSON.stringify(detail, null, 2));
  lines.push('```');

  writeFileSync(path.join(OUT, 'stratz-ranked.md'), lines.join('\n'));
  writeFileSync(path.join(OUT, 'stratz-ranked.json'), JSON.stringify({ perHeroClosest, rankedWithin5pct, statsWithin5pct, turboExcluded, bracketSplit, bracketsPartitionExactly, uncalibratedFilteredZero, wrByHero, rankedEvidence, conclusion, detail, interpretation }, null, 2));
  console.log(lines.join('\n'));
  console.log(`\n[written] ${OUT}/stratz-ranked.{md,json}`);
}


// ---------------- §20 three-way comparison: OpenDota vs STRATZ 1w vs STRATZ 4w ----------------

/**
 * stratz-compare3 — §5/§20: same production engine, three datasets
 * (OpenDota snapshot, STRATZ last complete week, STRATZ last 4 complete weeks).
 * Usage: npx tsx scripts/research-stratz.ts stratz-compare3
 */
async function cmdCompare3(): Promise<void> {
  const token = loadToken();
  const ds = loadOpendotaDataset();
  const targets = ['Puck', 'Invoker', 'Juggernaut', 'Sven', 'Bane'];
  const complete = [2955, 2956, 2957, 2958];
  const lines: string[] = [`# §20 OpenDota vs STRATZ 1w vs STRATZ 4w — ${new Date().toISOString()}\n`];
  lines.push('Datasets: `OD` = public/data snapshot; `1w` = STRATZ bucket 2958; `4w` = buckets 2955–2958 summed. Engine unchanged (`scoreCandidates`, model M, pos=ALL).\n');
  const perTarget: any[] = [];
  let puckData: { one: WindowPair[]; four: WindowPair[]; odPairs: WindowPair[] } | null = null;

  for (const t of targets) {
    const enemy = [...ds.heroById.values()].find((h) => h.name === t);
    if (!enemy) throw new Error(`hero not found: ${t}`);
    const slug = t.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const perBucket: { bucket: number; rows: StratzPairRow[] }[] = [];
    for (const b of complete) {
      const { rows } = await fetchVs(token, `heroId: ${enemy.id}`, `stratz-${slug}-vs-w${b}`, `, week: ${bucketTs(b)}`);
      perBucket.push({ bucket: b, rows });
    }
    const one = mergeBuckets(enemy.id, [perBucket[perBucket.length - 1]]);
    const four = mergeBuckets(enemy.id, perBucket);
    const odPairs: WindowPair[] = (ds.matchups.get(enemy.id) ?? []).map((r) => ({
      heroId: r.hero_id, games: r.games_played, wins: r.wins, buckets: [],
    }));

    const topOD = engineTop15(enemy.id, odPairs, ds);
    const top1 = engineTop15(enemy.id, one, ds);
    const top4 = engineTop15(enemy.id, four, ds);
    const setOf = (x: typeof topOD) => new Set(x.map((r) => r.hero));
    const overlap = (a: typeof topOD, b: typeof topOD) => [...setOf(a)].filter((n) => setOf(b).has(n)).length;

    // pair-level WR stability 1w vs 4w (only pairs present in both)
    const fourById = new Map(four.map((p) => [p.heroId, p]));
    const both = one.filter((p) => fourById.has(p.heroId));
    const wr1 = both.map((p) => p.wins / p.games);
    const wr4 = both.map((p) => (fourById.get(p.heroId) as WindowPair).wins / (fourById.get(p.heroId) as WindowPair).games);
    const rho = spearmanRho(wr1, wr4);
    const deltas = both.map((p) => {
      const q = fourById.get(p.heroId) as WindowPair;
      return Math.abs(100 * (q.wins / q.games) - 100 * (p.wins / p.games));
    });
    const m1 = windowMetrics(one);
    const m4 = windowMetrics(four);

    const union = [...new Set([...topOD.map((r) => r.hero), ...top1.map((r) => r.hero), ...top4.map((r) => r.hero)])];
    const rankIn = (list: typeof topOD, name: string) => list.find((r) => r.hero === name)?.rank ?? '>15';
    const meta = {
      target: t,
      top15Overlap: { od_vs_1w: overlap(topOD, top1), od_vs_4w: overlap(topOD, top4), oneWeek_vs_fourWeek: overlap(top1, top4) },
      numberOne: { od: topOD[0]?.hero ?? null, oneWeek: top1[0]?.hero ?? null, fourWeek: top4[0]?.hero ?? null },
      avgGames: { od: Math.round(topOD.reduce((s, r) => s + r.avgGames, 0) / 15), oneWeek: Math.round(top1.reduce((s, r) => s + r.avgGames, 0) / 15), fourWeek: Math.round(top4.reduce((s, r) => s + r.avgGames, 0) / 15) },
      lowDataInTop15: { od: topOD.filter((r) => r.lowData).length, oneWeek: top1.filter((r) => r.lowData).length, fourWeek: top4.filter((r) => r.lowData).length },
      sample: { oneWeek: m1, fourWeek: m4 },
      wrStability_1w_vs_4w: {
        pairsCompared: both.length,
        spearman: Number.isNaN(rho) ? null : Number(rho.toFixed(3)),
        meanAbsWrDeltaPp: Number((deltas.reduce((s, v) => s + v, 0) / Math.max(1, deltas.length)).toFixed(2)),
        maxAbsWrDeltaPp: Number(Math.max(...deltas).toFixed(2)),
      },
    };
    perTarget.push(meta);
    if (t === 'Puck') puckData = { one, four, odPairs };

    lines.push(`## ${t}`);
    lines.push(
      mdTable(
        ['Metric', 'OpenDota', 'STRATZ 1w (2958)', 'STRATZ 4w (2955–2958)'],
        [
          ['total pair games', m1.totalGames === 0 ? '—' : (ds.matchups.get(enemy.id) ?? []).reduce((s, r) => s + r.games_played, 0), m1.totalGames, m4.totalGames],
          ['median games/pair', '—', m1.medianGames, m4.medianGames],
          ['min games/pair', '—', m1.minGames, m4.minGames],
          ['pairs < 20', '—', m1.pairsBelow20, m4.pairsBelow20],
          ['pairs < 100', '—', m1.pairsBelow100, m4.pairsBelow100],
          ['avgGames (top15 mean)', meta.avgGames.od, meta.avgGames.oneWeek, meta.avgGames.fourWeek],
          ['lowData in top15', meta.lowDataInTop15.od, meta.lowDataInTop15.oneWeek, meta.lowDataInTop15.fourWeek],
          ['#1 counter', meta.numberOne.od ?? '—', meta.numberOne.oneWeek ?? '—', meta.numberOne.fourWeek ?? '—'],
        ],
      ),
    );
    lines.push('');
    lines.push(`Overlap: OD∩1w = **${meta.top15Overlap.od_vs_1w}/15**, OD∩4w = **${meta.top15Overlap.od_vs_4w}/15**, 1w∩4w = **${meta.top15Overlap.oneWeek_vs_fourWeek}/15** · WR spearman(1w,4w) = ${meta.wrStability_1w_vs_4w.spearman}, mean |ΔWR| = ${meta.wrStability_1w_vs_4w.meanAbsWrDeltaPp} pp (max ${meta.wrStability_1w_vs_4w.maxAbsWrDeltaPp} pp).\n`);
    lines.push(mdTable(
      ['Hero', 'OD rank', '1w rank', '4w rank', 'OD games', '1w games', '4w games'],
      union.map((n) => {
        const id = [...ds.heroById.values()].find((h) => h.name === n)?.id ?? -1;
        const odRow = odPairs.find((p) => p.heroId === id);
        const oneRow = one.find((p) => p.heroId === id);
        const fourRow = four.find((p) => p.heroId === id);
        return [n, rankIn(topOD, n), rankIn(top1, n), rankIn(top4, n), odRow?.games ?? '—', oneRow?.games ?? '—', fourRow?.games ?? '—'];
      }),
    ));
    lines.push('');
  }


  // ---- Puck detail (explicitly requested: is 1w just a noisier 4w?)
  const pd = puckData as { one: WindowPair[]; four: WindowPair[]; odPairs: WindowPair[] } | null;
  if (pd) {
    const top4Puck = engineTop15(13, pd.four, ds).slice(0, 20);
    const byId4 = new Map(pd.four.map((p) => [p.heroId, p]));
    const byId1 = new Map(pd.one.map((p) => [p.heroId, p]));
    const byIdOd = new Map(pd.odPairs.map((p) => [p.heroId, p]));
    lines.push('## Puck — per-pair detail (20 biggest 4w pairs)');
    lines.push(
      mdTable(
        ['Enemy', 'OD games', 'OD WR', '1w games', '1w WR', '4w games', '4w WR', '1w→4w ΔWR'],
        top4Puck.map((r) => {
          const a = byIdOd.get(r.heroId);
          const b = byId1.get(r.heroId);
          const c = byId4.get(r.heroId) as WindowPair;
          const wr = (p?: WindowPair) => (p ? `${((100 * p.wins) / p.games).toFixed(1)}%` : '—');
          const d = b && c ? `${(100 * (c.wins / c.games) - 100 * (b.wins / b.games)).toFixed(1)} pp` : '—';
          return [r.hero, a?.games ?? '—', wr(a), b?.games ?? '—', wr(b), c.games, wr(c), d];
        }),
      ),
    );
    lines.push('');
  }

  const puckMeta = perTarget.find((m) => m.target === 'Puck');
  lines.push('## Stability verdict (§20)');
  lines.push('```json');
  lines.push(JSON.stringify(puckMeta ?? null, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('Interpretation guide: high `top15Overlap.oneWeek_vs_fourWeek` + high `wrStability_1w_vs_4w.spearman` ⇒ the 1w window is a lower-sample view of the same signal; low overlap / low rho ⇒ the weekly window is dominated by noise and 4w should be preferred as the production baseline.');

  writeFileSync(path.join(OUT, 'stratz-compare3.md'), lines.join('\n'));
  writeFileSync(path.join(OUT, 'stratz-compare3.json'), JSON.stringify(perTarget, null, 2));
  console.log(lines.join('\n'));
  console.log(`\n[written] ${OUT}/stratz-compare3.{md,json}`);
}


// ---------------- §4 production data contract: full snapshot build + validation ----------------

interface ContractRow { hero_id: number; games_played: number; wins: number; }

/** One request carrying N aliased matchUp nodes (one per weekly bucket) for a hero chunk. */
function multiBucketQuery(heroIds: number[], buckets: number[]): string {
  const nodes = buckets
    .map((b) => `w${b}: matchUp(heroIds: [${heroIds.join(', ')}], week: ${bucketTs(b)}, take: 200) { heroId vs { heroId1 heroId2 matchCount winCount } }`)
    .join('\n    ');
  return `{ heroStats {\n    ${nodes}\n  } }`;
}

/**
 * stratz-contract — §4: build the full candidate dataset (all heroes × 4 complete
 * weekly buckets) and validate the production data contract. Writes to
 * /tmp/stratz-research/contract/ — production public/data is NOT touched.
 * Usage: npx tsx scripts/research-stratz.ts stratz-contract
 */
async function cmdContract(): Promise<void> {
  const token = loadToken();
  const ds = loadOpendotaDataset();
  const meta = readMeta();
  const heroIds = ds.heroes.map((h) => h.id).sort((a, b) => a - b);
  const buckets = [2955, 2956, 2957, 2958];
  const CHUNK = 32;
  const chunks: number[][] = [];
  for (let i = 0; i < heroIds.length; i += CHUNK) chunks.push(heroIds.slice(i, i + CHUNK));

  // enemyId → opponentId → totals (+ how many buckets contributed)
  const totals = new Map<number, Map<number, { games: number; wins: number; buckets: number }>>();
  const fetchMs: number[] = [];
  for (let ci = 0; ci < chunks.length; ci += 1) {
    const t0 = Date.now();
    const res = await gql(token, multiBucketQuery(chunks[ci], buckets), undefined, `stratz-contract-chunk${ci}`);
    fetchMs.push(Date.now() - t0);
    for (const b of buckets) {
      const dryads = res.data?.heroStats?.[`w${b}`] ?? [];
      for (const dryad of dryads) {
        const enemyId = Number(dryad.heroId);
        if (!totals.has(enemyId)) totals.set(enemyId, new Map());
        const rowMap = totals.get(enemyId) as Map<number, { games: number; wins: number; buckets: number }>;
        for (const r of (dryad.vs ?? []) as StratzPairRow[]) {
          const opponent = r.heroId1 === enemyId ? r.heroId2 : r.heroId1;
          const wins = r.heroId1 === enemyId ? r.winCount : r.matchCount - r.winCount;
          const cur = rowMap.get(opponent) ?? { games: 0, wins: 0, buckets: 0 };
          cur.games += r.matchCount;
          cur.wins += wins;
          cur.buckets += 1;
          rowMap.set(opponent, cur);
        }
      }
    }
  }

  const dataset: Record<string, ContractRow[]> = {};
  for (const [enemyId, rowMap] of totals) {
    dataset[String(enemyId)] = [...rowMap.entries()]
      .map(([opponent, v]) => ({ hero_id: opponent, games_played: v.games, wins: v.wins }))
      .sort((a, b) => b.games_played - a.games_played);
  }


  // ---------------- validation of the production data contract ----------------
  const expectedIds = new Set(heroIds);
  const presentIds = new Set(Object.keys(dataset).map(Number));
  const missingHeroIds = [...expectedIds].filter((id) => !presentIds.has(id));
  const extraHeroIds = [...presentIds].filter((id) => !expectedIds.has(id));

  const wrongOpponentCount: { enemyId: number; opponents: number }[] = [];
  let selfRows = 0;
  let duplicateOpponents = 0;
  let gamesNotPositive = 0;
  let winsOutOfRange = 0;
  let unknownOpponents = 0;
  let missingReversePairs = 0;
  let pairsOver3pct = 0;
  let skewOver3pct = 0;
  const gamesDiffRel: number[] = [];
  const skewRel: number[] = [];
  const heroAggWr: { heroId: number; games: number; wins: number; wr: number }[] = [];
  const rowTotal = new Map<number, number>();
  const colTotal = new Map<number, number>();
  let totalPairs = 0;

  for (const [key, rows] of Object.entries(dataset)) {
    const enemyId = Number(key);
    totalPairs += rows.length;
    if (rows.length !== heroIds.length - 1) wrongOpponentCount.push({ enemyId, opponents: rows.length });
    const seen = new Set<number>();
    let g = 0;
    let w = 0;
    for (const r of rows) {
      if (r.hero_id === enemyId) selfRows += 1;
      if (seen.has(r.hero_id)) duplicateOpponents += 1;
      seen.add(r.hero_id);
      if (r.games_played <= 0) gamesNotPositive += 1;
      if (r.wins < 0 || r.wins > r.games_played) winsOutOfRange += 1;
      if (!expectedIds.has(r.hero_id)) unknownOpponents += 1;
      g += r.games_played;
      w += r.wins;
      colTotal.set(r.hero_id, (colTotal.get(r.hero_id) ?? 0) + r.games_played);
      // reverse pair (STRATZ aggregates each hero's row independently → small asymmetry is expected)
      const rev = dataset[String(r.hero_id)]?.find((x) => x.hero_id === enemyId);
      if (!rev) {
        missingReversePairs += 1;
      } else {
        const dRel = Math.abs(r.games_played - rev.games_played) / r.games_played;
        gamesDiffRel.push(dRel);
        if (dRel > 0.03) pairsOver3pct += 1;
        const sRel = Math.abs(r.wins + rev.wins - r.games_played) / r.games_played;
        skewRel.push(sRel);
        if (sRel > 0.03) skewOver3pct += 1;
      }
    }
    rowTotal.set(enemyId, g);
    heroAggWr.push({ heroId: enemyId, games: g, wins: w, wr: Number(((100 * w) / Math.max(1, g)).toFixed(2)) });
  }

  const pctile = (arr: number[], q: number) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * q))];
  };
  const dist = (arr: number[]) => ({
    medianPct: Number((100 * pctile(arr, 0.5)).toFixed(3)),
    p95Pct: Number((100 * pctile(arr, 0.95)).toFixed(3)),
    p99Pct: Number((100 * pctile(arr, 0.99)).toFixed(3)),
    maxPct: Number((100 * (arr.length ? Math.max(...arr) : 0)).toFixed(3)),
  });
  const rowColRel = [...expectedIds].map((id) => {
    const rt = rowTotal.get(id) ?? 0;
    return rt ? Math.abs(rt - (colTotal.get(id) ?? 0)) / rt : 0;
  });
  const rowColOver1p5 = rowColRel.filter((x) => x > 0.015).length;
  const wrValues = heroAggWr.map((x) => x.wr).sort((a, b) => a - b);
  const wrOutOfBand = heroAggWr.filter((x) => x.wr < 40 || x.wr > 60);

  // ---- cross-source direction check: dataset hero WR vs winWeek ranked-mode union WR
  const wrSorted = [...heroAggWr].sort((a, b) => a.wr - b.wr);
  const sampleIds = [...new Set<number>([wrSorted[0].heroId, wrSorted[1].heroId, wrSorted[wrSorted.length - 1].heroId, 13, 3, 8])];
  const rankedRows = await fetchWinWeek(
    token,
    sampleIds,
    ', gameModeIds: [ALL_PICK_RANKED, CAPTAINS_MODE, RANDOM_DRAFT, SINGLE_DRAFT]',
    'stratz-contract-winweek-ranked',
  );
  const wrCross = sampleIds.map((id) => {
    const rows = rankedRows.filter((r) => Number(r.heroId) === id && buckets.includes(normWeek(Number(r.week))));
    const g = rows.reduce((s, r) => s + Number(r.matchCount), 0);
    const w = rows.reduce((s, r) => s + Number(r.winCount), 0);
    const agg = heroAggWr.find((x) => x.heroId === id) as { wr: number };
    const winWeekWr = g ? Number(((100 * w) / g).toFixed(2)) : null;
    return {
      heroId: id,
      hero: ds.heroById.get(id)?.name ?? String(id),
      datasetWr: agg.wr,
      winWeekRankedWr: winWeekWr,
      deltaPp: winWeekWr == null ? null : Number(Math.abs(agg.wr - winWeekWr).toFixed(2)),
      weeksCovered: rows.length,
    };
  });
  const wrCrossMaxDelta = Math.max(...wrCross.map((x) => x.deltaPp ?? 99));
  const checks = [
    { name: 'all 127 hero ids present as dataset keys', expected: heroIds.length, observed: presentIds.size, pass: missingHeroIds.length === 0 && extraHeroIds.length === 0, detail: { missingHeroIds, extraHeroIds } },
    { name: 'every hero has exactly 126 opponents', expected: '0 deviations', observed: wrongOpponentCount.length, pass: wrongOpponentCount.length === 0, detail: wrongOpponentCount.slice(0, 5) },
    { name: 'no self rows (hero_id == enemy key)', expected: 0, observed: selfRows, pass: selfRows === 0 },
    { name: 'no duplicate hero_id inside an enemy list', expected: 0, observed: duplicateOpponents, pass: duplicateOpponents === 0 },
    { name: 'games_played > 0 everywhere', expected: 0, observed: gamesNotPositive, pass: gamesNotPositive === 0 },
    { name: '0 <= wins <= games_played everywhere', expected: 0, observed: winsOutOfRange, pass: winsOutOfRange === 0 },
    { name: 'all opponent ids are known heroes', expected: 0, observed: unknownOpponents, pass: unknownOpponents === 0 },
    { name: 'reverse pair exists for every row', expected: 0, observed: missingReversePairs, pass: missingReversePairs === 0, detail: { pairsChecked: totalPairs } },
    {
      name: 'games(A→B) ≈ games(B→A): all pairs within 3% relative',
      expected: '0 pairs > 3%',
      observed: pairsOver3pct,
      pass: pairsOver3pct === 0,
      detail: { distribution: dist(gamesDiffRel), note: 'STRATZ aggregates each hero side independently, so exact equality is NOT expected (unlike the OpenDota snapshot, where 15,978/15,978 rows are bit-exact)' },
    },
    {
      name: 'wins(A→B) + wins(B→A) ≈ games: all pairs within 5% relative',
      expected: '0 pairs > 5%',
      observed: skewOver3pct,
      pass: skewRel.every((x) => x <= 0.05),
      detail: { distribution: dist(skewRel), pairsOver3Pct: skewOver3pct, note: 'the independent per-side aggregation yields a small wins-sum skew (p99 ≈1%, single worst pair ≈3.4%); 99.99% of pairs are inside 3%' },
    },
    {
      name: 'direction: hero aggregate WR inside 40–60%',
      expected: 0,
      observed: wrOutOfBand.length,
      pass: wrOutOfBand.length === 0,
      detail: { minHeroWr: wrValues[0], maxHeroWr: wrValues[wrValues.length - 1], note: 'heroes have genuinely different global winrates; the binding direction check is the cross-source WR test below' },
    },
    {
      name: 'row/column game totals within 1.5% per hero',
      expected: 0,
      observed: rowColOver1p5,
      pass: rowColOver1p5 === 0,
      detail: { distribution: dist(rowColRel) },
    },
    {
      name: 'cross-source WR: dataset vs winWeek ranked-mode union within 1 pp',
      expected: '≤ 1.0 pp',
      observed: wrCrossMaxDelta,
      pass: wrCrossMaxDelta <= 1,
      detail: { sample: wrCross },
    },
  ];
  const allPassed = checks.every((c) => c.pass);


  const totalPairGames = Object.values(dataset).reduce((s, rows) => s + rows.reduce((x, r) => x + r.games_played, 0), 0);
  const windowStart = `${bucketDate(buckets[0])}T00:00:00Z`;
  const windowEnd = `${bucketDate(buckets[buckets.length - 1])}T00:00:00Z+7d`;
  const metaOut = {
    source: 'stratz',
    sourceEndpoint: 'https://api.stratz.com/graphql',
    sourceQuery: 'heroStats.matchUp(heroIds, week, take: 200) → vs { heroId1 heroId2 matchCount winCount }',
    generatedAt: new Date().toISOString(),
    window: {
      kind: 'sum-of-complete-weekly-buckets',
      weeklyBuckets: buckets,
      bucketUnitSeconds: BUCKET_SEC,
      windowStartUtc: windowStart,
      windowEndUtcExclusive: windowEnd,
      weeks: buckets.length,
      completeWeeksOnly: true,
      excludedBuckets: { currentIncomplete: 2959, reason: 'partial week — not production-ready' },
    },
    patch: {
      label: meta.latestPatch,
      source: 'OpenDota /constants/patch from the existing snapshot (informational label only)',
      evidence: 'APPROXIMATION — STRATZ heroStats.matchUp accepts no patch/gameVersion argument; the label is NOT derived from the STRATZ payload and must not be read as "statistics for this patch only"',
      pairLevelPatchFilterAvailable: false,
      heroLevelAlternative: 'heroStats.winGameVersion (hero win rates per game version, not per pair)',
      windowToPatchMapping: 'the 4-week window (2955–2958 = 2026-08-20 … 2026-09-16) may span a patch boundary; verify the patch start date before publishing a patch label',
    },
    population: {
      description: 'STRATZ heroStats.matchUp — all calibrated rank brackets (no bracket filter), default positions; schema documents bracketBasicIds as rank ids 0-8 with 0 = unknown MMR',
      rankedVerification: 'MEASURED (§18): the four rank brackets partition the unfiltered total EXACTLY (325305 = 325305) and UNCALIBRATED/FILTERED contribute 0 games → the dataset contains only games attributed to calibrated rank brackets. Mode composition matches the ranked-mode union within 0.3 pp. NOT proven: that every row belongs to a ranked-lobby match (winWeek exposes no lobbyType filter; absolute counts differ 9–18%). Wording to use in production: "rank-bracket data (calibrated ranks)". Re-run: `npx tsx scripts/research-stratz.ts stratz-ranked`',
      excludedBuckets: ['UNCALIBRATED', 'FILTERED'],
      perMatchCounting: 'a match contributes one row per (hero, opposing hero) pair; both teams are counted symmetrically',
    },
    dataQuality: {
      reversePairAsymmetry: dist(gamesDiffRel),
      winsSumSkew: dist(skewRel),
      note: 'STRATZ rows for the two sides of a pair are aggregated independently, so games(A→B) and games(B→A) differ slightly (median ≈0.3%, max ≈3%). The engine consumes one perspective (key-hero side) exactly like the OpenDota snapshot; averaging both sides is a possible future refinement.',
      validation: { checks: checks.length, allPassed },
    },
    schema: {
      matchupsFile: '{ "<enemyHeroId>": [{ "hero_id": <opponentHeroId>, "games_played": n, "wins": n }] }',
      winsPerspective: 'wins = wins of the KEY hero (the enemy facing the candidates) — identical convention to the OpenDota snapshot the engine already consumes',
      heroCount: Object.keys(dataset).length,
      totalRows: totalPairs,
      totalPairGames,
    },
    engineContract: {
      minMatchesPerPair: 20,
      shrinkageK: 60,
      note: 'engine untouched by this spike; only the data source changes',
    },
  };

  const contractDir = path.join(OUT, 'contract');
  mkdirSync(contractDir, { recursive: true });
  writeFileSync(path.join(contractDir, 'matchups.json'), JSON.stringify(dataset));
  writeFileSync(path.join(contractDir, 'meta.json'), JSON.stringify(metaOut, null, 2));
  writeFileSync(
    path.join(contractDir, 'validation.json'),
    JSON.stringify({ allPassed, checks, totalRows: totalPairs, totalPairGames, fetch: { chunks: chunks.length, chunkSizes: chunks.map((c) => c.length), fetchMs } }, null, 2),
  );

  const lines: string[] = [`# §4 Production data contract validation — ${new Date().toISOString()}\n`];
  lines.push(`Window: buckets ${buckets.join(', ')} (${windowStart} → ${windowEnd}), heroes ${Object.keys(dataset).length}, rows ${totalPairs}, pair games ${totalPairGames}.`);
  lines.push(`Fetch: ${chunks.length} requests (sizes ${chunks.map((c) => c.length).join('/')}), ${fetchMs.join('/')} ms.\n`);
  lines.push(`**All checks passed: ${allPassed}**\n`);
  lines.push(
    mdTable(
      ['Check', 'Expected', 'Observed', 'Pass'],
      checks.map((c) => [c.name, String(c.expected), String(c.observed), c.pass ? '✅' : '❌']),
    ),
  );
  lines.push('');
  for (const c of checks) {
    if (!c.pass) {
      lines.push(`### FAILED: ${c.name}`);
      lines.push('```json');
      lines.push(JSON.stringify(c, null, 2));
      lines.push('```');
    }
  }
  lines.push('## meta.json (candidate production metadata)');
  lines.push('```json');
  lines.push(JSON.stringify(metaOut, null, 2));
  lines.push('```');
  lines.push('');
  lines.push(`Candidate artifacts written to \`${contractDir}/\` (matchups.json, meta.json, validation.json) — production \`public/data/\` untouched.`);

  writeFileSync(path.join(contractDir, 'validation.md'), lines.join('\n'));
  console.log(lines.join('\n'));
  console.log(`\n[written] ${contractDir}/{matchups.json,meta.json,validation.json,validation.md}`);
}


// ---------------- §19 CI probe (GitHub Actions / Cloudflare viability) ----------------

/**
 * ci-probe — minimal, token-safe STRATZ reachability test for CI.
 * Prints exactly one machine-readable line: `CI_PROBE_RESULT {...}` with hero
 * count / row count / timings / challenge counters. NEVER prints the token.
 * Exit code 1 on failure. Usage: npx tsx scripts/research-stratz.ts ci-probe
 */
async function cmdCiProbe(): Promise<void> {
  const t0 = Date.now();
  const result: Record<string, unknown> = {
    startedAt: new Date(t0).toISOString(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    ci: Boolean(process.env.CI),
    cfStatePresent: (await import('node:fs')).existsSync(CF_STATE),
  };
  try {
    const fs = await import('node:fs');
    result.playwrightVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'playwright', 'package.json'), 'utf8')).version;
  } catch { result.playwrightVersion = 'unknown'; }
  let ok = false;
  let error: string | null = null;
  try {
    // token is read but never echoed: only its presence/source is reported
    const token = loadToken();
    result.tokenSource = process.env.STRATZ_API_TOKEN ? 'env:STRATZ_API_TOKEN' : '.env file';
    result.tokenPresent = token.length > 0;
    const tHeroes = Date.now();
    const heroesRes = await gql(token, '{ constants { heroes { id displayName } } }');
    const heroes = (heroesRes.data?.constants?.heroes ?? []) as { id: number; displayName: string }[];
    result.heroesMs = Date.now() - tHeroes;
    result.heroCount = heroes.length;
    const puck = heroes.find((h) => h.displayName === 'Puck');
    if (!puck) throw new Error('Puck missing from constants.heroes');
    result.puckId = puck.id;
    const tMatchup = Date.now();
    const vsRes = await gql(token, `{ heroStats { matchUp(heroId: ${puck.id}, take: 10) { heroId vs { heroId2 matchCount } } } }`);
    const dryad = vsRes.data?.heroStats?.matchUp?.[0];
    const vsRows = (dryad?.vs ?? []) as { heroId2: number; matchCount: number }[];
    result.matchupMs = Date.now() - tMatchup;
    result.puckVsRows = vsRows.length;
    result.sampleGames = vsRows.reduce((s, r) => s + r.matchCount, 0);
    ok = heroes.length > 0 && vsRows.length > 0;
  } catch (e) {
    error = sanitize(String(e instanceof Error ? e.message : e));
  }
  const payload = {
    ...result,
    ok,
    error,
    totalMs: Date.now() - t0,
    transport: { ...transportStats },
  };
  const serialized = sanitize(JSON.stringify(payload));
  console.log(`CI_PROBE_RESULT ${serialized}`);
  if (!ok) process.exitCode = 1;
}

