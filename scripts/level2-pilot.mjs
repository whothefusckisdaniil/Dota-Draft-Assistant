#!/usr/bin/env node
/**
 * ТЗ №28 — Controlled Level-2 pilot.
 *
 *   node scripts/level2-pilot.mjs plan
 *   node scripts/level2-pilot.mjs all
 *
 * ТЗ №27 proved the bridge works: an OpenDota-discovered `match_id` hydrates
 * from STRATZ with an exact roster, agreeing result and final inventory.
 * What is still unknown is whether the resulting `Hero × Position × Enemy`
 * layer carries ENOUGH support to build anything on.
 *
 * That is what this measures. Fixed sample: 400 rank-filtered public matches,
 * 100 per broad bucket, declared before the crawl and not revised after.
 *
 * What this deliberately does NOT do — compute a winrate, a lift, a score or a
 * recommendation. `wins` and `losses` are raw counts. The point of the pilot is
 * to measure support density, and that number must not be laundered into an
 * apparently usable ranking while it is still this thin.
 *
 * No OpenDota POST is issued. STRATZ is the read-only GraphQL query authorised
 * in ТЗ №27: no mutation operation, no write field, asserted at startup.
 * Production scoring, datasets, UI and workflows are untouched.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROAD_BUCKETS as BUCKETS, broadBucketOf, bracketLabel } from './opendota/rank-buckets.mjs';
import { StratzTransport } from './update-data-stratz.mjs';
import {
  BRIDGE_FAILURE,
  STRATZ_MATCH_QUERY,
  assertReadOnlyQuery,
  inventoryMultiset,
  resultFromOpenDota,
  sameRoster,
  splitInventory,
  sideOf,
} from './cross-source-match-lib.mjs';
import {
  MAX_DISCOVERY_ROWS_PER_BUCKET,
  POSITION_CLASS,
  SUPPORT_BINS_HE,
  SUPPORT_BINS_HP,
  TARGET_PER_BUCKET,
  TARGET_TOTAL,
  aggregateHeroPosition,
  aggregateItemCells,
  aggregateSupport,
  buildHeroEnemyRows,
  buildItemRows,
  bucketSupport,
  cellOverlap,
  compareAB,
  dedupeItemPresence,
  isItemClean,
  isResultClean,
  isTupleEligible,
  ontologyIntersection,
  positionClass,
  splitByMode,
  splitByRank,
  supportSummary,
} from './level2-pilot-lib.mjs';

// §34 — refuse to run at all if the query is not read-only.
assertReadOnlyQuery(STRATZ_MATCH_QUERY);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OPENDOTA = 'https://api.opendota.com/api';
const CACHE = '/tmp/opendota-level2-pilot';
mkdirSync(CACHE, { recursive: true });

/** §2 — the cursor validated in ТЗ №27, inside STRATZ's ingested region. */
const DISCOVERY_CURSOR = 9029900000;

/** §33 — this pilot's cache is its own; it never mixes with the №27 cache. */
const fDiscovery = path.join(CACHE, 'discovery.json');
const fBridge = path.join(CACHE, 'bridge.json');
const fRows = path.join(CACHE, 'rows.json');

const MODE_NAMES = { 1: 'All Pick', 2: 'Captains Mode', 13: 'All Pick (13)', 22: 'All Draft', 23: 'Turbo' };
const modeLabel = (id) => MODE_NAMES[id] ?? (typeof id === 'string' ? id : `mode_${id ?? 'unknown'}`);

/** §28 — archetype sanity heroes, counts only. */
const BENCH_HEROES = { 1: 'Anti-Mage', 22: 'Sniper', 44: 'Wraith King', 13: 'Puck', 29: 'Kunkka', 52: 'Bane' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => process.stderr.write(`${a.join(' ')}\n`);
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const writeJson = (f, v) => writeFileSync(f, JSON.stringify(v));

/** §34 — env first, then .env. Never written to cache, never printed. */
function loadToken() {
  const fromEnv = process.env.STRATZ_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const raw = readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*STRATZ_API_TOKEN\s*=\s*(.*?)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    }
  } catch { /* no .env */ }
  return null;
}

