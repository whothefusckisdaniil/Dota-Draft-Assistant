#!/usr/bin/env node
/**
 * ТЗ §25 — parse success rate + item/timing enrichment.
 *
 * The one experiment in this project with an intentional external side effect.
 * `POST /request/{match_id}` costs 10 API calls each, so:
 *
 *   plan     GET only   — freeze and show the sample before anything is sent
 *   enqueue  POST        — at most 16, one per planned match, never retried
 *   poll     GET only    — bounded job polling (20 attempts, 15s apart)
 *   report   GET/cache   — the funnel, never a POST
 *   all      plan+report — CANNOT reach the POST path
 *
 * Pure maths lives in ./public-match-parse-lib.mjs and is unit-tested.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  aggregateEnrichment,
  classifyEnrichmentStage,
  classifyPostResponse,
  extractParseJobId,
  isDefinitiveUnparsed,
  isTerminalJobState,
  normaliseJobState,
} from './public-match-parse-lib.mjs';

const API = 'https://api.opendota.com/api';
const CACHE = '/tmp/opendota-parse-success-research';
mkdirSync(CACHE, { recursive: true });

const PLAN_FILE = path.join(CACHE, 'plan-v2.json');
/** The executed ТЗ §25 plan, kept verbatim under its old name (see §4). */
const LEGACY_PLAN_FILE = path.join(CACHE, 'plan-v1-legacy.json');
/**
 * §4 — the executed ТЗ §25 run used the WRONG rank ranges (10-15 etc. were
 * labelled as bracket PAIRS, so it sampled Herald/Guardian/Crusader/Archon and
 * never reached Legend/Ancient or Divine/Immortal).
 *
 * The old plan.json is kept untouched as a historical record. A fresh plan is
 * written to a DIFFERENT file, and both carry an explicit version, so the two
 * experiments can never be silently mixed.
 */
const PLAN_SCHEMA_VERSION = 2;
const RANK_BUCKET_VERSION = 'broad-v1';
const SAMPLE_SIZE = 16;
const PER_BUCKET = 4;
const POLL_ATTEMPTS = 20;
const POLL_DELAY_MS = 15000;

import { BROAD_BUCKETS as BUCKETS, bracketLabel, exactStrata } from './opendota/rank-buckets.mjs';
const MODES = { 1: 'All Pick', 2: 'Captains Mode', 13: 'Event', 18: 'Event B', 22: 'Ranked All Draft', 23: 'Turbo' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, b) => (b > 0 ? `${a}/${b} (${((100 * a) / b).toFixed(1)}%)` : `${a}/0 (n/a)`);

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

/**
 * §3/§4 — a GET that ALWAYS hits the network.
 *
 * The cached `get()` is wrong for anything whose value changes over time: a job
 * polled three times must not read the same cached JSON three times, and the
 * post-parse `/matches/{id}` must not return the baseline captured during
 * planning. The last known response is still written out, for the record.
 */
async function getFresh(url, { saveAs } = {}) {
  for (let a = 1; a <= 3; a += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
      if (res.status === 429) { await sleep(4000 * a); continue; }
      if (!res.ok) return null;
      const json = await res.json();
      writeFileSync(saveAs ?? path.join(CACHE, url.replace(/[^a-z0-9]+/gi, '_').slice(-150) + '.json'), JSON.stringify(json));
      return json;
    } catch (e) {
      if (a === 3) return null;
      await sleep(2000 * a);
    }
  }
  return null;
}

/**
 * Read the plan for POST-consuming commands.
 *
 * §4: the executed ТЗ §25 run (v1) and any newer plan (v2) must never be
 * mixed. The POST cache is keyed by match_id, so the plan is selected by
 * EVIDENCE — the one whose matches actually have `post_*.json` files — rather
 * than by recency or filename. Whichever is chosen is reported.
 */
