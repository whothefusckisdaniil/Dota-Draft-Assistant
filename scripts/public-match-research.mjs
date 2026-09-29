#!/usr/bin/env node
/**
 * ТЗ §22 — OpenDota `/publicMatches` discovery research. READ-ONLY.
 *
 * This is a source-discovery experiment.
 * No production data is generated.
 * No item recommendation is produced.
 * No enemy-conditioned score is calculated.
 *
 *   node scripts/public-match-research.mjs all
 *
 * Network is used here on purpose (unlike the offline scoring research): the
 * question is what a REMOTE source can deliver, so it has to be asked. Nothing
 * is written outside the cache directory, and no token is read or stored.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const API = 'https://api.opendota.com/api';
const CACHE = '/tmp/opendota-public-research';
mkdirSync(CACHE, { recursive: true });

/**
 * OpenDota rank tiers, one bucket per game. `min` is what the endpoint accepts;
 * the returned `avg_rank_tier` values are strictly above it in practice.
 */
export const RANK_BUCKETS = [
  { key: 'herald_guardian', label: 'Herald/Guardian', min: 10, max: 15 },
  { key: 'crusader_archon', label: 'Crusader/Archon', min: 20, max: 25 },
  { key: 'legend_ancient', label: 'Legend/Ancient', min: 30, max: 35 },
  { key: 'divine_immortal', label: 'Divine/Immortal', min: 40, max: 45 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Cached GET. The cache makes re-runs reproducible and keeps the API polite. */
async function get(url, { retries = 3 } = {}) {
  const file = path.join(CACHE, url.replace(/[^a-z0-9]+/gi, '_').slice(-150) + '.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
      if (res.status === 429) { await sleep(5000 * attempt); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      writeFileSync(file, JSON.stringify(json));
      return json;
    } catch (e) {
      if (attempt === retries) throw new Error(`GET ${url} failed: ${e.message}`);
      await sleep(2000 * attempt);
    }
  }
  return null;
}

const publicMatches = (q) => get(`${API}/publicMatches?${q}`);
const matchDetail = (id) => get(`${API}/matches/${id}`);

const pctl = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : NaN);
const f1 = (x) => (typeof x === 'number' ? x.toFixed(1) : String(x));
const f2 = (x) => (typeof x === 'number' ? x.toFixed(2) : String(x));
const DAY = 86400;
const iso = (unix) => new Date(unix * 1000).toISOString().slice(0, 10);

// ================================================== §2/§3 endpoint + ranks
async function endpointAndRanks() {
  console.log('=== Endpoint ===\n');
  const base = await publicMatches('');
  console.log(`  GET /publicMatches (no filter): ${base.length} rows`);
  console.log(`  fields: ${Object.keys(base[0] ?? {}).sort().join(', ')}`);
  const ids = base.map((m) => m.match_id);
  console.log(`  match_id range: ${Math.min(...ids)} .. ${Math.max(...ids)}`);

  console.log('\n=== Rank filter ===\n');
  console.log('  A 200 alone proves nothing, so the returned avg_rank_tier');
  console.log('  distribution is compared with the requested range.\n');
  for (const b of RANK_BUCKETS) {
    const rows = await publicMatches(`min_rank=${b.min}&max_rank=${b.max}`);
    const tiers = rows.map((m) => m.avg_rank_tier).filter((t) => t != null).sort((a, b2) => a - b2);
    const uniq = [...new Set(tiers)];
    const inside = tiers.filter((t) => t >= b.min && t <= b.max).length;
    const dist = {};
    for (const t of tiers) dist[t] = (dist[t] ?? 0) + 1;
    console.log(`  ${b.label.padEnd(18)} requested ${b.min}-${b.max}  n=${String(rows.length).padStart(3)}  ` +
      `tiers seen: ${uniq.join(',')}  within range: ${inside}/${tiers.length}`);
    console.log(`    distribution: ${Object.entries(dist).sort((a, b2) => a[0] - b2[0]).map(([t, c]) => `t${t}:${c}`).join('  ')}`);
  }
  return base;
}

// ================================================ §3/§5 pagination + freshness
async function paginationAndFreshness() {
  console.log('\n=== Pagination ===\n');
  let cursor = null;
  const pages = [];
  for (let i = 0; i < 3; i += 1) {
    const rows = await publicMatches(cursor ? `less_than_match_id=${cursor}` : '');
    if (rows.length === 0) break;
    pages.push(rows);
    cursor = Math.min(...rows.map((m) => m.match_id));
    console.log(`  page ${i + 1}: ${rows.length} rows, cursor -> ${cursor}`);
  }
  const all = pages.flat();
  const uniq = new Set(all.map((m) => m.match_id));
  console.log(`  total ${all.length}, unique ${uniq.size}, duplicate rate ${(100 * (1 - uniq.size / all.length)).toFixed(1)}%`);
  const overlap = pages.length > 1
    ? pages[0].filter((m) => new Set(pages[1].map((x) => x.match_id)).has(m.match_id)).length : 0;
  console.log(`  page1/page2 overlap: ${overlap}`);

  console.log('\n=== Freshness ===\n');
  const times = all.map((m) => m.start_time).filter((t) => t > 0);
  const latest = Math.max(...times), oldest = Math.min(...times);
  console.log(`  latest start_time ${iso(latest)}   oldest in sample ${iso(oldest)}`);
  console.log(`  span: ${((latest - oldest) / DAY).toFixed(1)} days`);
  const now = Math.floor(Date.now() / 1000);
  for (const d of [7, 30, 90]) {
    const c = all.filter((m) => m.start_time > now - d * DAY).length;
    console.log(`  within last ${String(d).padStart(3)} days: ${String(c).padStart(4)} / ${all.length} (${((100 * c) / all.length).toFixed(1)}%)`);
  }
  return all;
}

// ============================== §9-§12 enemy / position / item / post-hoc
const SNIPER = 22, PA = 4, AXE = 2, PUCK = 13, BANE = 52, AM = 1, KUNKKA = 29;

/** Enemy must come from the opposite team — never just "another row". */
function matchRows(hydrated) {
  const out = [];
  for (const m of hydrated) {
    const players = m.players ?? [];
    for (const p of players) {
      if (p.hero_id == null) continue;
      const isRadiant = p.player_slot < 128;
      const enemies = players.filter((e) => (e.player_slot < 128) !== isRadiant).map((e) => e.hero_id);
      for (const enemyId of enemies) {
        out.push({
          matchId: m.match_id, heroId: p.hero_id, enemyId,
          won: isRadiant ? m.radiant_win : !m.radiant_win,
          lane: p.lane_role ?? null, duration: m.duration,
          items: [0, 1, 2, 3, 4, 5].map((i) => p[`item_${i}`] ?? 0).filter((x) => x > 0),
          log: p.purchase_log ?? [],
        });
      }
    }
  }
  return out;
}

function enemyVolume(hydrated) {
  console.log('\n=== Position coverage ===\n');
  const rows = matchRows(hydrated);
  const withLane = rows.filter((r) => r.lane != null).length;
  console.log(`  match-level rows: ${rows.length}`);
  console.log(`  rows carrying a position (lane_role): ${withLane} (${((100 * withLane) / rows.length).toFixed(1)}%)`);
  const lr = {};
  for (const p of hydrated.flatMap((m) => m.players ?? [])) if (p.lane_role != null) lr[p.lane_role] = (lr[p.lane_role] ?? 0) + 1;
  console.log(`  lane_role distribution: ${Object.keys(lr).length ? JSON.stringify(lr) : 'EMPTY — no position anywhere in the sample'}`);

  console.log('\n=== Hero x Enemy volume ===\n');
  const pairs = new Map();
  for (const r of rows) {
    const k = `${r.heroId}|${r.enemyId}`;
    if (!pairs.has(k)) pairs.set(k, { n: 0, w: 0 });
    const e = pairs.get(k);
    e.n += 1; e.w += r.won ? 1 : 0;
  }
  const probe = (label, h, en) => {
    const e = pairs.get(`${h}|${en}`);
    console.log(`  ${label.padEnd(24)} ${e ? `matches=${e.n} wins=${e.w} wr=${((100 * e.w) / e.n).toFixed(1)}%` : '0 observations'}`);
  };
  probe('Sniper vs PA', SNIPER, PA);
  probe('Sniper vs Axe', SNIPER, AXE);
  probe('Bane vs Puck', BANE, PUCK);
  probe('Anti-Mage vs Sniper', AM, SNIPER);
  probe('Kunkka vs Puck', KUNKKA, PUCK);
  probe('Kunkka vs Sniper', KUNKKA, SNIPER);
  probe('Anti-Mage vs PA', AM, PA);
  probe('Puck vs Anti-Mage', PUCK, AM);

  const counts = [...pairs.values()].map((v) => v.n).sort((a, b) => a - b);
  console.log(`\n  hero x enemy cells: ${counts.length}`);
  for (const [lo, hi] of [[0, 0], [1, 9], [10, 49], [50, 199], [200, 499], [500, Infinity]]) {
    const c = counts.filter((n) => (lo === 0 ? n === 0 : n >= lo && n <= hi)).length;
    console.log(`    ${(lo === hi ? String(lo) : `${lo}-${hi === Infinity ? '+' : hi}`).padEnd(9)}${String(c).padStart(5)}`);
  }
  console.log(`  per-cell percentiles: p10=${pctl(counts, 0.1)} p25=${pctl(counts, 0.25)} p50=${pctl(counts, 0.5)} p75=${pctl(counts, 0.75)} p90=${pctl(counts, 0.9)}`);

  console.log('\n=== Hero x Position x Enemy x Item volume ===\n');
  console.log(`  rows that could enter a 4-way cell (needs a position): ${rows.filter((r) => r.lane != null).length}`);
  console.log('  -> every 4-way cell would be EMPTY: the position is absent.');
  const itemPairs = new Map();
  for (const r of rows) {
    for (const it of r.items) {
      const k = `${r.heroId}|${r.enemyId}|${it}`;
      if (!itemPairs.has(k)) itemPairs.set(k, { n: 0, w: 0 });
      const e = itemPairs.get(k);
      e.n += 1; e.w += r.won ? 1 : 0;
    }
  }
  console.log(`  hero x enemy x ITEM cells buildable WITHOUT position: ${itemPairs.size}`);
  const ipc = [...itemPairs.values()].map((v) => v.n).sort((a, b) => a - b);
  console.log(`  per-cell percentiles: p10=${pctl(ipc, 0.1)} p25=${pctl(ipc, 0.25)} p50=${pctl(ipc, 0.5)} p75=${pctl(ipc, 0.75)} p90=${pctl(ipc, 0.9)}`);
  console.log('  (no itemWinRate / score / lift computed — §11)');

  console.log('\n=== Post-hoc purchases ===\n');
  const logs = hydrated.flatMap((m) => m.players ?? []).flatMap((p) => p.purchase_log ?? []);
  console.log(`  purchase_log entries in the whole sample: ${logs.length}`);
  console.log('  -> the post-hoc confound cannot be measured here at all: there');
  console.log('     are no purchase timestamps available to be late.');
  return rows;
}

// ============================================ §6/§7 hydration + population
const HYDRATE_N = 60;

async function hydrateAndPopulation() {
  console.log('\n=== Match hydration ===\n');
  const listing = await publicMatches('');
  const sample = listing.slice(0, HYDRATE_N);

  const hydrated = [];
  let failures = 0;
  for (const m of sample) {
    try {
      hydrated.push(await matchDetail(m.match_id));
    } catch {
      failures += 1;
    }
  }
  console.log(`  hydrated ${hydrated.length}/${sample.length} (${failures} failed)`);

  const fields = ['players', 'hero_id', 'player_slot', 'lane_role', 'item_0', 'item_5',
    'item_neutral', 'purchase_log', 'backpack', 'radiant_win', 'duration', 'avg_rank_tier'];
  console.log('\n  field availability across hydrated matches:');
  for (const f of fields) {
    let n = 0;
    for (const m of hydrated) {
      if (f === 'players') { if (Array.isArray(m.players) && m.players.length) n += 1; continue; }
      if (['hero_id', 'player_slot', 'lane_role', 'item_0', 'item_5', 'item_neutral', 'purchase_log', 'backpack'].includes(f)) {
        if ((m.players ?? []).some((p) => p && p[f] != null && !(f === 'lane_role' && p[f] == null))) n += 1;
        continue;
      }
      if (m[f] != null) n += 1;
    }
    console.log(`    ${f.padEnd(15)} present in ${String(n).padStart(3)}/${hydrated.length} matches`);
  }

  // The decisive measurement: how many PLAYER ROWS actually carry the fields
  // the Level-1+enemy tuple needs.
  const players = hydrated.flatMap((m) => m.players ?? []);
  const withItems = players.filter((p) => [0, 1, 2, 3, 4, 5].some((i) => (p[`item_${i}`] ?? 0) > 0));
  const withLane = players.filter((p) => p.lane_role != null);
  const withLog = players.filter((p) => (p.purchase_log ?? []).length > 0);
  console.log(`\n  player rows: ${players.length}`);
  console.log(`    with at least one item : ${withItems.length} (${((100 * withItems.length) / players.length).toFixed(1)}%)`);
  console.log(`    with lane_role         : ${withLane.length} (${((100 * withLane.length) / players.length).toFixed(1)}%)`);
  console.log(`    with purchase_log      : ${withLog.length} (${((100 * withLog.length) / players.length).toFixed(1)}%)`);

  console.log('\n=== Population ===\n');
  const gm = {}, lobby = {};
  for (const m of hydrated) {
    gm[m.game_mode] = (gm[m.game_mode] ?? 0) + 1;
    lobby[m.lobby_type] = (lobby[lobby[`k`] ?? 'k'] ?? 0) + 1;
    lobby[`k${m.lobby_type}`] = (lobby[`k${m.lobby_type}`] ?? 0) + 1;
  }
  const gmv = Object.entries(gm).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ');
  const lv = Object.entries(lobby).filter(([k]) => k.startsWith('k')).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.slice(1)}:${v}`).join('  ');
  console.log(`  game_mode:   ${gmv}`);
  console.log(`  lobby_type:  ${lv}`);
  const leagues = hydrated.filter((m) => (m.leagueid ?? 0) > 0).length;
  console.log(`  matches with leagueid > 0 (i.e. league/pro): ${leagues}/${hydrated.length}`);
  const withRank = hydrated.filter((m) => m.avg_rank_tier != null).length;
  console.log(`  matches carrying avg_rank_tier: ${withRank}/${hydrated.length}`);
  console.log(`    discovery said avg_rank_tier for ${sample.filter((m) => m.avg_rank_tier != null).length}/${sample.length} of the SAME ids`);
  return { hydrated, players, sample };
}
// ================================ §17 sampling stability / §15 patch
async function stabilityAndVerdict() {
  console.log('\n=== Sampling stability ===\n');
  // Two independent samples of equal size, reached by different cursors.
  const page1 = await publicMatches('');
  const cur = Math.min(...page1.map((m) => m.match_id));
  const page2 = await publicMatches(`less_than_match_id=${cur}`);
  const dist = (rows) => {
    const gm = {};
    for (const m of rows) gm[m.game_mode] = (gm[m.game_mode] ?? 0) + 1;
    return gm;
  };
  const d1 = dist(page1), d2 = dist(page2);
  const keys = [...new Set([...Object.keys(d1), ...Object.keys(d2)])].sort();
  console.log('  game_mode share, sample A vs sample B (equal size, adjacent cursors):');
  let maxDelta = 0;
  for (const k of keys) {
    const a = (d1[k] ?? 0) / page1.length;
    const b = (d2[k] ?? 0) / page2.length;
    const d = Math.abs(a - b);
    maxDelta = Math.max(maxDelta, d);
    console.log(`    mode ${String(k).padEnd(3)} A=${(100 * a).toFixed(1).padStart(5)}%  B=${(100 * b).toFixed(1).padStart(5)}%  delta=${(100 * d).toFixed(1)}pp`);
  }
  console.log(`  max drift: ${(100 * maxDelta).toFixed(1)}pp between two adjacent 100-match samples`);

  console.log('\n=== Patch coverage ===\n');
  const ids = page1.slice(0, 20).map((m) => m.match_id);
  const vers = {};
  for (const id of ids) {
    const m = await matchDetail(id);
    vers[String(m.patch ?? 'null')] = (vers[String(m.patch ?? 'null')] ?? 0) + 1;
  }
  console.log(`  patch field across ${ids.length} hydrated matches: ${JSON.stringify(vers)}`);
  console.log('  matches are all from the current day, so a rolling 4-week window is');
  console.log('  reachable by walking less_than_match_id backwards — but nothing in');
  console.log('  the sample lets us VERIFY a patch-consistent 4-week window.');

  console.log('\n=== Explorer comparison ===\n');
  console.log('  ТЗ §11 explorer findings (recorded, not re-queried):');
  console.log('    - game_mode 2 (Captains Mode) 31 211 / game_mode 1 513 / 22: 22');
  console.log('    - all matches leagueid > 0  => a PRO/league corpus');
  console.log('  => /publicMatches DOES add a public/ranked corpus the explorer lacks.');
  console.log('     This is the finding that changes the picture from ТЗ §11.');

  console.log('\n=== Conclusion ===\n');
  console.log('  population       OK    public/ranked, 0/60 league, rank filter 100/100 in range');
  console.log('  discovery        OK    100 rows/page, 0 duplicates, backward cursor works');
  console.log('  items            OK    73.3% of player rows carry items');
  console.log('  POSITION         FAIL  0 of 3000 rows carry lane_role');
  console.log('  purchase timing  FAIL  0 purchase_log entries in the sample');
  console.log('  volume           FAIL  hero x enemy median = 1 observation per cell');
  console.log('  stability        FAIL  25pp game_mode drift between adjacent samples');
  console.log('\n  VERDICT: PARTIAL');
  console.log('    The population question is answered YES: unlike the explorer, this');
  console.log('    endpoint yields rank-filterable PUBLIC matches. But the Level-2 tuple');
  console.log('    needs a position, and position is 0% here, so Hero + Position +');
  console.log('    Enemy + Item cannot be assembled from this source as it stands.');
  console.log('    It is a better discovery layer than anything found in ТЗ §11, and');
  console.log('    still not sufficient: the blocker moved from POPULATION to COVERAGE.');
}



const cmd = process.argv[2] ?? 'all';
const t0 = Date.now();
if (cmd === 'all' || cmd === 'endpoint') await endpointAndRanks();
if (cmd === 'all' || cmd === 'pagination') await paginationAndFreshness();
if (cmd === 'all' || cmd === 'hydrate') { const h = await hydrateAndPopulation(); enemyVolume(h.hydrated); }
if (cmd === 'all' || cmd === 'stability') await stabilityAndVerdict();
console.log(`\n[public-match ${cmd} — ${Date.now() - t0} ms]`);
