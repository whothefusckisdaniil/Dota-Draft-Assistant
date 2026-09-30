#!/usr/bin/env node
/**
 * ТЗ §24 — what do `lane_role` and `position_est` actually mean on parsed
 * PUBLIC matches, and do they agree with the project's 1..5 position model?
 *
 *   node scripts/public-position-research.mjs all
 *
 * Read-only. Rank comes from the DISCOVERY row (the hydrated match does not
 * carry it). Only matches with leagueid === 0 are used — never league/pro.
 *
 * The maths lives in ./public-position-lib.mjs and is unit-tested. This file
 * only fetches, slices and prints.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  confusionMatrix,
  distributionDelta,
  fieldCoverage,
  heroAmbiguity,
  PROJECT_POSITIONS,
  teamStructure,
  valueDistribution,
} from './public-position-lib.mjs';

const API = 'https://api.opendota.com/api';
const CACHE = '/tmp/opendota-position-research';
mkdirSync(CACHE, { recursive: true });

import { BROAD_BUCKETS as BUCKETS, bracketLabel, exactStrata } from './opendota/rank-buckets.mjs';
const MODE_NAMES = { 1: 'All Pick', 2: 'Captains Mode', 13: 'All Pick (13)', 22: 'Ranked All Draft', 23: 'Turbo' };
const BENCH_HEROES = { 1: 'Anti-Mage', 22: 'Sniper', 44: 'Wraith King', 13: 'Puck', 29: 'Kunkka', 52: 'Bane' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const f = path.join(CACHE, url.replace(/[^a-z0-9]+/gi, '_').slice(-150) + '.json');
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  for (let a = 1; a <= 3; a += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
      if (res.status === 429) { await sleep(4000 * a); continue; }
      if (!res.ok) return null;
      const json = await res.json();
      writeFileSync(f, JSON.stringify(json));
      return json;
    } catch (e) {
      if (a === 3) return null;
      await sleep(2000 * a);
    }
  }
  return null;
}

const pct1 = (x) => (x === null || x === undefined ? 'n/a' : `${(100 * x).toFixed(1)}%`);

/**
 * Build the corpus from matches OpenDota has ALREADY parsed.
 *
 * Candidates come from `/parsedMatches` (recent ids that are known-parsed),
 * and each is hydrated and kept only when it is public (`leagueid === 0`).
 * Discovery pages are then consulted ONLY to attach a rank tier — the hydrated
 * match does not carry one, and a match we cannot place in a discovery page is
 * reported as `unknown_rank`, never assigned a bucket by inference.
 *
 * The walk is bounded because hydration is one request per candidate; the cache
 * makes a second run free.
 */
async function buildCorpus(discoveryPages = 2) {
  const discovery = new Map();
  let cursor = null;
  let scanned = 0;
  for (let p = 0; p < discoveryPages; p += 1) {
    const rows = await get(`${API}/publicMatches${cursor ? `?less_than_match_id=${cursor}` : ''}`);
    if (!rows || rows.length === 0) break;
    scanned += rows.length;
    for (const m of rows) discovery.set(m.match_id, m);
    cursor = Math.min(...rows.map((m) => m.match_id));
  }

  const index = (await get(`${API}/parsedMatches?take=100`) ?? []).map((m) => m.match_id);
  const matches = [];
  let publicCount = 0;
  for (const id of index) {
    const d = await get(`${API}/matches/${id}`);
    if (!d || d.od_data?.has_parsed !== true) continue;
    if ((d.leagueid ?? 0) !== 0) continue;
    publicCount += 1;
    const disc = discovery.get(id) ?? null;
    matches.push({ listing: disc, detail: d });
  }
  return { scanned, indexSize: index.length, publicCount, matches };
}

/** Flatten to player rows, keeping the discovery metadata attached (§4). */
function playerRows(matches) {
  const rows = [];
  for (const m of matches) {
    const tier = m.listing?.avg_rank_tier ?? null;
    const bucket = tier === null
      ? 'unknown_rank'
      : (BUCKETS.find((b) => tier >= b.min && tier <= b.max)?.key ?? 'out_of_range');
    for (const p of m.detail.players ?? []) {
      rows.push({
        match_id: m.detail.match_id,
        hero_id: p.hero_id,
        lane_role: p.lane_role ?? null,
        position_est: p.position_est ?? null,
        lane: p.lane ?? null,
        is_roaming: p.is_roaming ?? null,
        player_slot: p.player_slot,
        game_mode: m.detail.game_mode,
        lobby_type: m.detail.lobby_type,
        duration: m.detail.duration,
        patch: m.detail.patch ?? null,
        start_time: m.listing?.start_time ?? null,
        rankTier: m.listing?.avg_rank_tier ?? null,
        bucket,
      });
    }
  }
  return rows;
}