let lastOd = 0;
async function odGet(url, cacheName) {
  const f = path.join(CACHE, cacheName);
  if (existsSync(f)) {
    try { return { ok: true, cached: true, data: readJson(f) }; } catch { /* refetch */ }
  }
  for (let a = 1; a <= 4; a += 1) {
    const gap = 1300 - (Date.now() - lastOd);
    if (gap > 0) await sleep(gap);
    lastOd = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
      if (res.status === 429) { await sleep(6000 * a); continue; }
      if (!res.ok) return { ok: false };
      const json = await res.json();
      if (json && json.error) return { ok: false };
      writeJson(f, json);
      return { ok: true, cached: false, data: json };
    } catch {
      if (a === 4) return { ok: false };
      await sleep(2000 * a);
    }
  }
  return { ok: false };
}

/**
 * §2/§3 — discovery. First eligible rows, in discovery order.
 *
 *   /publicMatches  ->  leagueid === 0  ->  rank bucket  ->  first 100
 *
 * Never "take the ones STRATZ has": that would convert STRATZ coverage into a
 * selection bias and destroy the very hit rate this pilot measures.
 */
async function discover() {
  if (existsSync(fDiscovery)) return readJson(fDiscovery);
  const picked = [];
  const scanned = {};
  const counters = {
    discoveryScanned: 0,
    rankInBucket: 0,
    leagueUnknownAtDiscovery: 0,
    opendotaHydrated: 0,
    leagueConfirmedPublic: 0,
    leagueRejected: 0,
    hydrateFailed: 0,
    bucketFull: 0,
    selected: 0,
  };
  let cursor = DISCOVERY_CURSOR;
  let page = 0;
  const countFor = (key) => picked.filter((p) => p.bucket === key).length;

  while (!BUCKETS.every((b) => countFor(b.key) >= TARGET_PER_BUCKET)) {
    if (page > 1200) break; // the per-bucket ceiling is the real bound
    page += 1;
    const res = await odGet(`${OPENDOTA}/publicMatches?less_than_match_id=${cursor}`, `discovery-page-${page}.json`);
    const rows = res.ok && Array.isArray(res.data) ? res.data : [];
    if (!rows.length) break;

    for (const m of rows) {
      if (typeof m?.avg_rank_tier !== 'number') continue;
      const bucket = broadBucketOf(m.avg_rank_tier);
      if (!bucket) continue;
      counters.discoveryScanned += 1;
      // §3 — the ceiling counts rows EXAMINED per bucket, so a sparse bucket
      // cannot be silently helped by scanning further.
      if ((scanned[bucket.key] ?? 0) >= MAX_DISCOVERY_ROWS_PER_BUCKET) continue;
      scanned[bucket.key] = (scanned[bucket.key] ?? 0) + 1;
      counters.rankInBucket += 1;
      // §28.1 — `/publicMatches` does NOT expose `leagueid` (verified over
      // 21 100 rows). Status is unknown here and must be confirmed below.
      counters.leagueUnknownAtDiscovery += 1;
      if (countFor(bucket.key) >= TARGET_PER_BUCKET) { counters.bucketFull += 1; continue; }

      // §28.1 §3 — a candidate only occupies one of the 100 slots AFTER
      // /matches/{id} confirms `leagueid === 0`. Checking later would let a
      // league match eat a pre-registered slot and shrink the sample.
      const det = await odGet(`${OPENDOTA}/matches/${m.match_id}`, `opendota-${m.match_id}.json`);
      if (!det.ok || !det.data) { counters.hydrateFailed += 1; continue; }
      counters.opendotaHydrated += 1;
      if (det.data.leagueid !== 0) { counters.leagueRejected += 1; continue; }
      counters.leagueConfirmedPublic += 1;
      counters.selected += 1;
      picked.push({
        matchId: m.match_id,
        avgRankTier: m.avg_rank_tier,
        bucket: bucket.key,
        bracket: bracketLabel(m.avg_rank_tier),
        leagueStatus: 'public_confirmed',
        startTime: m.start_time ?? null,
      });
    }
    const ids = rows.map((r) => r.match_id).filter((x) => typeof x === 'number');
    if (!ids.length) break;
    cursor = Math.min(...ids);
    if (page % 10 === 0) log(`[discovery] page ${page}, selected ${picked.length}/${TARGET_TOTAL}, cursor ${cursor}`);
  }
  const out = { picked, scanned, counters, cursor, pages: page };
  writeJson(fDiscovery, out);
  return out;
}

