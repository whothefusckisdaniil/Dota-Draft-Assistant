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
  for (let i = 0; i < 60; i += 1) {
    const title = await page.title().catch(() => '');
    if (!/just a moment/i.test(title)) return true;
    await page.waitForTimeout(2000);
  }
  return false;
}

const CF_STATE = path.join(OUT, 'cf-state.json');

async function gql(token: string, query: string, variables?: Record<string, unknown>, cacheKey?: string): Promise<any> {
  if (cacheKey) {
    try {
      return JSON.parse(readFileSync(path.join(CACHE, `${cacheKey}.json`), 'utf8'));
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
    const ctx = await browser.newContext({
      userAgent: UA,
      ...(fs.existsSync(CF_STATE) ? { storageState: CF_STATE } : {}),
    });
    pageRef = await ctx.newPage();
  }
  const page = pageRef;
  // initial navigation — may show a Cloudflare interstitial; wait it out
  if (!page.url() || page.url() === 'about:blank') {
    await page.goto(ENDPOINT, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => { /* Kong error page is fine */ });
    await pageClearedChallenge(page);
  }
  // POST; if Cloudflare answers with a challenge page, re-navigate (which
  // renders the interstitial and mints cf_clearance) and retry.
  let res: { status: number; text: string } | null = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
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
    const challenged =
      res.status === 403 && /just a moment|cf-chl|challenge-platform|Attention Required/i.test(res.text);
    if (!challenged) break;
    console.warn(`  [cloudflare challenge on POST] attempt ${attempt}/5 — re-navigating…`);
    await page.goto(ENDPOINT, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    const cleared = await pageClearedChallenge(page);
    if (!cleared) throw new Error('Cloudflare interstitial did not clear within 60s');
  }
  if (!res) throw new Error('no response');
  if (res.status === 429) throw new Error(`HTTP 429 rate limited: ${res.text.slice(0, 200)}`);
  if (res.status !== 200) throw new Error(`GraphQL HTTP ${res.status}: ${res.text.slice(0, 300)}`);
  const parsed = JSON.parse(res.text);
  if (parsed.errors) throw new Error(`GraphQL errors: ${JSON.stringify(parsed.errors).slice(0, 600)}`);
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