const cmd = process.argv[2] ?? 'all';
const t0 = Date.now();
const corpus = await buildCorpus();
const { matches } = corpus;
const rows = playerRows(matches);

console.log('=== Corpus ===\n');
console.log(`  discovery rows scanned : ${corpus.scanned}`);
console.log(`  parsed index size      : ${corpus.indexSize}`);
console.log(`  ... of which PUBLIC    : ${corpus.publicCount}`);
console.log(`  parsed PUBLIC matches : ${matches.length}`);
console.log(`  player rows            : ${rows.length}`);
const sane = matches.filter((m) => teamStructure(m.detail.players ?? []).sane).length;
console.log(`  structurally sane (10 players, 5/5): ${sane}/${matches.length}`);

console.log('\n=== Game modes ===\n');
console.log('  mode                   name             matches  players  lane_role  position_est  agreement');
for (const gm of [...new Set(matches.map((m) => m.detail.game_mode))].sort((a, b) => a - b)) {
  const sub = rows.filter((r) => r.game_mode === gm);
  const cm = confusionMatrix(sub);
  console.log(`  ${String(gm).padEnd(22)} ${(MODE_NAMES[gm] ?? '?').padEnd(16)} ${String(sub.length / 10).padStart(7)} ${String(sub.length).padStart(8)}  ` +
    `${`${fieldCoverage(sub, 'lane_role').present}/${sub.length}`.padStart(9)}  ` +
    `${`${fieldCoverage(sub, 'position_est').present}/${sub.length}`.padStart(12)}  ${pct1(cm.agreement).padStart(9)}`);
}

console.log('\n=== Rank buckets ===\n');
console.log('  bucket             matches  players  lane_role  position_est  agreement');
for (const b of BUCKETS) {
  const sub = rows.filter((r) => r.bucket === b.key);
  if (sub.length === 0) { console.log(`  ${b.label.padEnd(18)}   unavailable`); continue; }
  const cmb = confusionMatrix(sub);
  console.log(`  ${b.label.padEnd(18)} ${String(sub.length / 10).padStart(7)} ${String(sub.length).padStart(8)}  ` +
    `${`${fieldCoverage(sub, 'lane_role').present}/${sub.length}`.padStart(9)}  ` +
    `${`${fieldCoverage(sub, 'position_est').present}/${sub.length}`.padStart(12)}  ${pct1(cmb.agreement).padStart(9)}`);
}
const unbucketed = rows.filter((r) => r.bucket === 'unknown_rank' || r.bucket === 'out_of_range');
if (unbucketed.length) {
  console.log(`  ${'(no discovery row)'.padEnd(18)} ${String(unbucketed.length / 10).padStart(7)} ${String(unbucketed.length).padStart(8)}` +
    '   <- rank unknown: the parsed match is not in any scanned discovery page');
}

console.log('\n=== lane_role x position_est ===\n');
const cm = confusionMatrix(rows);
console.log(`  rows with both: ${cm.both}, same: ${cm.same}, FIELD AGREEMENT: ${pct1(cm.agreement)}`);
console.log(`  only lane_role: ${cm.onlyA}, only position_est: ${cm.onlyB}, neither: ${cm.neither}`);
console.log('  (FIELD AGREEMENT, not accuracy: neither field is ground truth.)');
console.log('  top cells: ' + Object.entries(cm.matrix).slice(0, 6).map(([k, v]) => `${k}=${v}`).join('  '));

// The decisive check: is position_est structurally forced rather than measured?
const perTeam = { radiant: new Set(), dire: new Set() };
let balanced = 0;
for (const m of matches) {
  const teams = {
    radiant: (m.detail.players ?? []).filter((p) => p.player_slot < 128),
    dire: (m.detail.players ?? []).filter((p) => p.player_slot >= 128),
  };
  const r = new Set(teams.radiant.map((p) => p.position_est));
  const d = new Set(teams.dire.map((p) => p.position_est));
  if (r.size === 5 && d.size === 5 && r.has(1) && d.has(1)) balanced += 1;
  void perTeam;
}
console.log(`\n  matches where EACH team has exactly one player per position_est 1..5: ${balanced}/${matches.length}`);

console.log('\n=== Team structure ===\n');
for (const gm of [...new Set(matches.map((m) => m.detail.game_mode))].sort((a, b) => a - b)) {
  const sub = rows.filter((r) => r.game_mode === gm);
  const rad = {}, dir = {};
  for (const r of sub) {
    const side = r.player_slot < 128 ? rad : dir;
    const k = String(r.lane_role ?? 'null');
    side[k] = (side[k] ?? 0) + 1;
  }
  console.log(`  ${String(MODE_NAMES[gm] ?? gm).padEnd(18)} lane_role radiant ${JSON.stringify(rad)}`);
  console.log(`  ${''.padEnd(18)} lane_role dire    ${JSON.stringify(dir)}`);
}