/** §22/§23 — cross-checks against OpenDota, kept as measurements. */
async function hydrateOpenDota(picked) {
  const out = [];
  for (const row of picked) {
    const res = await odGet(`${OPENDOTA}/matches/${row.matchId}`, `opendota-${row.matchId}.json`);
    const d = res.ok ? res.data : null;
    out.push({ ...row, detail: d, ok: Boolean(d), leagueid: d?.leagueid ?? null });
  }
  return out;
}

/** §6 — identity is the bridge invariant. */
async function hydrateStratz(transport, matchId) {
  try {
    const res = await transport.query(STRATZ_MATCH_QUERY, { id: matchId });
    const m = res?.data?.match;
    if (!m) return { ok: false, reason: BRIDGE_FAILURE.STRATZ_NOT_FOUND, match: null };
    if (Number(m.id) !== Number(matchId)) {
      return { ok: false, reason: BRIDGE_FAILURE.STRATZ_ID_MISMATCH, match: null };
    }
    return { ok: true, reason: null, match: m };
  } catch (e) {
    const msg = String(e?.message ?? '');
    const reason = /429/.test(msg) ? BRIDGE_FAILURE.STRATZ_HTTP_ERROR
      : /GraphQL errors/i.test(msg) ? BRIDGE_FAILURE.STRATZ_GRAPHQL_ERROR
        : BRIDGE_FAILURE.STRATZ_HTTP_ERROR;
    return { ok: false, reason, match: null };
  }
}

/** §21 — position coverage is a class, never a rejection. */
function bridgeOne(sel, st) {
  const m = st.match;
  const players = m?.players ?? [];
  const odRoster = (sel.detail?.players ?? [])
    .filter((p) => p?.hero_id !== undefined)
    .map((p) => ({ src: p, heroId: p.hero_id, isRadiant: (p.player_slot ?? 0) < 128 }));
  const roster = sameRoster(odRoster, players);

  let resultChecked = 0; let resultMismatches = 0;
  let itemCompared = 0; let itemMismatch = 0;
  const itemStatuses = [];
  const byKey = new Map(odRoster.map((p) => [`${p.heroId}:${p.isRadiant ? 'R' : 'D'}`, p.src]));
  for (const sp of players) {
    const key = `${sp?.heroId}:${sideOf(sp)}`;
    const op = byKey.get(key);
    if (!op) continue;
    const odWin = resultFromOpenDota(op, sel.detail?.radiant_win);
    if (odWin !== null && typeof sp?.isVictory === 'boolean') {
      resultChecked += 1;
      if (odWin !== sp.isVictory) resultMismatches += 1;
    }
    const odItems = [0, 1, 2, 3, 4, 5].map((i) => op[`item_${i}`]).filter((x) => typeof x === 'number' && x > 0);
    const stItems = splitInventory(sp).finalInventory;
    if (odItems.length || stItems.length) {
      itemCompared += 1;
      const cmp = inventoryMultiset(odItems, stItems);
      itemStatuses.push(cmp.status);
      if (cmp.status !== 'exact') itemMismatch += 1;
    }
  }

  return {
    matchId: sel.matchId,
    bucket: sel.bucket,
    bracket: sel.bracket,
    avgRankTier: sel.avgRankTier,
    startTime: sel.startTime,
    ok: st.ok,
    reason: st.reason,
    rosterExact: roster.exact,
    positionClass: positionClass(players),
    players,
    mode: m?.gameMode ?? null,
    odMode: sel.detail?.game_mode ?? null,
    resultChecked, resultMismatches,
    itemCompared, itemMismatch, itemStatuses,
    hasParsed: sel.detail?.od_data?.has_parsed === true,
    leagueid: sel.detail?.leagueid ?? null,
    duration: sel.detail?.duration ?? null,
  };
}