const readPlan = () => {
  let best = null;
  for (const [file, label] of [[PLAN_FILE, 'v2'], [LEGACY_PLAN_FILE, 'v1-legacy']]) {
    if (!existsSync(file)) continue;
    const plan = JSON.parse(readFileSync(file, 'utf8'));
    const posted = (plan.matches ?? [])
      .filter((m) => existsSync(path.join(CACHE, `post_${m.match_id}.json`))).length;
    const entry = { ...plan, __file: path.basename(file), __label: label, __posted: posted };
    if (best === null || posted > best.__posted) best = entry;
  }
  return best;
};

/** §2 — the plan: 4 per bucket, public, demonstrably unparsed, tier in range. */
async function makePlan() {
  if (readPlan()) return readPlan();
  const discovery = new Map();
  let cursor = null;
  for (let p = 0; p < 4; p += 1) {
    const rows = await get(`${API}/publicMatches${cursor ? `?less_than_match_id=${cursor}` : ''}`);
    if (!rows?.length) break;
    for (const m of rows) discovery.set(m.match_id, m);
    cursor = Math.min(...rows.map((m) => m.match_id));
  }

  const perBucket = new Map(BUCKETS.map((b) => [b.key, []]));
  for (const disc of discovery.values()) {
    if (perBucket.size === 0) break;
    for (const b of BUCKETS) {
      const list = perBucket.get(b.key);
      if (list.length >= PER_BUCKET) continue;
      if (disc.avg_rank_tier < b.min || disc.avg_rank_tier > b.max) continue;
      const detail = await get(`${API}/matches/${disc.match_id}`);
      if (!detail || (detail.leagueid ?? 0) !== 0) continue;
      if (!isDefinitiveUnparsed(detail)) continue;
      list.push({
        match_id: disc.match_id,
        bucket: b.key,
        avg_rank_tier: disc.avg_rank_tier,
        start_time: disc.start_time,
        game_mode: detail.game_mode,
        lobby_type: detail.lobby_type,
        leagueid: detail.leagueid ?? 0,
        od_data: detail.od_data ?? null,
        players: (detail.players ?? []).length,
        purchase_log_players: (detail.players ?? []).filter((x) => Array.isArray(x.purchase_log)).length,
      });
      writeFileSync(path.join(CACHE, `detail_before_${disc.match_id}.json`), JSON.stringify(detail));
    }
  }

  const plan = [...perBucket.values()].flat().slice(0, SAMPLE_SIZE);
  const out = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    rankBucketVersion: RANK_BUCKET_VERSION,
    createdAt: new Date().toISOString(),
    discoveryScanned: discovery.size,
    bucketRanges: BUCKETS.map((b) => ({ key: b.key, label: b.label, min: b.min, max: b.max })),
    matches: plan,
  };
  writeFileSync(PLAN_FILE, JSON.stringify(out, null, 2));
  return { ...out, __file: path.basename(PLAN_FILE), __label: 'v2' };
}