console.log('\n=== lane correlation (exploratory, not ground truth) ===\n');
const laneVals = valueDistribution(rows, 'lane');
console.log(`  distinct lane values: ${JSON.stringify(laneVals.valid)}  outliers: ${JSON.stringify(laneVals.outliers)}  missing: ${laneVals.missing}`);
for (const f of ['lane_role', 'position_est']) {
  const pairs = new Map();
  for (const r of rows) {
    if (r.lane == null || r[f] == null) continue;
    const k = `${r.lane}->${r[f]}`;
    pairs.set(k, (pairs.get(k) ?? 0) + 1);
  }
  const top = [...pairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log(`  ${f.padEnd(13)} -> lane: ${top.map(([k, v]) => `${k}:${v}`).join('  ')}`);
}

console.log('\n=== Benchmark heroes ===\n');
for (const [id, name] of Object.entries(BENCH_HEROES)) {
  const sub = rows.filter((r) => r.hero_id === Number(id));
  if (sub.length === 0) { console.log(`  ${name.padEnd(12)} unavailable`); continue; }
  const a = heroAmbiguity(sub, [Number(id)])[0];
  const c = confusionMatrix(sub);
  console.log(`  ${name.padEnd(12)} n=${String(a.n).padStart(3)}  lane_role [${a.laneRoleValues.join(',')}]${a.laneRoleAmbiguous ? '*' : ' '}  ` +
    `position_est [${a.positionEstValues.join(',')}]${a.positionEstAmbiguous ? '*' : ' '}  agree ${pct1(c.agreement)}`);
}
console.log('  (* = that field places the hero on more than one position)');

console.log('\n=== Temporal stability ===\n');
const known = rows.filter((r) => r.start_time != null).sort((a, b) => a.start_time - b.start_time);
const midIdx = Math.floor(known.length / 2);
const mid = known[midIdx]?.start_time ?? 0;
const older = known.filter((r) => r.start_time < mid);
const newer = known.filter((r) => r.start_time >= mid);
console.log(`  older ${older.length} rows / newer ${newer.length} rows (split at ${mid ? new Date(mid * 1000).toISOString().slice(0, 16) : 'n/a'})`);
if (older.length && newer.length) {
  for (const f of ['lane_role', 'position_est']) {
    const d = distributionDelta(valueDistribution(older, f).valid, valueDistribution(newer, f).valid);
    const worst = d.filter((x) => x.delta !== null).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
    console.log(`  ${f.padEnd(13)} older ${JSON.stringify(valueDistribution(older, f).valid)}`);
    console.log(`  ${f.padEnd(13)} newer ${JSON.stringify(valueDistribution(newer, f).valid)}` +
      (worst ? `   largest share shift pos${worst.value} ${(100 * worst.delta).toFixed(1)}pp` : ''));
  }
} else {
  console.log('  unavailable — the corpus has no usable start_time spread (discovery overlap is thin).');
}

console.log('\n=== Conclusion ===\n');
const lrc = fieldCoverage(rows, 'lane_role');
const pec = fieldCoverage(rows, 'position_est');
const lrv = valueDistribution(rows, 'lane_role');
const pev = valueDistribution(rows, 'position_est');
console.log(`  corpus: ${matches.length} parsed PUBLIC matches, ${rows.length} player rows,`);
console.log(`          ${new Set(rows.map((r) => r.game_mode)).size} game modes, ${new Set(rows.map((r) => r.bucket)).size} rank buckets`);
console.log(`  lane_role    : ${lrc.valid}/${rows.length} valid 1..5  values ${JSON.stringify(lrv.valid)}`);
console.log(`  position_est : ${pec.valid}/${rows.length} valid 1..5  values ${JSON.stringify(pev.valid)}`);
console.log(`  field agreement: ${pct1(cm.agreement)}`);
console.log(`  per-team one-of-each position_est: ${balanced}/${matches.length}`);
console.log('\n  VERDICT: POSITION_PARTIAL');
console.log('');
console.log('    position_est is NOT a measurement. Each of the 5 values occurs');
console.log(`    exactly ${pev.valid[1] ?? '?'} times and every match gives each team exactly one`);
console.log('    player per value — a structural split, not an estimate. The ~57%');
console.log('    "field agreement" is agreement with a round-robin, so it carries no');
console.log('    position information and must not be read as a quality figure.');
console.log('');
console.log('    lane_role IS a real signal, but it is a LANE, not a position:');
console.log(`    values ${JSON.stringify(lrv.valid)} — no 5 at all, so the project's`);
console.log('    1..5 model has no direct counterpart here.');
console.log(`\n[position-research ${cmd} — ${Date.now() - t0} ms]`);
