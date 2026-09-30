#!/usr/bin/env node
/**
 * ТЗ §26 — temporal eligibility research.
 *
 *   node scripts/public-temporal-research.mjs plan
 *   node scripts/public-temporal-research.mjs all
 *
 * GET-ONLY. There is no POST path in this file and no parser job is created;
 * the corpus is built exclusively from matches OpenDota has ALREADY parsed.
 *
 * Question: how much does the observable `Hero + Item` signal change when the
 * purchase window is truncated at 25/33/40/50/60/70/80/100% of match duration,
 * and is that signal stable across rank buckets, game modes and samples?
 *
 * What this script deliberately does NOT do: no enemy conditioning, no
 * positions, no winrate, no lift, no scoring. The maths lives in
 * ./public-temporal-lib.mjs and is unit-tested; this file fetches, slices and
 * prints.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BRACKETS, BROAD_BUCKETS as BUCKETS, broadBucketOf, bracketLabel } from './opendota/rank-buckets.mjs';
import {
  CUTOFFS,
  MIN_SAMPLE_FOR_CONCLUSION,
  SUPPORT_FLOORS,
  aggregateItemPresence,
  isValidPurchaseTime,
  lateFraction,
  rankCorrelation,
  rankedRows,
  relativePurchaseTime,
  topKOverlap,
} from './public-temporal-lib.mjs';

/**
 * `spearmanRho` must come from src/, NOT from a second implementation here.
 * It lives in TypeScript, and Node only strips types behind a flag (v22.17 here),
 * so a bare `node script.mjs` — the invocation the ТЗ prescribes — cannot import
 * it. Rather than mandate a flag nobody will remember, re-exec ourselves once
 * with the flag and the extension resolver.
 */
async function loadSpearman() {
  try {
    return (await import('../src/scoring/stats.ts')).spearmanRho;
  } catch (e) {
    if (e?.code !== 'ERR_UNKNOWN_FILE_EXTENSION') throw e;
  }
  if (process.env.OPENDOTA_RESEARCH_BOOTSTRAPPED === '1') {
    throw new Error('spearmanRho import still failing after re-exec');
  }
  const self = fileURLToPath(import.meta.url);
  const r = spawnSync(process.execPath, [
    '--experimental-strip-types',
    '--no-warnings',
    '--import', pathToFileURL(path.join(path.dirname(self), 'ts-ext-resolver.mjs')).href,
    self, ...process.argv.slice(2),
  ], { stdio: 'inherit', env: { ...process.env, OPENDOTA_RESEARCH_BOOTSTRAPPED: '1' } });
  process.exit(r.status ?? 1);
}
const spearmanRho = await loadSpearman();

const API = 'https://api.opendota.com/api';
const CACHE = '/tmp/opendota-temporal-research';
mkdirSync(CACHE, { recursive: true });

/** §3 — target and the crawl ceiling, fixed BEFORE any data is seen. */
const TARGET_PARSED_PER_BUCKET = 300;
const MAX_DISCOVERY_PER_BUCKET = 800;

/** §18 — sanity heroes, chosen for archetype reasons, not tuned afterwards. */
const BENCH_HEROES = { 1: 'Anti-Mage', 22: 'Sniper', 44: 'Wraith King', 13: 'Puck', 29: 'Kunkka', 52: 'Bane' };

/** §17 — consumables that are not ordinary core items. */
const SPECIAL_ITEMS = { aghanims_shard: 'Aghanim\'s Shard', aghanims_scepter: 'Aghanim\'s Scepter', aghanims_blessing: 'Aghanim\'s Blessing', moon_shard: 'Moon Shard' };