/* ---------------------------------------------------------------- payload */

const H = (t) => `\n=== ${t} ===`;
const pct1 = (x) => (x === null || x === undefined ? 'n/a' : `${(100 * x).toFixed(1)}%`);

/** Assemble the raw Layer-2 tuples and their aggregates. */
function buildPayload(bridged, selection = {}) {
  // §28.2 §5 — bridge_ok is not tuple_eligible. Gates are applied by MATCH, so
  // a roster or integrity problem removes the whole match rather than silently
  // dropping one player's rows.
  const eligible = bridged.filter(isTupleEligible);
  const resultClean = bridged.filter(isResultClean);
  const itemClean = bridged.filter(isItemClean);
  const byId = (list) => new Set(list.map((b) => b.matchId));
  const playersByMatch = new Map(eligible.map((b) => [b.matchId, b.players]));
  const inventoryByMatch = new Map();
  for (const b of eligible) {
    for (const p of b.players) inventoryByMatch.set(`${b.matchId}|${p.heroId}`, splitInventory(p));
  }
  const { rows: heRows, failures: enemyFailures } = buildHeroEnemyRows(eligible, playersByMatch);
  const itemRows = buildItemRows(heRows, inventoryByMatch);

  // Result aggregates only see result-clean matches; item aggregates only
  // item-clean ones. On this pilot both sets equal `eligible` (0 mismatches),
  // but the separation is what makes a future mismatch non-contaminating.
  const keepResult = byId(resultClean);
  const keepItem = byId(itemClean);
  const resultRows = heRows.filter((r) => keepResult.has(r.matchId));
  const itemRowsClean = itemRows.filter((r) => keepItem.has(r.matchId));

  const gates = {
    bridged: bridged.length,
    bridgeOk: bridged.filter((b) => b.ok).length,
    tupleEligible: eligible.length,
    resultClean: resultClean.length,
    itemClean: itemClean.length,
    excludedRoster: bridged.filter((b) => b.ok && !b.rosterExact).length,
    excludedResult: eligible.length - resultClean.length,
    excludedItem: eligible.length - itemClean.length,
  };

  // §28.2 §2 — A/B is per bucket, on the MATCH grain.
  const ab = {};
  for (const bk of BUCKETS) {
    const mine = eligible.filter((b) => b.bucket === bk.key);
    ab[bk.key] = compareAB(mine, playersByMatch, inventoryByMatch);
  }
  ab.__all__ = compareAB(eligible, playersByMatch, inventoryByMatch);

  return {
    bridged,
    heRows,
    itemRows: itemRowsClean,
    resultRows,
    enemyFailures,
    selection,
    gates,
    ab,
    cells: aggregateSupport(heRows, itemRowsClean),
    itemCells: aggregateItemCells(itemRowsClean),
    hpCells: aggregateHeroPosition(heRows),
  };
}

/* ----------------------------------------------------------------- report */