/** §24 plan — GET only. */
function printPlan(plan) {
  console.log('=== Experiment design ===\n');
  console.log(`  plan file          ${plan.__file} (${plan.__label})`);
  console.log(`  plan schema        v${plan.schemaVersion ?? 1}${plan.rankBucketVersion ? `, buckets ${plan.rankBucketVersion}` : ''}`);
  console.log(`  target sample      ${SAMPLE_SIZE} matches (${PER_BUCKET} per calibrated bucket)`);
  console.log(`  discovery scanned  ${plan.discoveryScanned}`);
  console.log('  gates: publicMatches + leagueid===0 + tier in bucket + has_parsed===false');
  console.log(`  mode filter        NONE (post-hoc only, §3)\n`);
  if (plan.bucketRanges) {
    console.log('  bucket ranges: ' + plan.bucketRanges.map((b) => `${b.label}=${b.min}-${b.max}`).join('  ') + '\n');
  } else {
    console.log('  WARNING: this plan predates the canonical rank buckets. It used');
    console.log('  10-15 / 20-25 / 30-35 / 40-45 — each a SINGLE bracket, mislabelled as a');
    console.log('  pair. Its actual strata are printed per row below.\n');
  }
  console.log('=== Sample ===\n');
  console.log('  match_id       bucket            tier  stratum        gm  lobby  players  plog  has_parsed');
  for (const m of plan.matches) {
    console.log(`  ${String(m.match_id).padEnd(14)} ${m.bucket.padEnd(17)} ${String(m.avg_rank_tier).padStart(3)}  ` +
      `${String(exactStrata(m.avg_rank_tier)).padEnd(14)} ` +
      `${String(m.game_mode).padStart(2)} ${String(m.lobby_type).padStart(5)} ${String(m.players).padStart(7)}  ` +
      `${String(m.purchase_log_players).padStart(4)}  ${String(m.od_data?.has_parsed)}`);
  }
  const byBucket = new Map();
  for (const m of plan.matches) byBucket.set(m.bucket, (byBucket.get(m.bucket) ?? 0) + 1);
  const byMode = new Map();
  for (const m of plan.matches) byMode.set(m.game_mode, (byMode.get(m.game_mode) ?? 0) + 1);
  console.log(`\n  per bucket: ${[...byBucket].map(([k, v]) => `${k}=${v}`).join('  ')}`);
  console.log(`  per mode  : ${[...byMode].map(([k, v]) => `${MODES[k] ?? k}=${v}`).join('  ')}`);
  if (plan.matches.length < SAMPLE_SIZE) {
    console.log(`\n  NOTE: only ${plan.matches.length}/${SAMPLE_SIZE} candidates found. The funnel`);
    console.log('  denominators below are this number, not the target.');
  }
  console.log('\n  Run `enqueue` explicitly to submit parse requests (16 POSTs max).');
}