const MODE_NAMES = { 1: 'All Pick', 2: 'Captains Mode', 13: 'All Pick (13)', 22: 'Ranked All Draft', 23: 'Turbo' };
const modeLabel = (id) => MODE_NAMES[id] ?? `mode_${id}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => process.stderr.write(`${a.join(' ')}\n`);

/**
 * GET only. Nothing is ever written back to OpenDota.
 *
 * Requests are PACED. The public endpoint allows ~60/min; the first crawl of
 * this script ignored that and the API answered 429 with a 38-byte JSON error
 * body, which `res.ok` would have thrown away silently — the first draft of the
 * corpus build reported a 0% parse rate that was entirely this artefact.
 */
const MIN_REQUEST_GAP_MS = 1300;
let lastRequestAt = 0;

async function get(url) {
  const f = path.join(CACHE, url.replace(/[^a-z0-9]+/gi, '_').slice(-150) + '.json');
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  for (let a = 1; a <= 4; a += 1) {
    const gap = MIN_REQUEST_GAP_MS - (Date.now() - lastRequestAt);
    if (gap > 0) await sleep(gap);
    lastRequestAt = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
      if (res.status === 429) { log(`429, backing off`); await sleep(6000 * a); continue; }
      if (!res.ok) return null;
      const json = await res.json();
      // A 429 body can be cached only if it slipped through; refuse anything
      // that is not the payload we asked for.
      if (json && json.error) return null;
      writeFileSync(f, JSON.stringify(json));
      return json;
    } catch {
      if (a === 4) return null;
      await sleep(2000 * a);
    }
  }
  return null;
}


/**
 * §2/§3/§4 — build the corpus.
 *
 * `/publicMatches` is scanned page by page via `less_than_match_id`, per bucket,
 * because OpenDota offers no rank filter on that endpoint. Rank comes from the
 * DISCOVERY row (a hydrated match does not carry it), and only `leagueid === 0`
 * and `has_parsed === true` survive. `avg_rank_tier` is never inferred.
 *
 * Pages alternate into sample A / sample B (§23) so sampling stability can be
 * checked on two disjoint halves of the same bucket.
 */
async function buildCorpus() {
  const seen = new Set();
  const buckets = BUCKETS.map((b) => ({ ...b, parsed: [], scanned: 0, pages: 0 }));

  for (const b of buckets) {
    log(`[corpus] ${b.label}: scanning (cap ${MAX_DISCOVERY_PER_BUCKET} discovery rows)`);
    let cursor = null;
    while (b.scanned < MAX_DISCOVERY_PER_BUCKET && b.parsed.length < TARGET_PARSED_PER_BUCKET) {
      const rows = await get(`${API}/publicMatches${cursor ? `?less_than_match_id=${cursor}` : ''}`);
      if (!rows || rows.length === 0) break;
      b.pages += 1;

      for (const m of rows) {
        if (b.scanned >= MAX_DISCOVERY_PER_BUCKET) break;
        b.scanned += 1;
        if (typeof m?.avg_rank_tier !== 'number') continue;
        const tier = broadBucketOf(m.avg_rank_tier);
        if (!tier || tier.key !== b.key) continue;
        if (seen.has(m.match_id)) continue;
        seen.add(m.match_id);

        const detail = await get(`${API}/matches/${m.match_id}`);
        // §2: public only, already-parsed only. A missing detail is NOT
        // silently treated as unparsed.
        //
        // `has_parsed` lives under `od_data` on /matches/{id}; there is no
        // top-level field. Reading `detail.has_parsed` yields undefined for
        // every match and rejects the entire corpus.
        if (!detail || detail.leagueid !== 0 || detail.od_data?.has_parsed !== true) continue;

        const sample = b.pages % 2 === 1 ? 'A' : 'B';
        b.parsed.push({
          matchId: m.match_id,
          avgRankTier: m.avg_rank_tier,
          bracket: bracketLabel(m.avg_rank_tier),
          bucket: b.key,
          sample,
          gameMode: detail.game_mode,
          lobbyType: detail.lobby_type,
          patch: detail.patch,
          startTime: detail.start_time,
          duration: detail.duration,
          players: (detail.players ?? []).map(toPlayerRow),
        });
        if (b.parsed.length >= TARGET_PARSED_PER_BUCKET) break;
      }
      const ids = rows.map((r) => r.match_id).filter((x) => typeof x === 'number');
      if (!ids.length) break;
      cursor = Math.min(...ids);
      log(`[corpus] ${b.label}: page ${b.pages}, scanned ${b.scanned}, parsed ${b.parsed.length}`);
    }
    if (b.parsed.length < TARGET_PARSED_PER_BUCKET) {
      log(`[corpus] ${b.label}: LIMITATION available=${b.parsed.length} target=${TARGET_PARSED_PER_BUCKET} (crawl cap reached)`);
    }
  }
  return buckets;
}

/** One player's purchases for one match, flattened to what the maths needs. */
function toPlayerRow(p) {
  return {
    heroId: p?.hero_id ?? null,
    matchId: p?.match_id ?? null,
    events: (p?.purchase_log ?? [])
      .filter((e) => typeof e?.key === 'string' && e.key)
      .map((e) => ({ key: e.key, time: e.time })),
  };
}

/* ---------------------------------------------------------------- analysis */

const pct1 = (x) => (x === null || x === undefined ? 'n/a' : `${(100 * x).toFixed(1)}%`);
const num = (x, d = 3) => (x === null || x === undefined ? 'n/a' : x.toFixed(d));
const H = (t) => `\n=== ${t} ===`;

/** Flatten the corpus into (hero, match, duration) rows for a given slice. */
function playerRows(matches, { heroId = null, mode = null, sample = null } = {}) {
  const out = [];
  for (const m of matches) {
    if (sample && m.sample !== sample) continue;
    if (mode !== null && m.gameMode !== mode) continue;
    for (const p of m.players) {
      if (p.heroId === null) continue;
      if (heroId !== null && p.heroId !== heroId) continue;
      out.push({ matchId: m.matchId, heroId: p.heroId, duration: m.duration, events: p.events });
    }
  }
  return out;
}

/**
 * §21 — the minimum is expressed in MATCHES, not in player rows.
 *
 * Ten players per match inflate a 30-match slice to ~300 rows, so a
 * row-based gate would happily certify conclusions from 8 matches while
 * printing a confident-looking table. Every `n` in the report is matches.
 */
const matchCount = (rows) => new Set(rows.map((r) => r.matchId)).size;
const meetsMinimum = (rows) => matchCount(rows) >= MIN_SAMPLE_FOR_CONCLUSION;

/** Aggregate one slice at every cutoff. `by` picks presence vs events. */
function byCutoff(rows, cutoff, key) {
  const a = aggregateItemPresence(rows, cutoff);
  // §1 — rankedRows, never a local key-only sort: ties must resolve by itemId
  // or a ~20-match bucket's top-k becomes an artefact of crawl order.
  return { ...a, ranked: rankedRows(a.rows, key) };
}

/** §10 — how much of the ranking survives each pre-registered support floor. */
function supportSensitivity(rows, key) {
  const base = byCutoff(rows, 1.0, key);
  return SUPPORT_FLOORS.map((floor) => {
    const kept = base.rows.filter((r) => r.presenceMatches >= floor);
    return { floor, cellsKept: kept.length, cellsDropped: base.rows.length - kept.length };
  });
}

/** §11/§12 — stability of a slice against the 100% window, both views. */
function stability(rows, label) {
  const full = { presence: byCutoff(rows, 1.0, 'presenceRate'), events: byCutoff(rows, 1.0, 'eventsPerHeroMatch') };
  const out = { label, nMatches: new Set(rows.map((r) => r.matchId)).size, nRows: rows.length, cutoffs: [] };
  for (const c of CUTOFFS) {
    if (c === 1) continue;
    const row = { cutoff: c };
    for (const view of ['presence', 'events']) {
      const key = view === 'presence' ? 'presenceRate' : 'eventsPerHeroMatch';
      const cur = byCutoff(rows, c, key);
      const ref = full[view];
      row[view] = {
        items: cur.rows.length,
        spearman: rankCorrelation(cur.rows, ref.ranked, key, spearmanRho),
        top5: topKOverlap(cur.ranked, ref.ranked, 5, key).ratio,
        top10: topKOverlap(cur.ranked, ref.ranked, 10, key).ratio,
        top15: topKOverlap(cur.ranked, ref.ranked, 15, key).ratio,
      };
    }
    out.cutoffs.push(row);
  }
  return out;
}

/**
 * §5 — retention, and the denominator matters.
 *
 * Both denominators come from the FULL window (cutoff = 1.0) restricted to
 * valid in-match observations, NOT from raw event keys. Counting raw keys put
 * an item into the denominator when its only event was `time > duration`, so
 * `presenceRetained` at the 100% window could read below 100% — the report
 * appearing to lose data it had explicitly declared invalid. The excluded
 * events are reported separately so nothing is hidden.
 */
function retention(rows) {
  const rawEvents = rows.reduce((a, r) => a + r.events.length, 0);
  const full = aggregateItemPresence(rows, 1.0);
  const totalEvents = full.inWindow;
  const totalPresence = full.rows.reduce((s, r) => s + r.presenceMatches, 0);
  const out = [];
  for (const c of CUTOFFS) {
    const a = aggregateItemPresence(rows, c);
    const keptEvents = a.inWindow;
    const keptPresence = a.rows.reduce((s, r) => s + r.presenceMatches, 0);
    out.push({
      cutoff: c,
      eventsRetained: totalEvents ? keptEvents / totalEvents : null,
      presenceRetained: totalPresence ? keptPresence / totalPresence : null,
      eventsAfterCutoff: totalEvents ? a.afterCutoff / totalEvents : null,
    });
  }
  return {
    totalEvents, totalPresence, out,
    rawEvents,
    excludedEvents: rawEvents - totalEvents,
  };
}

/** §16 — how much of the early window is pre-horn, and does it matter. */
function preHornImpact(rows) {
  let events = 0; let pre = 0;
  const keptRows = []; const strippedRows = [];
  for (const r of rows) {
    const pos = r.events.filter((e) => e.time >= 0);
    const neg = r.events.filter((e) => typeof e.time === 'number' && e.time < 0);
    events += r.events.length; pre += neg.length;
    keptRows.push(r);
    strippedRows.push({ ...r, events: pos });
  }
  const cmp = (cut) => ({
    withPreHorn: aggregateItemPresence(keptRows, cut).rows.length,
    withoutPreHorn: aggregateItemPresence(strippedRows, cut).rows.length,
  });
  return { events, pre, preShare: events ? pre / events : null, comparison: [0.25, 0.5, 0.7].map((c) => ({ cutoff: c, ...cmp(c) })) };
}

/** §17 — consumables profiled separately, never folded into a core ranking. */
function specialItems(rows) {
  const out = [];
  for (const [key, label] of Object.entries(SPECIAL_ITEMS)) {
    const rel = [];
    let events = 0;
    let excluded = 0;
    const presenceKeys = new Set();
    for (const r of rows) {
      for (const e of r.events) {
        if (e.key !== key) continue;
        // §4 — the shared definition of a valid observation, so special-item
        // timing cannot drift from the rest of the study.
        if (!isValidPurchaseTime(e.time, r.duration)) { excluded += 1; continue; }
        events += 1;
        presenceKeys.add(`${r.heroId}:${r.matchId}`);
        rel.push(relativePurchaseTime(e.time, r.duration));
      }
    }
    rel.sort((a, b) => a - b);
    const q = (p) => (rel.length ? rel[Math.min(rel.length - 1, Math.floor(p * rel.length))] : null);
    out.push({
      item: key, label, events, excluded, presence: presenceKeys.size,
      heroMatches: rows.length,
      presenceRate: rows.length ? presenceKeys.size / rows.length : null,
      median: rel.length ? rel[Math.floor(rel.length / 2)] : null,
      p25: q(0.25), p75: q(0.75),
    });
  }
  return out;
}

/** §22 — the corpus spans patches; say so rather than blending silently. */
function patchCoverage(matches) {
  const counts = new Map();
  for (const m of matches) if (m.patch !== null && m.patch !== undefined) counts.set(m.patch, (counts.get(m.patch) ?? 0) + 1);
  const times = matches.map((m) => m.startTime).filter((t) => typeof t === 'number');
  const patches = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return {
    nPatches: counts.size,
    patches,
    dominant: patches[0]?.[0] ?? null,
    dominantShare: matches.length ? (patches[0]?.[1] ?? 0) / matches.length : null,
    latest: times.length ? Math.max(...times) : null,
    oldest: times.length ? Math.min(...times) : null,
  };
}

const iso = (t) => (t ? new Date(t * 1000).toISOString().slice(0, 10) : 'n/a');

/* ------------------------------------------------------------------ report */

/**
 * §28/§29/§30 — the report.
 *
 * Every figure is printed with its `n`, because a stability number computed on
 * 19 matches and the same number on 800 mean different things.
 */
function printReport(buckets) {
  const all = buckets.flatMap((b) => b.parsed);
  const rows = playerRows(all);
  const out = [];
  const p = (s = '') => out.push(s);

  p(H('Corpus'));
  p(`matches parsed & public : ${all.length}  (target ${TARGET_PARSED_PER_BUCKET} x ${buckets.length} = ${TARGET_PARSED_PER_BUCKET * buckets.length})`);
  p(`player-match rows       : ${rows.length}`);
  p(`purchase events         : ${rows.reduce((a, r) => a + r.events.length, 0)}`);
  p(`crawl cap / bucket      : ${MAX_DISCOVERY_PER_BUCKET} discovery rows`);

  p(H('Rank buckets'));
  for (const b of buckets) {
    const short = b.parsed.length < TARGET_PARSED_PER_BUCKET;
    p(`${b.label.padEnd(18)} n=${String(b.parsed.length).padStart(4)}  pages=${b.pages} scanned=${b.scanned}  ${short ? 'LIMITATION (under target)' : 'target met'}`);
    const brackets = new Map();
    for (const m of b.parsed) brackets.set(m.bracket, (brackets.get(m.bracket) ?? 0) + 1);
    p(`  brackets: ${[...brackets.entries()].map(([k, v]) => `${k}=${v}`).join('  ') || 'none'}`);
  }

  const modes = modeCounts(all);
  p(H('Game modes'));
  for (const [mode, n] of modes) {
    p(`${modeLabel(mode).padEnd(20)} n=${String(n).padStart(4)}  ${n < MIN_SAMPLE_FOR_CONCLUSION ? 'insufficient sample' : ''}`);
  }

  const cov = patchCoverage(all);
  p(H('Patch/time coverage'));
  p(`patches spanned : ${cov.nPatches}   dominant: ${cov.dominant} (${pct1(cov.dominantShare)})`);
  p(`distribution    : ${cov.patches.map(([k, v]) => `patch ${k}=${v}`).join('  ') || 'none'}`);
  p(`oldest start    : ${iso(cov.oldest)}`);
  p(`latest start    : ${iso(cov.latest)}`);
  if (cov.dominantShare !== null && cov.dominantShare < 0.7) {
    p('LIMITATION: corpus spans multiple patches; figures below blend them.');
  }

  const ret = retention(rows);
  p(H('Purchase timing distribution'));
  p(`median relative time : ${num(aggregateItemPresence(rows, 1).medianRelativeTime)}`);
  p(`events in signal    : ${ret.totalEvents}   unique (hero,match,item) presence rows: ${ret.totalPresence}`);
  p(`events excluded     : ${ret.excludedEvents} of ${ret.rawEvents} raw (time > duration / non-numeric / no duration)`);

  p(H('Post-hoc fractions'));
  p('cutoff   eventsRetained  presenceRetained  eventsAfterCutoff');
  for (const r of ret.out) {
    p(`${(r.cutoff * 100).toFixed(0).padStart(5)}%   ${pct1(r.eventsRetained).padStart(14)}  ${pct1(r.presenceRetained).padStart(16)}  ${pct1(r.eventsAfterCutoff).padStart(17)}`);
  }

  const ph = preHornImpact(rows);
  p(H('Pre-horn'));
  p(`pre-horn events : ${ph.pre} / ${ph.events}  (${pct1(ph.preShare)})`);
  p('cutoff   itemsWithPreHorn  itemsWithoutPreHorn');
  for (const c of ph.comparison) p(`${(c.cutoff * 100).toFixed(0).padStart(5)}%   ${String(c.withPreHorn).padStart(16)}  ${String(c.withoutPreHorn).padStart(19)}`);


  p(H('Presence signal'));
  p('cutoff   items  medianRelTime  preHorn  afterCutoff  afterDuration  afterDuration%');
  for (const c of CUTOFFS) {
    const a = aggregateItemPresence(rows, c);
    const share = a.totalEvents ? a.afterDuration / a.totalEvents : null;
    p(`${(c * 100).toFixed(0).padStart(5)}%   ${String(a.rows.length).padStart(5)}  ${num(a.medianRelativeTime).padStart(13)}  ${String(a.preHorn).padStart(7)}  ${String(a.afterCutoff).padStart(12)}  ${String(a.afterDuration).padStart(14)}  ${pct1(share).padStart(15)}`);
  }

  p(H('Event signal'));
  p('cutoff   eventsPerHeroMatch(max)  top item by events  top item by presence');
  for (const c of CUTOFFS) {
    const a = aggregateItemPresence(rows, c);
    const byE = rankedRows(a.rows, 'eventsPerHeroMatch')[0];
    const byP = rankedRows(a.rows, 'presenceRate')[0];
    p(`${(c * 100).toFixed(0).padStart(5)}%   ${num(byE?.eventsPerHeroMatch).padStart(22)}  ${(byE?.itemId ?? 'n/a').padEnd(22)}  ${byP?.itemId ?? 'n/a'}`);
  }

  const overall = stability(rows, 'ALL');
  p(H('Stability vs 100%'));
  p(`corpus rows=${overall.nRows}  matches n=${overall.nMatches}`);
  p('cutoff   presence: rho  top5  top10  top15    events: rho  top5  top10  top15');
  for (const c of overall.cutoffs) {
    p(`${(c.cutoff * 100).toFixed(0).padStart(5)}%   ${num(c.presence.spearman).padStart(15)} ${pct1(c.presence.top5).padStart(6)} ${pct1(c.presence.top10).padStart(6)} ${pct1(c.presence.top15).padStart(6)}    ${num(c.events.spearman).padStart(10)} ${pct1(c.events.top5).padStart(6)} ${pct1(c.events.top10).padStart(6)} ${pct1(c.events.top15).padStart(6)}`);
  }

  p(H('Rank stability'));
  for (const b of buckets) {
    const r = playerRows(b.parsed);
    if (!r.length) { p(`${b.label}: no data`); continue; }
    p(`--- ${b.label} (matches n=${b.parsed.length}, rows n=${r.length})`);
    const st = stability(r, b.label);
    for (const c of [0.5, 0.7]) {
      const s = st.cutoffs.find((x) => x.cutoff === c);
      p(`  ${(c * 100).toFixed(0)}% vs 100%: presence rho=${num(s.presence.spearman)} top10=${pct1(s.presence.top10)} | events rho=${num(s.events.spearman)} top10=${pct1(s.events.top10)}`);
    }
  }

  p(H('Mode stability'));
  for (const [mode, n] of modes) {
    const r = playerRows(all, { mode });
    p(`--- ${modeLabel(mode)} (n=${n})${n < MIN_SAMPLE_FOR_CONCLUSION ? '  insufficient sample — no conclusion drawn' : ''}`);
    if (n < MIN_SAMPLE_FOR_CONCLUSION) continue;
    const st = stability(r, modeLabel(mode));
    for (const c of [0.5, 0.7]) {
      const s = st.cutoffs.find((x) => x.cutoff === c);
      p(`  ${(c * 100).toFixed(0)}% vs 100%: presence rho=${num(s.presence.spearman)} top10=${pct1(s.presence.top10)} | events rho=${num(s.events.spearman)} top10=${pct1(s.events.top10)}`);
    }
  }

  p(H('Support sensitivity'));
  p('floor  cellsKept  cellsDropped   (presence rows at the 100% window)');
  const support = supportSensitivity(rows, 'presenceRate');
  for (const s of support) p(`${String(s.floor).padStart(5)}  ${String(s.cellsKept).padStart(9)}  ${String(s.cellsDropped).padStart(12)}`);
  p('top-10 overlap at 50% vs 100%, per bucket and floor:');
  for (const b of buckets) {
    const r = playerRows(b.parsed);
    if (!meetsMinimum(r)) { p(`  ${b.label.padEnd(18)} insufficient sample (matches n=${matchCount(r)})`); continue; }
    const cur = byCutoff(r, 0.5, 'presenceRate');
    const ref = byCutoff(r, 1.0, 'presenceRate');
    const line = SUPPORT_FLOORS.map((f) => {
      const a = cur.ranked.filter((x) => x.presenceMatches >= f);
      const c = ref.ranked.filter((x) => x.presenceMatches >= f);
      return `floor${f}=${pct1(topKOverlap(a, c, 10).ratio)}(${a.length})`;
    });
    p(`  ${b.label.padEnd(18)} ${line.join('  ')}`);
  }


  p(H('Benchmark heroes'));
  for (const [id, name] of Object.entries(BENCH_HEROES)) {
    const r = playerRows(all, { heroId: Number(id) });
    if (!meetsMinimum(r)) { p(`${name}: insufficient sample (matches n=${matchCount(r)})`); continue; }
    p(`--- ${name} (matches n=${matchCount(r)}, hero-rows n=${r.length})`);
    for (const c of [0.25, 0.5, 0.7, 1.0]) {
      const a = aggregateItemPresence(r, c);
      const topP = rankedRows(a.rows, 'presenceRate').slice(0, 5).map((x) => x.itemId);
      const topE = rankedRows(a.rows, 'eventsPerHeroMatch').slice(0, 5).map((x) => x.itemId);
      p(`  ${(c * 100).toFixed(0).padStart(3)}%: medianRel=${num(a.medianRelativeTime)}  top5presence=${topP.join(',')}  top5events=${topE.join(',')}`);
    }
  }

  p(H('Sampling stability'));
  p('§23: samples A and B are DISJOINT discovery pages of the same bucket.');
  for (const b of buckets) {
    const ra = playerRows(b.parsed, { sample: 'A' });
    const rb = playerRows(b.parsed, { sample: 'B' });
    if (!meetsMinimum(ra) || !meetsMinimum(rb)) {
      p(`${b.label}: insufficient sample (A matches n=${matchCount(ra)}, B matches n=${matchCount(rb)})`); continue;
    }
    const heroDist = tvd(ra.map((r) => r.heroId), rb.map((r) => r.heroId));
    const modeDist = tvd(ra.map((r) => all.find((m) => m.matchId === r.matchId)?.gameMode ?? -1), rb.map((r) => all.find((m) => m.matchId === r.matchId)?.gameMode ?? -1));
    const itemDist = tvd(ra.flatMap((r) => r.events.map((e) => e.key)), rb.flatMap((r) => r.events.map((e) => e.key)));
    const sa = stability(ra, 'A'); const sb = stability(rb, 'B');
    const f = (s) => (c) => s.cutoffs.find((x) => x.cutoff === c);
    p(`--- ${b.label} (A rows n=${ra.length}, B rows n=${rb.length})`);
    p(`  distribution TVD: hero=${num(heroDist)} mode=${num(modeDist)} item=${num(itemDist)}   (0 = identical, 1 = disjoint)`);
    p(`  50% vs 100%: A rho=${num(f(sa)(0.5).presence.spearman)} top10=${pct1(f(sa)(0.5).presence.top10)} | B rho=${num(f(sb)(0.5).presence.spearman)} top10=${pct1(f(sb)(0.5).presence.top10)}`);
    p(`  70% vs 100%: A rho=${num(f(sa)(0.7).presence.spearman)} top10=${pct1(f(sa)(0.7).presence.top10)} | B rho=${num(f(sb)(0.7).presence.spearman)} top10=${pct1(f(sb)(0.7).presence.top10)}`);
  }

  p(H('Special items'));
  p('item                      events  excl  presence  presenceRate  median  p25    p75');
  for (const s of specialItems(rows)) {
    p(`${s.label.padEnd(25)} ${String(s.events).padStart(6)}  ${String(s.excluded).padStart(4)}  ${String(s.presence).padStart(8)}  ${pct1(s.presenceRate).padStart(12)}  ${num(s.median).padStart(6)}  ${num(s.p25).padStart(6)}  ${num(s.p75).padStart(6)}`);
  }
  p('`excl` = timestamps past match end, excluded from timing (§3). NOT folded into the core item rankings above (§17).');

  printConclusion(out, { buckets, rows, all, modes, support, overall });

  console.log(out.join('\n'));
}


/** §23 — total variation distance between two categorical distributions. */
function tvd(a, b) {
  if (!a.length || !b.length) return null;
  const ca = new Map(); const cb = new Map();
  for (const x of a) ca.set(x, (ca.get(x) ?? 0) + 1);
  for (const x of b) cb.set(x, (cb.get(x) ?? 0) + 1);
  const keys = new Set([...ca.keys(), ...cb.keys()]);
  let d = 0;
  for (const k of keys) d += Math.abs((ca.get(k) ?? 0) / a.length - (cb.get(k) ?? 0) / b.length);
  return d / 2;
}

/**
 * §29/§30 — answer exactly four questions, then give one of three verdicts.
 *
 * The verdict is derived from printed numbers, not chosen because one table
 * looked tidy. Splits below the pre-registered minimum are EXCLUDED from the
 * verdict rather than averaged in as zeros.
 */
function printConclusion(out, { buckets, rows, all, modes, support, overall }) {
  const p = (s) => out.push(s);
  const ret = retention(rows);

  p(H('Conclusion'));
  p('Q1. How much item activity is observed by each cutoff?');
  for (const r of ret.out) {
    p(`    ${(r.cutoff * 100).toFixed(0).padStart(3)}%  events ${pct1(r.eventsRetained).padStart(7)}  presence ${pct1(r.presenceRetained).padStart(7)}  (events=${ret.totalEvents}, presenceRows=${ret.totalPresence})`);
  }

  p(`Q2. How stable is item ranking when the cutoff changes? (rows n=${overall.nRows}, matches n=${overall.nMatches})`);
  for (const c of overall.cutoffs) {
    p(`    ${(c.cutoff * 100).toFixed(0).padStart(3)}%  presence rho=${num(c.presence.spearman)} top10=${pct1(c.presence.top10)}   events rho=${num(c.events.spearman)} top10=${pct1(c.events.top10)}`);
  }

  // Q3 — does the stability survive the splits?
  const splits = [];
  for (const b of buckets) {
    const r = playerRows(b.parsed);
    // §21 — gate on MATCHES, and report how many were used.
    if (!meetsMinimum(r)) continue;
    const st = stability(r, b.label);
    for (const c of [0.5, 0.7]) {
      const s = st.cutoffs.find((x) => x.cutoff === c);
      splits.push({ what: `${b.label}@${c * 100}%`, rho: s.presence.spearman, top10: s.presence.top10, n: matchCount(r) });
    }
  }
  for (const [mode, n] of modes) {
    if (n < MIN_SAMPLE_FOR_CONCLUSION) continue;
    const mr = playerRows(all, { mode });
    const st = stability(mr, modeLabel(mode));
    for (const c of [0.5, 0.7]) {
      const s = st.cutoffs.find((x) => x.cutoff === c);
      splits.push({ what: `${modeLabel(mode)}@${c * 100}%`, rho: s.presence.spearman, top10: s.presence.top10, n });
    }
  }
  p(`Q3. Does stability survive rank/mode splits? (${splits.length} splits at n >= ${MIN_SAMPLE_FOR_CONCLUSION} MATCHES)`);
  if (!splits.length) {
    // §5 — do not let an empty table read as a negative result.
    p('    insufficient sample — no rank or mode split reached the minimum, so');
    p('    stability ACROSS splits was not measured. This is not a finding of');
    p('    instability.');
  }
  for (const s of splits) p(`    ${s.what.padEnd(26)} n=${String(s.n).padStart(4)} rho=${num(s.rho)} top10=${pct1(s.top10)}`);


  const rhos = splits.map((s) => s.rho).filter((x) => x !== null && !Number.isNaN(x));
  const held = splits.filter((s) => s.rho !== null && s.rho >= 0.8).length;

  p('Q4. What support floor is needed before the signal stops being noisy?');
  p(`    pre-registered floors: ${support.map((s) => `${s.floor}->${s.cellsKept} cells`).join('  ')}`);
  const useful = support.filter((s) => s.cellsKept >= 50).map((s) => s.floor);
  // §5 — absence of evidence is not evidence of noise. If even the smallest
  // pre-registered floor cannot be evaluated, say so instead of implying the
  // signal failed.
  if (!useful.length && support.every((s) => s.cellsKept === 0)) {
    p('    insufficient sample — no pre-registered floor could be evaluated.');
  } else {
    p(`    smallest floor keeping >=50 cells: ${useful.length ? useful[0] : 'none of the pre-registered floors'}`);
  }

  p('');
  p('Does this justify choosing a temporal eligibility rule for future');
  p('enemy-conditioned analysis?');
  p('    This report does not choose a rule, and nothing here is wired into');
  p('    production scoring. Choosing a cutoff needs a decision that the data');
  p('    above cannot make on its own.');
  p('');
  p('    A purchase observed after a cutoff does not imply that the cutoff');
  p('    caused the purchase, nor that the game outcome was already known.');
  p('    The only claim made is "what is observed by time X".');
  p('');
  const mean = rhos.length ? rhos.reduce((a, b) => a + b, 0) / rhos.length : null;

  /**
   * §4 — four verdicts, and INCONCLUSIVE is a real outcome.
   *
   * Defaulting to TEMPORAL_UNSTABLE when no split reached the minimum would be
   * the same absence-as-assertion error as ТЗ §21.1: turning "we did not
   * measure it" into "we measured instability".
   */
  let verdict;
  if (!splits.length) verdict = 'TEMPORAL_INCONCLUSIVE';
  else if (!rhos.length) verdict = 'TEMPORAL_INCONCLUSIVE';
  else if (held === rhos.length && (mean ?? 0) >= 0.9) verdict = 'TEMPORAL_STABLE';
  else if (held / rhos.length >= 0.5) verdict = 'TEMPORAL_PARTIAL';
  else verdict = 'TEMPORAL_UNSTABLE';

  p(`VERDICT: ${verdict}`);
  p(`    splits evaluated: ${splits.length} (minimum n = ${MIN_SAMPLE_FOR_CONCLUSION}); with rho >= 0.8: ${held}/${rhos.length}; mean rho: ${num(mean)}`);
  if (verdict === 'TEMPORAL_INCONCLUSIVE') {
    p('    reason: too few rank/mode splits reached the pre-registered minimum.');
    p('    This is a measurement gap, NOT a finding that the signal is unstable.');
    p('    Re-run with a larger corpus before treating any cutoff as validated.');
  }
}

function modeCounts(all) {
  const m = new Map();
  for (const x of all) m.set(x.gameMode, (m.get(x.gameMode) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/* -------------------------------------------------------------------- main */

const cmd = process.argv[2] ?? 'plan';
const CORPUS_FILE = path.join(CACHE, 'corpus.json');

if (cmd === 'plan') {
  console.log(H('Temporal eligibility research — plan (GET only, no POST)'));
  console.log(`cutoffs (fraction of match duration) : ${CUTOFFS.join(', ')}`);
  console.log(`support floors (pre-registered)     : ${SUPPORT_FLOORS.join(', ')}`);
  console.log(`min sample for a conclusion         : ${MIN_SAMPLE_FOR_CONCLUSION}`);
  console.log(`target parsed matches / bucket      : ${TARGET_PARSED_PER_BUCKET}`);
  console.log(`crawl cap / bucket                  : ${MAX_DISCOVERY_PER_BUCKET} discovery rows`);
  console.log('source                              : /publicMatches + /matches/{id} (GET)');
  console.log('filters                             : leagueid === 0, has_parsed === true');
  console.log(`rank source                         : discovery row avg_rank_tier -> ${BUCKETS.map((b) => `${b.label} ${b.min}-${b.max}`).join(' | ')}`);
  console.log('views compared                      : presence (match-level) vs events (purchase_log)');
  console.log('grain of every signal              : (heroId, matchId, itemId)');
  console.log('verdicts                           : TEMPORAL_STABLE | TEMPORAL_PARTIAL | TEMPORAL_UNSTABLE | TEMPORAL_INCONCLUSIVE');
  console.log(`cache                               : ${CACHE}`);
  console.log("\nNo POST endpoint exists in this script. Run 'all' to crawl.");
  process.exit(0);
}

if (cmd === 'all') {
  let buckets;
  if (existsSync(CORPUS_FILE) && process.argv.includes('--cached')) {
    log(`[corpus] reusing ${CORPUS_FILE}`);
    buckets = JSON.parse(readFileSync(CORPUS_FILE, 'utf8'));
  } else {
    buckets = await buildCorpus();
    writeFileSync(CORPUS_FILE, JSON.stringify(buckets));
    log(`[corpus] wrote ${CORPUS_FILE}`);
  }
  printReport(buckets);
  process.exit(0);
}

console.error(`unknown command: ${cmd}`);
console.error('usage: node scripts/public-temporal-research.mjs [plan|all] [--cached]');
process.exit(1);