function printReport(d) {
  const o = [];
  const p = (s = '') => o.push(s);
  const bridged = d.bridged ?? [];
  const ok = bridged.filter((b) => b.ok);
  const total = bridged.length;
  const modeName = (v) => (v === null || v === undefined ? 'unknown' : modeLabel(v));

  p(H('Experiment'));
  p(`target sample           : ${TARGET_PER_BUCKET}/bucket, ${TARGET_TOTAL} total`);
  p(`selected discovery rows : ${total}`);
  p(`successfully hydrated    : ${ok.length}`);
  p('selection != hydration: a match STRATZ does not have is recorded as');
  p('STRATZ_NOT_FOUND and never replaced by another candidate (§5).');

  p(H('Discovery'));
  // §28.1 §5 — the selection funnel, with league status shown as a SOURCE
  // property: /publicMatches does not expose leagueid at all.
  const sel = d.selection ?? {};
  const c = sel.counters ?? {};
  p('  /publicMatches does not expose `leagueid`; league status is unresolved at');
  p('  discovery and confirmed from /matches/{match_id} before a slot is filled.');
  p(`  discovery_scanned            : ${c.discoveryScanned ?? 'n/a'}`);
  p(`  rank_in_bucket               : ${c.rankInBucket ?? 'n/a'}`);
  p(`  league_unknown_at_discovery  : ${c.leagueUnknownAtDiscovery ?? 'n/a'}  (source property, not an error)`);
  p(`  opendota_hydrated            : ${c.opendotaHydrated ?? 'n/a'}`);
  p(`  league_confirmed_public      : ${c.leagueConfirmedPublic ?? 'n/a'}`);
  p(`  league_rejected              : ${c.leagueRejected ?? 'n/a'}`);
  p(`  hydrate_failed               : ${c.hydrateFailed ?? 'n/a'}`);
  p(`  selected                     : ${c.selected ?? 'n/a'}`);
  p(`  bucket already full          : ${c.bucketFull ?? 'n/a'}`);
  p(`  rows examined per bucket     : ${JSON.stringify(sel.scanned ?? {})}`);
  p('');
  p('  bucket            selected  stratz_ok  rosterExact  fullPos  partialPos  nonePos');
  for (const bk of BUCKETS) {
    const mine = bridged.filter((b) => b.bucket === bk.key);
    const good = mine.filter((b) => b.ok);
    const cls = (c) => good.filter((b) => b.positionClass === c).length;
    p(`  ${bk.label.padEnd(16)} ${String(mine.length).padStart(8)}  ${String(good.length).padStart(9)}  ${String(good.filter((b) => b.rosterExact).length).padStart(11)}  ${String(cls(POSITION_CLASS.FULL)).padStart(7)}  ${String(cls(POSITION_CLASS.PARTIAL)).padStart(11)}  ${String(cls(POSITION_CLASS.NONE)).padStart(8)}`);
  }
  const short = BUCKETS.filter((bk) => bridged.filter((b) => b.bucket === bk.key).length < TARGET_PER_BUCKET);
  if (short.length) {
    p(`  LIMITATION: under target -> ${short.map((b) => `${b.label} (${bridged.filter((x) => x.bucket === b.key).length}/${TARGET_PER_BUCKET})`).join(', ')} — not widened after the fact (§3).`);
  }

  p(H('STRATZ hydration'));
  const reasons = {};
  for (const b of bridged) { const k = b.reason ?? 'NONE'; reasons[k] = (reasons[k] ?? 0) + 1; }
  for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) p(`  ${k.padEnd(26)} ${v}`);
  p(`hit rate                : ${total ? pct1(ok.length / total) : 'n/a'}`);

  p(H('Bridge integrity'));
  p(`exact 10-player roster  : ${ok.filter((b) => b.rosterExact).length}/${ok.length}`);
  p(`id mismatches           : ${bridged.filter((b) => b.reason === BRIDGE_FAILURE.STRATZ_ID_MISMATCH).length}`);
  p(`roster mismatches       : ${ok.filter((b) => !b.rosterExact).length}`);
  p(`enemy reconstruction err: ${(d.enemyFailures ?? []).length}`);
  // §28.2 §5 — the gates, made visible so an exclusion can never be silent.
  const g = d.gates ?? {};
  p('  --- eligibility gates (§28.2) ---');
  p(`  bridged            : ${g.bridged ?? 'n/a'}`);
  p(`  bridge_ok          : ${g.bridgeOk ?? 'n/a'}`);
  p(`  tuple_eligible     : ${g.tupleEligible ?? 'n/a'}   (identity + exact roster)`);
  p(`  excluded: roster   : ${g.excludedRoster ?? 'n/a'}`);
  p(`  result_clean       : ${g.resultClean ?? 'n/a'}   excluded: ${g.excludedResult ?? 'n/a'}`);
  p(`  item_clean         : ${g.itemClean ?? 'n/a'}   excluded: ${g.excludedItem ?? 'n/a'}`);

  p(H('Position coverage'));
  const pc = {};
  for (const b of ok) pc[b.positionClass] = (pc[b.positionClass] ?? 0) + 1;
  for (const c of Object.values(POSITION_CLASS)) p(`  ${c.padEnd(18)} ${pc[c] ?? 0}`);
  p('A match with no position is a VALID match with invalid positional');
  p('enrichment — not a bridge failure (§21).');

  p(H('Hero x Position support'));
  p(`cells : ${d.hpCells.length}`);
  p('bin       cells');
  for (const b of bucketSupport(d.hpCells, SUPPORT_BINS_HP)) p(`  ${String(b.label).padEnd(8)} ${b.cells}`);

  p(H('Hero x Position x Enemy support'));
  p(`observations : ${(d.heRows ?? []).length}`);
  p(`cells        : ${d.cells.length}`);
  p('bin       cells   observations');
  for (const b of bucketSupport(d.cells, SUPPORT_BINS_HE)) p(`  ${String(b.label).padEnd(8)} ${String(b.cells).padStart(5)} ${String(b.observations).padStart(13)}`);

  p(H('Hero x Position x Enemy x Item support'));
  p(`observations : ${(d.itemRows ?? []).length}`);
  p(`cells        : ${d.itemCells.length}`);
  p('bin       cells   observations');
  for (const b of bucketSupport(d.itemCells, SUPPORT_BINS_HE, (c) => c.matchesWithItem)) {
    p(`  ${String(b.label).padEnd(8)} ${String(b.cells).padStart(5)} ${String(b.observations).padStart(13)}`);
  }

  p(H('Item presence'));
  const items = new Map();
  for (const r of d.itemRows ?? []) items.set(r.itemId, (items.get(r.itemId) ?? 0) + 1);
  const top = [...items.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  p(`distinct items observed : ${items.size}`);
  p(`top items (raw counts)  : ${top.map(([k, v]) => `${k}=${v}`).join('  ') || 'n/a'}`);
  p('final inventory only; backpack and neutrals kept separate (§12).');

  p(H('Result integrity'));
  p(`rows compared : ${ok.reduce((a, b) => a + b.resultChecked, 0)}   mismatches : ${ok.reduce((a, b) => a + b.resultMismatches, 0)}`);

  p(H('Inventory integrity'));
  const stt = {};
  for (const b of ok) for (const s of b.itemStatuses) stt[s] = (stt[s] ?? 0) + 1;
  p(`rows compared : ${ok.reduce((a, b) => a + b.itemCompared, 0)}   status : ${Object.entries(stt).sort().map(([k, v]) => `${k}=${v}`).join('  ') || 'n/a'}`);

  p(H('Optional timing'));
  const parsed = bridged.filter((b) => b.hasParsed).length;
  p(`OpenDota has_parsed : ${parsed}/${total} (${pct1(total ? parsed / total : null)})`);
  p('§25: NO temporal cutoff is applied here. Raw coverage first; bridge');
  p('feasibility and temporal eligibility stay separate experiments.');

  p(H('Game modes'));
  const modeRows = new Map();
  for (const r of d.heRows ?? []) {
    const k = modeName(r.mode);
    if (!modeRows.has(k)) modeRows.set(k, { rows: 0, matches: new Set() });
    const e = modeRows.get(k);
    e.rows += 1; e.matches.add(r.matchId);
  }
  for (const [k, v] of [...modeRows.entries()].sort((a, b) => b[1].rows - a[1].rows)) {
    p(`  ${k.padEnd(24)} matches=${String(v.matches.size).padStart(4)} rows=${String(v.rows).padStart(6)}${v.rows < 100 ? '  observation only' : ''}`);
  }
  p('  counts only — no mode statistics, and modes are never blended silently.');

  p(H('Sample A/B'));
  p('§28.2 — the split is on MATCHES, per bucket, in selection order. An earlier');
  p('version halved the EXPANDED player x enemy rows, which cuts mid-match and');
  p('is not the registered experiment; those numbers are invalidated.');
  const ab = d.ab ?? {};
  const line = (label, c) => `  ${label.padEnd(18)} n=${String(c.n).padStart(3)} A=${String(c.aMatches).padStart(3)}/${String(c.aRows).padStart(5)} rows  B=${String(c.bMatches).padStart(3)}/${String(c.bRows).padStart(5)} rows   HxP j=${c.hp.jaccard === null ? 'n/a' : c.hp.jaccard.toFixed(3)}  HxPxE j=${c.hpe.jaccard === null ? 'n/a' : c.hpe.jaccard.toFixed(3)}`;
  for (const bk of BUCKETS) p(line(bk.label, ab[bk.key] ?? { n: 0, aMatches: 0, bMatches: 0, aRows: 0, bRows: 0, hp: { jaccard: null }, hpe: { jaccard: null } }));
  p(line('ALL BUCKETS', ab.__all__ ?? { n: 0, aMatches: 0, bMatches: 0, aRows: 0, bRows: 0, hp: { jaccard: null }, hpe: { jaccard: null } }));
  p('  shared cells: HxP / HxPxE are in the detail above; low HxPxE overlap means');
  p('  two discovery halves barely share anything but singletons.');

  p(H('Benchmark heroes'));
  const allRows = d.heRows ?? [];
  for (const [id, name] of Object.entries(BENCH_HEROES)) {
    const h = Number(id);
    const mine = allRows.filter((r) => r.heroId === h);
    const hp = (d.hpCells ?? []).filter((c) => c.heroId === h);
    const hpe = (d.cells ?? []).filter((c) => c.heroId === h);
    const hpei = (d.itemCells ?? []).filter((c) => c.heroId === h);
    p(`  ${name.padEnd(14)} rows=${String(mine.length).padStart(5)} matches=${String(new Set(mine.map((r) => r.matchId)).size).padStart(4)} HxP=${String(hp.length).padStart(3)} HxPxE=${String(hpe.length).padStart(5)} HxPxExI=${String(hpei.length).padStart(6)}`);
    const pos = {};
    for (const r of mine) pos[r.position] = (pos[r.position] ?? 0) + 1;
    p(`    positions: ${Object.entries(pos).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}`);
  }

  p(H('Conclusion'));
  const s10 = supportSummary(d.cells, 10);
  const s25 = supportSummary(d.cells, 25);
  const s50 = supportSummary(d.cells, 50);
  p(`  Hero x Position x Enemy cells : ${d.cells.length}`);
  p(`    support >= 10 : ${s10.cellsKept}    >= 25 : ${s25.cellsKept}    >= 50 : ${s50.cellsKept}`);
  p(`  Hero x Position cells         : ${d.hpCells.length}`);
  p('  NO winrate, lift, score or recommendation is computed (§14/§15).');
  p('');
  p('  Final inventory was observed AFTER the game and may reflect post-outcome');
  p('  decision making (§27). These tuples are observed associations, not');
  p('  recommended reactions to an enemy.');
  p('');
  const fullPos = ok.filter((b) => b.positionClass === POSITION_CLASS.FULL).length;
  let verdict;
  if (ok.length === 0 || allRows.length === 0) verdict = 'LEVEL2_BLOCKED';
  else if (s10.cellsKept === 0) verdict = 'LEVEL2_PARTIAL';
  else verdict = 'LEVEL2_PROMISING';
  p(`VERDICT: ${verdict}`);
  p(`  hydrated ${ok.length}/${total}, full-position ${fullPos}/${ok.length}, HxPxE rows ${allRows.length}`);
  if (verdict === 'LEVEL2_PROMISING') {
    p('  LEVEL2_PROMISING is NOT production-ready (§30). It means a stable flow of');
    p('  Hero + Position + Enemy + Item exists at pilot scale, nothing more.');
  }
  console.log(o.join('\n'));
}