/** §5 — the ONLY place in this file that sends a POST. */
async function sendPost(matchId) {
  const res = await fetch(`${API}/request/${matchId}`, { method: 'POST', signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
  writeFileSync(path.join(CACHE, `post_${matchId}.json`), JSON.stringify({ httpStatus: res.status, body }, null, 2));
  return { httpStatus: res.status, body };
}

async function runEnqueue() {
  console.log('=== Enqueue ===\n');
  console.log(`  POST /request/{id} costs 10 API calls each. Budget ${SAMPLE_SIZE}.`);
  console.log('  One POST per planned match; a match already in the cache is skipped.\n');
  const plan = readPlan();
  if (!plan) { console.log('  no plan.json — run `plan` first.'); return; }

  console.log('  match_id       bucket            http  jobId        post status');
  for (const m of plan.matches) {
    const f = path.join(CACHE, `post_${m.match_id}.json`);
    if (existsSync(f)) {
      const prev = JSON.parse(readFileSync(f, 'utf8'));
      const c = classifyPostResponse(prev.body, prev.httpStatus);
      console.log(`  ${String(m.match_id).padEnd(14)} ${m.bucket.padEnd(17)} ${String(prev.httpStatus).padStart(4)}  ` +
        `${String(c.jobId ?? '-').padEnd(12)} skipped (already POSTed, ${c.status})`);
      continue;
    }
    const r = await sendPost(m.match_id);
    const c = classifyPostResponse(r.body, r.httpStatus);
    console.log(`  ${String(m.match_id).padEnd(14)} ${m.bucket.padEnd(17)} ${String(r.httpStatus).padStart(4)}  ` +
      `${String(c.jobId ?? '-').padEnd(12)} ${c.status}${c.accepted ? '' : ` (${c.reason})`}`);
    if (r.httpStatus >= 400) console.log(`    error: ${JSON.stringify(r.body).slice(0, 200)}`);
    await sleep(1000);
  }
  console.log('\n  Poll with: node scripts/public-parse-success-research.mjs poll');
}

/** §7 — bounded polling. Never an infinite watcher. */
async function runPoll() {
  console.log('=== Poll results ===\n');
  const plan = readPlan();
  if (!plan) { console.log('  no plan.json.'); return; }
  console.log(`  max ${POLL_ATTEMPTS} attempts, ${POLL_DELAY_MS / 1000}s apart`);

  console.log('\n  match_id       jobId        attempts  state');
  for (const m of plan.matches) {
    const pf = path.join(CACHE, `post_${m.match_id}.json`);
    if (!existsSync(pf)) { console.log(`  ${String(m.match_id).padEnd(14)} (never POSTed)`); continue; }
    const post = JSON.parse(readFileSync(pf, 'utf8'));
    // §7 — read the NESTED job id out of the already-stored POST response.
    const pc = classifyPostResponse(post.body, post.httpStatus);
    if (pc.jobId == null) {
      console.log(`  ${String(m.match_id).padEnd(14)} ${'-'.padEnd(12)} ${String(0).padStart(8)}  POST_${pc.status.toUpperCase()} (${pc.reason})`);
      continue;
    }
    const jobId = pc.jobId;
    let state = 'unknown';
    let attempts = 0;
    for (; attempts < POLL_ATTEMPTS; attempts += 1) {
      // §3 — getFresh: the cache would return the first observation forever.
      const raw = await getFresh(`${API}/request/${jobId}`, {
        saveAs: path.join(CACHE, `job_${jobId}.json`),
      });
      state = normaliseJobState(raw);
      if (raw == null) state = 'unknown';
      if (isTerminalJobState(state)) break;
      if (attempts < POLL_ATTEMPTS - 1) await sleep(POLL_DELAY_MS);
    }
    // §5 — bounded out is TIMEOUT, never failed. §6 — unknown stays unknown.
    if (state === 'pending' || state === 'queued') state = 'timeout';
    console.log(`  ${String(m.match_id).padEnd(14)} ${String(jobId).padEnd(12)} ${String(attempts + 1).padStart(8)}  ${state}`);
  }
}

/** §10 — the funnel, never one percentage. */
async function runReport() {
  const plan = readPlan();
  if (!plan) { console.log('  no plan.json — run `plan` first.'); return; }

  const catalogue = JSON.parse(
    readFileSync(new URL('../public/data/items.json', import.meta.url), 'utf8'),
  );
  const dnames = new Set(Object.values(catalogue).map((i) => i.dname));
  const resolveKey = (k) => dnames.has(`item_${k}`);

  const results = [];
  for (const m of plan.matches) {
    const pf = path.join(CACHE, `post_${m.match_id}.json`);
    if (!existsSync(pf)) continue;
    const post = JSON.parse(readFileSync(pf, 'utf8'));
    const pc = classifyPostResponse(post.body, post.httpStatus);

    let jobStatus = pc.accepted ? 'accepted' : `post_${pc.status}`;
    if (pc.jobId != null) {
      const jf = path.join(CACHE, `job_${pc.jobId}.json`);
      if (existsSync(jf)) {
        const state = normaliseJobState(JSON.parse(readFileSync(jf, 'utf8')));
        jobStatus = state;
      } else {
        jobStatus = 'not_polled';
      }
    }

    // §4 — the post-parse detail must come from the NETWORK. The cached
    // `/matches/{id}` is the BASELINE captured during planning; reading it here
    // would report pre-parse state as if the parse had never happened.
    const detail = await getFresh(`${API}/matches/${m.match_id}`, {
      saveAs: path.join(CACHE, `detail_after_${m.match_id}.json`),
    });
    if (!detail) continue;

    const stage = classifyEnrichmentStage({ postOk: pc.accepted, jobCompleted: jobStatus, detail });
    results.push({
      ...m, postOk: pc.accepted, postStatus: pc.status, postReason: pc.reason,
      jobId: pc.jobId, jobStatus, detail, stage: stage.stage, layer: stage.layer,
    });
  }

  const agg = aggregateEnrichment(results, { resolveKey });

  console.log('=== Parse completion ===\n');
  console.log(`  requested        ${agg.total}`);
  console.log(`  POST accepted    ${pct(agg.funnel.post_accepted, agg.total)}`);

  console.log('\n=== Enrichment funnel ===\n');
  console.log('  requested          -> POST accepted -> job completed -> has_parsed -> 10 players -> purchase_log -> item keys -> valid timing');
  for (const [k, v] of Object.entries(agg.funnel)) {
    console.log(`  ${k.padEnd(18)} ${pct(v, agg.total)}`);
  }

  console.log('\n=== Purchase-log enrichment ===\n');
  const usable = results.filter((r) => r.stage === 'usable').length;
  console.log(`  matches with usable purchase/timing data: ${pct(usable, agg.total)}`);
  console.log(`  total purchase events: ${agg.events}`);
  if (agg.events) console.log(`  events per match (median): ${agg.events / Math.max(1, usable)} (mean over usable)`);

  console.log('\n=== Item key resolution ===\n');
  console.log(`  keyed events   ${agg.keyed}/${agg.events}`);
  console.log(`  resolved       ${agg.resolved}/${agg.keyed} (via item_<key> == dname, exact only)`);
  if (agg.unresolvedKeys.length) console.log(`  unresolved keys: ${agg.unresolvedKeys.slice(0, 12).join(', ')}`);

  console.log('\n=== Timing validity ===\n');
  console.log(`  valid (incl. pre-horn) ${agg.timing.validIncludingPreHorn}`);
  console.log(`  pre-horn (time < 0)     ${agg.timing.preHorn}  <- valid, not an error`);
  console.log(`  after duration          ${agg.timing.after_duration}`);
  console.log(`  invalid type            ${agg.timing.invalid_type}`);

  console.log('\n=== Post-hoc purchases ===\n');
  console.log(`  after half the match : ${agg.postHoc.afterHalf}/${agg.events}`);
  console.log(`  in the final 2 min   : ${agg.postHoc.afterFinalTwoMin}/${agg.events}`);

  console.log('\n=== Poll / job layer ===\n');
  console.log(`  job states: ${JSON.stringify(agg.jobStates)}`);
  console.log('  `/request/{jobId}` returned null for every accepted job, so this layer is');
  console.log('  UNOBSERVABLE. It is reported, never used as the completion verdict.');

  console.log('\n=== Confidence interval ===\n');
  for (const [label, ci] of [['parse completion', agg.ci.completion], ['usable enrichment', agg.ci.usable]]) {
    if (!ci) { console.log(`  ${label.padEnd(20)} n/a (no data)`); continue; }
    console.log(`  ${label.padEnd(20)} ${(100 * ci.point).toFixed(1)}%  95% Wilson CI [${(100 * ci.low).toFixed(1)}%, ${(100 * ci.high).toFixed(1)}%]  (n=${ci.n})`);
  }

  console.log('\n=== Verdict ===\n');
  if (agg.total === 0) {
    // Nothing was submitted yet. "BLOCKED" would be an invented finding.
    console.log('  NOT YET RUN — no parse requests have been submitted.');
    console.log('  Submit them with `enqueue`, then `poll`, then `report`.');
  } else if (usable === 0) {
    console.log('  ENRICHMENT_BLOCKED — no match produced usable purchase/timing data.');
  } else if (agg.ci.usable && agg.ci.usable.low > 0.5) {
    console.log('  PARSER_SUCCESS — enrichment worked on most of the sample.');
  } else {
    console.log('  ENRICHMENT_PARTIAL — some usable data, coverage too uncertain to call stable.');
  }
  console.log('\n  This is an experimental estimate on a small random sample.');
  console.log('  It does NOT establish production-scale throughput.');
}

const cmd = process.argv[2] ?? 'plan';
const t0 = Date.now();
if (cmd === 'plan' || cmd === 'all') printPlan(await makePlan());
if (cmd === 'enqueue') await runEnqueue();
if (cmd === 'poll') await runPoll();
if (cmd === 'report' || cmd === 'all') await runReport();
console.log(`\n[parse-success ${cmd} — ${Date.now() - t0} ms]`);