/* -------------------------------------------------------------------- main */

const cmd = process.argv[2] ?? 'plan';

if (cmd === 'plan') {
  console.log(H('Controlled Level-2 pilot (ТЗ №28) — plan'));
  console.log(`target sample            : ${TARGET_PER_BUCKET}/bucket, ${TARGET_TOTAL} total (fixed before the crawl)`);
  console.log(`discovery ceiling/bucket : ${MAX_DISCOVERY_ROWS_PER_BUCKET} discovery rows EXAMINED`);
  console.log(`discovery cursor         : ${DISCOVERY_CURSOR} (inside STRATZ's ingested region, ТЗ §27)`);
  console.log(`selection order          : /publicMatches -> leagueid === 0 -> rank bucket -> first N eligible`);
  console.log(`rank source              : discovery row avg_rank_tier (never STRATZ averageRank)`);
  console.log(`position source          : STRATZ players[].position only (never lane_role / position_est)`);
  console.log(`support bins HxPxE       : ${SUPPORT_BINS_HE.map((b) => b.label).join(', ')}`);
  console.log(`support bins HxP         : ${SUPPORT_BINS_HP.map((b) => b.label).join(', ')}`);
  console.log(`position classes        : ${Object.values(POSITION_CLASS).join(' | ')}`);
  console.log(`cache                    : ${CACHE}`);
  console.log('');
  console.log('Not measured here, on purpose:');
  console.log('  - no winrate, lift, score, ranking or recommendation (§14/§15 raw counts only)');
  console.log('  - no temporal cutoff from ТЗ §26 (§25 — raw coverage first)');
  console.log('  - no production dataset (§35)');
  console.log('');
  console.log('Transport: OpenDota GET only. STRATZ is the read-only GraphQL query');
  console.log('authorised in ТЗ §27 — no mutation, asserted at startup and by test.');
  process.exitCode = 0;
} else if (cmd === 'all') {
  if (existsSync(fRows) && process.argv.includes('--report')) {
    printReport(readJson(fRows));
    process.exitCode = 0;
  } else {
    const token = loadToken();
    if (!token) {
      log('FATAL: STRATZ_API_TOKEN not found in environment or .env');
      process.exit(2);
    }
    log('[level2] STRATZ_API_TOKEN -> REDACTED');

    const { picked, scanned, counters } = await discover();
    log(`[level2] discovery: ${picked.length}/${TARGET_TOTAL} selected (${JSON.stringify(counters)})`);
    if (picked.length === 0) { log('[level2] nothing discovered'); process.exit(3); }

    const sel = await hydrateOpenDota(picked);
    log(`[level2] OpenDota detail: ${sel.filter((s) => s.ok).length}/${sel.length}`);

    // Resume: hydration is persisted after EVERY match, so an interrupted run
    // loses at most one request rather than the whole crawl.
    const done = new Map();
    if (existsSync(fBridge)) for (const b of readJson(fBridge)) done.set(b.matchId, b);

    const transport = new StratzTransport(token);
    const bridged = [...done.values()];
    try {
      await transport.init();
      for (const s of sel) {
        if (done.has(s.matchId)) continue;
        const b = bridgeOne(s, await hydrateStratz(transport, s.matchId));
        bridged.push(b);
        writeJson(fBridge, bridged);
        if (bridged.length % 20 === 0) log(`[level2] STRATZ ${bridged.length}/${sel.length}`);
      }
    } finally {
      await transport.close();
    }
    log(`[level2] STRATZ hydrated: ${bridged.filter((b) => b.ok).length}/${bridged.length}`);

    const payload = buildPayload(bridged, { counters, scanned, discoveryPages: sel.pages ?? null });
    writeJson(fRows, payload);
    printReport(payload);
    process.exitCode = 0;
  }
} else {
  console.error(`unknown command: ${cmd}`);
  console.error('usage: node scripts/level2-pilot.mjs [plan|all] [--report]');
  process.exitCode = 1;
}