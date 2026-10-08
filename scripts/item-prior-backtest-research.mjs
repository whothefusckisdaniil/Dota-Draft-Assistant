/**
 * TZ No.38 — ItemPrior temporal backtest (rolling-origin, leakage-free).
 *
 *   TRAIN weeks -> ItemPrior / Baseline A / Baseline B rankings
 *   TEST week   -> Recall@5/10/15, event-weighted recall, NDCG@10
 *   -> paired bootstrap over Hero x Position cells -> verdict
 *
 * Folds (fixed BEFORE the run):
 *   F1 train=[W1] test=W2 | F2 train=[W1,W2] test=W3 | F3 train=[W1..W3] test=W4
 * Weeks are EXACTLY meta.itemData.weeklyBuckets — the same frozen window as
 * the committed production dataset (fail-closed if not 4 weeks).
 *
 * Leakage rule: the production position gate (share >= 8%, games >= 500),
 * baselines, itemStats aggregates and rankings are computed on TRAIN ONLY.
 * The TEST week is read only by the metric functions.
 *
 * Network: `fetch` mode queries STRATZ through the production transport
 * (token from env/.env, never logged) and caches per-week slices under
 * /tmp/item-prior-backtest/. After fetch, evaluate/all re-run offline.
 * No production files are written; src/scoring is untouched.
 *
 *   node scripts/item-prior-backtest-research.mjs [fetch|evaluate|all|determinism]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  RESEARCH_SEED, N_BOOTSTRAP, RECALL_K, TRAIN_GATE, MIN_TEST_DISTINCT_ITEMS,
  MIN_PRIMARY_CELLS, ITEM_PRIOR_PARAMS, BACKTEST_VERDICTS, FOLD_METRIC_KEYS,
  INSUFFICIENT_TEST_SUPPORT, INSUFFICIENT_FOLD,
  aggregateTrain, trainEligibleCells, buildLaneBaselines,
  fullItemPriorRanking, eventsPerGameRanking, positionGlobalRanking,
  recallAtK, eventWeightedRecall, ndcgAtK, novelItemRate,
  aggregateFoldMetrics, pairedBootstrap, decideBacktestVerdict,
} from './item-prior-backtest-lib.mjs';

const CACHE_DIR = '/tmp/item-prior-backtest';
const CACHE_SCHEMA = 'item-prior-backtest-week/1';
const META = 'public/data/meta.json';
const HEROES = 'public/data/heroes.json';
const POSITIONS = ['1', '2', '3', '4', '5'];
const RANKERS = ['full', 'a_eventsPerGame', 'b_positionGlobal'];
const RANKER_LABEL = {
  full: 'Full ItemPrior',
  a_eventsPerGame: 'Baseline A eventsPerGame',
  b_positionGlobal: 'Baseline B position-global',
};

/* ── loaders (offline, fail-closed) ─────────────────────────────────── */

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function weeklyBuckets() {
  const meta = loadJson(META);
  const buckets = meta?.itemData?.weeklyBuckets ?? null;
  if (!Array.isArray(buckets) || buckets.length !== 4) {
    throw new Error(`expected meta.itemData.weeklyBuckets to be exactly 4 weeks, got ${JSON.stringify(buckets)}`);
  }
  if (!buckets.every((b, i) => i === 0 || b === buckets[i - 1] + 1)) {
    throw new Error(`weekly buckets must be contiguous ascending, got ${buckets.join(',')}`);
  }
  return buckets;
}

function cachePath(bucket) {
  return `${CACHE_DIR}/w${bucket}.json`;
}

function loadWeek(bucket) {
  const path = cachePath(bucket);
  if (!existsSync(path)) {
    throw new Error(`missing week cache ${path} — run \`node scripts/item-prior-backtest-research.mjs fetch\` first`);
  }
  const week = JSON.parse(readFileSync(path, 'utf8'));
  if (week?.schema !== CACHE_SCHEMA || week.bucket !== bucket) {
    throw new Error(`week cache ${path} fails contract (schema=${week?.schema} bucket=${week?.bucket})`);
  }
  validateWeek(`cache w${bucket}`, week.positions, week.itemStats);
  return week;
}

/* ── per-week contract validation (fail-closed, no silent repairs) ──── */

function validateWeek(where, positions, itemStats) {
  const problems = [];
  for (const [heroId, entry] of Object.entries(positions ?? {})) {
    let shareSum = 0;
    for (const pos of POSITIONS) {
      const cell = entry?.positions?.[pos];
      if (!cell) { problems.push(`${where}: hero ${heroId} missing position ${pos}`); continue; }
      if (!Number.isInteger(cell.games) || cell.games < 0) problems.push(`${where}: hero ${heroId} pos ${pos} games not a non-negative integer`);
      if (!(cell.share >= 0) || !(cell.share <= 1)) problems.push(`${where}: hero ${heroId} pos ${pos} share outside [0,1]`);
      shareSum += Number.isFinite(cell.share) ? cell.share : 1;
    }
    if (Math.abs(shareSum - 1) > 1e-9) problems.push(`${where}: hero ${heroId} share sum ${shareSum}`);
  }
  for (const [heroId, byPos] of Object.entries(itemStats ?? {})) {
    for (const [pos, byItem] of Object.entries(byPos)) {
      for (const [itemId, cell] of Object.entries(byItem)) {
        const where2 = `${where} hero ${heroId} pos ${pos} item ${itemId}`;
        if (!Number.isInteger(cell.purchases) || cell.purchases < 0) problems.push(`${where2}: purchases`);
        if (!Number.isInteger(cell.wins) || cell.wins < 0) problems.push(`${where2}: wins`);
        if (cell.wins > cell.purchases) problems.push(`${where2}: wins > purchases`);
        if (!Number.isInteger(cell.heroGames) || cell.heroGames < 0) problems.push(`${where2}: heroGames`);
        const minuteSum = Object.values(cell.byMinute ?? {}).reduce((s, n) => s + n, 0);
        const instSum = Object.values(cell.instances ?? {}).reduce((s, n) => s + n, 0);
        if (minuteSum !== cell.purchases) problems.push(`${where2}: byMinute ${minuteSum} != purchases ${cell.purchases}`);
        if (instSum !== cell.purchases) problems.push(`${where2}: instances ${instSum} != purchases ${cell.purchases}`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`week contract failed (${problems.length}):\n  - ${problems.slice(0, 20).join('\n  - ')}`);
  }
}

/* ── fetch mode (network, production transport, /tmp cache) ─────────── */

function loadToken() {
  const fromEnv = process.env.STRATZ_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const envFile = readFileSync('.env', 'utf8');
    for (const line of envFile.split(/\r?\n/)) {
      const m = line.match(/^\s*STRATZ_API_TOKEN\s*=\s*(.*?)\s*$/);
      if (m) return m[1];
    }
  } catch { /* fall through */ }
  throw new Error('STRATZ_API_TOKEN is not set (environment variable or .env file)');
}

async function fetchWeek(bucket, heroIds, token, log) {
  const { fetchPositionsFromStratz } = await import('./stratz/positions.mjs');
  const { fetchItemStats } = await import('./stratz/items.mjs');
  const windowInfo = { buckets: [bucket] };
  log(`  week ${bucket}: position layer…`);
  const positions = await fetchPositionsFromStratz(heroIds, windowInfo, { token, log });
  const heroGamesByPosition = new Map();
  for (const [heroId, entry] of Object.entries(positions)) {
    for (const pos of POSITIONS) {
      heroGamesByPosition.set(`${heroId}:${pos}`, entry.positions?.[pos]?.games ?? 0);
    }
  }
  log(`  week ${bucket}: item stats…`);
  const itemStats = await fetchItemStats(heroIds, windowInfo, { token, heroGamesByPosition, log });
  validateWeek(`fetched w${bucket}`, positions, itemStats);
  return { schema: CACHE_SCHEMA, bucket, positions, itemStats };
}

async function modeFetch(log = console.log) {
  const buckets = weeklyBuckets();
  const heroes = loadJson(HEROES);
  const heroIds = Object.values(heroes).map((h) => h.id).sort((a, b) => a - b);
  if (heroIds.length === 0) throw new Error('heroes.json yielded no hero ids');
  const token = loadToken();
  mkdirSync(CACHE_DIR, { recursive: true });
  log(`# TZ No.38 fetch — weeks [${buckets.join(', ')}], ${heroIds.length} heroes`);
  let fetched = 0;
  for (const bucket of buckets) {
    if (existsSync(cachePath(bucket))) {
      loadWeek(bucket); // cached files are re-validated, never trusted blindly
      log(`  week ${bucket}: cache hit (contract OK)`);
      continue;
    }
    const week = await fetchWeek(bucket, heroIds, token, log);
    writeFileSync(cachePath(bucket), JSON.stringify(week));
    fetched += 1;
    log(`  week ${bucket}: fetched + cached (${cachePath(bucket)})`);
  }
  log(fetched > 0
    ? `done: ${fetched} week(s) fetched, ${buckets.length - fetched} from cache`
    : `done: all ${buckets.length} weeks from cache (no network calls)`);
}

/* ── evaluation core (offline) ──────────────────────────────────────── */

function rankersFor(train, baselines) {
  const globalByPos = new Map();
  for (const pos of POSITIONS) globalByPos.set(pos, positionGlobalRanking(train.itemStats, pos));
  return {
    full: (heroId, pos) => fullItemPriorRanking(train.itemStats, baselines, heroId, pos),
    a_eventsPerGame: (heroId, pos) => eventsPerGameRanking(train.itemStats, heroId, pos),
    b_positionGlobal: (_heroId, pos) => globalByPos.get(pos),
  };
}

function testPurchasesFor(week, heroId, position) {
  const byItem = week.itemStats?.[String(heroId)]?.[String(position)] ?? {};
  const out = {};
  for (const [itemId, cell] of Object.entries(byItem)) {
    if (cell.purchases > 0) out[itemId] = cell.purchases;
  }
  return out;
}

/**
 * One fold: TRAIN gate -> eligible cells -> TEST support gate -> metrics
 * for all three rankers on the SAME cells (paired by construction).
 */
function evaluateFold(fold, weeksByBucket) {
  const trainWeeks = fold.train.map((b) => weeksByBucket.get(b));
  const testWeek = weeksByBucket.get(fold.test);
  const train = aggregateTrain(trainWeeks);
  const baselines = buildLaneBaselines(train.itemStats);
  const rankers = rankersFor(train, baselines);
  const eligible = trainEligibleCells(train.games, TRAIN_GATE).filter((c) => c.eligible);

  const rows = [];
  let insufficientTest = 0;
  for (const cell of eligible) {
    const testPurchases = testPurchasesFor(testWeek, cell.heroId, cell.position);
    const relevant = Object.keys(testPurchases).map(Number);
    if (relevant.length < MIN_TEST_DISTINCT_ITEMS) {
      insufficientTest += 1;
      continue; // INSUFFICIENT_TEST_SUPPORT: excluded from primary, counted
    }
    const trainIds = Object.keys(train.itemStats[String(cell.heroId)]?.[String(cell.position)] ?? {}).map(Number);
    const row = {
      fold: fold.n, heroId: cell.heroId, position: cell.position,
      novelRate: novelItemRate(trainIds, relevant),
    };
    for (const key of RANKERS) {
      const retrieved = rankers[key](cell.heroId, cell.position).map((r) => r.itemId);
      row[key] = {
        recall5: recallAtK(retrieved, relevant, RECALL_K[0]),
        recall10: recallAtK(retrieved, relevant, RECALL_K[1]),
        recall15: recallAtK(retrieved, relevant, RECALL_K[2]),
        mass10: eventWeightedRecall(retrieved, testPurchases, RECALL_K[1]),
        ndcg10: ndcgAtK(retrieved, testPurchases, RECALL_K[1]),
      };
    }
    rows.push(row);
  }
  const aggregates = {};
  for (const key of RANKERS) {
    aggregates[key] = aggregateFoldMetrics(rows.map((r) => r[key]));
  }
  return {
    fold: fold.n, trainCells: eligible.length, insufficientTest, rows, aggregates,
    status: rows.length > 0 ? 'OK' : INSUFFICIENT_FOLD,
  };
}


/* ── report ─────────────────────────────────────────────────────────── */

const fmt = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');

function sectionDesign(p, buckets, weeksByBucket, integrity) {
  p('# TZ No.38 -- ItemPrior temporal backtest (rolling-origin, leakage-free)');
  p('');
  p('=== Sec.1 Design & data ===');
  p('');
  p(`  weekly buckets (meta.itemData, frozen window)   [${buckets.join(', ')}]`);
  p(`  folds                                           F1 [${buckets[0]}]->${buckets[1]} | F2 [${buckets[0]},${buckets[1]}]->${buckets[2]} | F3 [${buckets.slice(0, 3).join(',')}]->${buckets[3]}`);
  p(`  week caches                                     ${weeksByBucket.size}/${buckets.length} contract-OK`);
  p('  leakage rule                                    gate/baselines/rankings from TRAIN only');
  p(`  frozen formula                                  0.6/0.2/0.2 alpha=${ITEM_PRIOR_PARAMS.alpha} liftSmoothing=${ITEM_PRIOR_PARAMS.liftSmoothing} (parity-tested)`);
  p(`  bootstrap                                       paired over cells, N=${N_BOOTSTRAP}, seed=${RESEARCH_SEED}`);
  p('');
  p('  integrity diagnostic (sum of 4 fetched weeks vs committed item-stats):');
  p(`    cells differing: ${integrity.mismatch}/${integrity.compared} (backfill drift is reported, never patched)`);
  for (const ex of integrity.examples) p(`      e.g. ${ex}`);
  p('');
}

function sectionGates(p, folds) {
  p('=== Sec.2 Gates (TRAIN eligibility -> TEST support) ===');
  p('');
  p(`  TRAIN gate (on TRAIN only): share >= ${TRAIN_GATE.minShare} AND games >= ${TRAIN_GATE.minGames}`);
  p(`  TEST gate: >= ${MIN_TEST_DISTINCT_ITEMS} distinct observed items, else ${INSUFFICIENT_TEST_SUPPORT}`);
  p('');
  for (const f of folds) {
    p(`  Fold ${f.fold}: train-eligible cells ${f.trainCells} | ${INSUFFICIENT_TEST_SUPPORT} ${f.insufficientTest} | primary cells ${f.rows.length}${f.status === INSUFFICIENT_FOLD ? ` | ${INSUFFICIENT_FOLD}` : ''}`);
  }
  p('');
}

function sectionFoldMetrics(p, folds) {
  p('=== Sec.3 Per-fold metrics (macro mean over primary cells) ===');
  p('');
  p('  Fold | ranker | cells | R@5 | R@10 | R@15 | mass@10 | NDCG@10');
  for (const f of folds) {
    for (const key of RANKERS) {
      const a = f.aggregates[key];
      p(`  F${f.fold} | ${key.padEnd(20)} | ${String(a.n).padStart(4)} | ${fmt(a.recall5)} | ${fmt(a.recall10)} | ${fmt(a.recall15)} | ${fmt(a.mass10)} | ${fmt(a.ndcg10)}`);
    }
    if (f.status === INSUFFICIENT_FOLD) p(`  F${f.fold}: ${INSUFFICIENT_FOLD} — shown, never imputed`);
  }
  p('');
}


function sectionAggregate(p, agg, boots, primaryCells) {
  p('=== Sec.4 Aggregate (pooled primary cells) + paired bootstrap ===');
  p('');
  p(`  primary cells: ${primaryCells} (min for a verdict: ${MIN_PRIMARY_CELLS})`);
  p('  metric      | Full | Base A | Base B | d(Full-A) 95% CI   | d(Full-B) 95% CI');
  for (const key of FOLD_METRIC_KEYS) {
    const bA = boots.a[key];
    const bB = boots.b[key];
    p(`  ${key.padEnd(11)} | ${fmt(agg.full[key])} | ${fmt(agg.a_eventsPerGame[key])} | ${fmt(agg.b_positionGlobal[key])} | ${fmt(bA.mean)} [${fmt(bA.lo)}, ${fmt(bA.hi)}] | ${fmt(bB.mean)} [${fmt(bB.lo)}, ${fmt(bB.hi)}]`);
  }
  p('  (paired bootstrap over whole Hero x Position cells; percentile CI; no normal approximation)');
  p('');
}

function sectionStability(p, folds, foldDeltas, signsHold) {
  p('=== Sec.5 Stability across folds (primary metric Recall@10 deltas) ===');
  p('');
  for (const f of folds) {
    const d = foldDeltas.get(f.fold);
    if (!d) { p(`  Fold ${f.fold}: no primary cells`); continue; }
    p(`  Fold ${f.fold}: d(Full-A)=${fmt(d.a)} d(Full-B)=${fmt(d.b)} cells=${d.n}`);
  }
  p(`  fold signs non-negative in every fold: ${signsHold ? 'YES' : 'NO'}`);
  p('  Reading: an aggregate mean carried by one week would show opposite signs here.');
  p('');
}

function sectionNovel(p, folds, novelByFold) {
  p('=== Sec.6 Novel-item rate (temporal drift, distinct-based) ===');
  p('');
  for (const f of folds) {
    p(`  Fold ${f.fold}: novel rate ${fmt(novelByFold.get(f.fold))}`);
  }
  p('  Items absent from TRAIN are kept as MISSES (never removed from TEST).');
  p('  A high rate means drift, not a ranking failure.');
  p('');
}


function sectionVerdict(p, verdict, primaryCells, boots, signsHold) {
  p('=== Sec.7 Limitations ===');
  p('');
  p('  purchase EVENTS, not ownership or unique-game rates (data contract).');
  p('  formula frozen: no alpha/weights/K/threshold tuning on TEST (0.6/0.2/0.2 untouched).');
  p('  NDCG@10 secondary — repeat-heavy cheap events can inflate it.');
  p('  population: one rank-bracket-weighted snapshot; single patch window.');
  p('  EB internals of the production shrinkage are not re-estimated (documented).');
  p('  Fold 1 trains on ONE week by design; if thin, it shows as INSUFFICIENT, not imputed.');
  p('');
  p('=== Sec.8 Verdict ===');
  p('');
  p(`  ${verdict}`);
  p(`  primary cells ${primaryCells}; d(Full-A) Recall@10 ${fmt(boots.a.recall10.mean)} [${fmt(boots.a.recall10.lo)}, ${fmt(boots.a.recall10.hi)}]; d(Full-B) ${fmt(boots.b.recall10.mean)} [${fmt(boots.b.recall10.lo)}, ${fmt(boots.b.recall10.hi)}]; fold signs OK: ${signsHold}`);
  p('');
}

/* ── main ───────────────────────────────────────────────────────────── */

function evaluateAll() {
  const out = [];
  const p = (s = '') => out.push(s);
  const buckets = weeklyBuckets();
  const weeksByBucket = new Map(buckets.map((b) => [b, loadWeek(b)]));

  // Integrity diagnostic: 4-week sum vs the committed production snapshot.
  const summed = aggregateTrain(buckets.map((b) => weeksByBucket.get(b)));
  const committed = loadJson('public/data/item-stats.json');
  let compared = 0;
  let mismatch = 0;
  const examples = [];
  for (const [heroId, byPos] of Object.entries(committed)) {
    for (const [pos, byItem] of Object.entries(byPos)) {
      for (const [itemId, cell] of Object.entries(byItem)) {
        compared += 1;
        const mine = summed.itemStats[heroId]?.[pos]?.[itemId];
        if (!mine || mine.purchases !== cell.purchases || mine.heroGames !== cell.heroGames) {
          mismatch += 1;
          if (examples.length < 3) {
            examples.push(`hero ${heroId} pos ${pos} item ${itemId}: committed p=${cell.purchases} g=${cell.heroGames} vs fetched p=${mine?.purchases ?? 'absent'} g=${mine?.heroGames ?? 'absent'}`);
          }
        }
      }
    }
  }
  sectionDesign(p, buckets, weeksByBucket, { compared, mismatch, examples });

  // Rolling-origin: fold n trains on the first n weeks, tests the next one.
  const folds = [1, 2, 3].map((n) => ({
    n,
    train: buckets.slice(0, n),
    test: buckets[n],
  }));

  const results = folds.map((f) => evaluateFold(f, weeksByBucket));
  sectionGates(p, results);
  sectionFoldMetrics(p, results);

  const pooled = results.flatMap((f) => f.rows);
  const agg = {};
  for (const key of RANKERS) agg[key] = aggregateFoldMetrics(pooled.map((r) => r[key]));
  const primaryCells = agg.full.n;

  const boots = { a: {}, b: {} };
  for (const metric of FOLD_METRIC_KEYS) {
    const dA = pooled.map((r) => r.full[metric] - r.a_eventsPerGame[metric]);
    const dB = pooled.map((r) => r.full[metric] - r.b_positionGlobal[metric]);
    boots.a[metric] = pairedBootstrap(dA);
    boots.b[metric] = pairedBootstrap(dB, { seed: RESEARCH_SEED + 1 });
  }

  const foldDeltas = new Map();
  let signsHold = true;
  for (const f of results) {
    if (f.aggregates.full.n === 0) continue;
    const a = f.aggregates.full.recall10 - f.aggregates.a_eventsPerGame.recall10;
    const b = f.aggregates.full.recall10 - f.aggregates.b_positionGlobal.recall10;
    foldDeltas.set(f.fold, { a, b, n: f.aggregates.full.n });
    if (!(a >= 0 && b >= 0)) signsHold = false;
  }
  sectionAggregate(p, agg, boots, primaryCells);
  sectionStability(p, results, foldDeltas, signsHold);

  const novelByFold = new Map();
  for (const f of results) {
    const vals = f.rows.map((r) => r.novelRate).filter(Number.isFinite);
    novelByFold.set(f.fold, vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : NaN);
  }
  sectionNovel(p, results, novelByFold);

  const verdict = decideBacktestVerdict({
    primaryCells,
    fullMinusA: boots.a.recall10,
    fullMinusB: boots.b.recall10,
    foldSignsNonNegative: signsHold,
  });
  sectionVerdict(p, verdict, primaryCells, boots, signsHold);
  return out.join('\n');
}

function main() {
  const mode = process.argv[2] ?? 'all';
  const allowed = new Set(['fetch', 'evaluate', 'all', 'determinism']);
  if (!allowed.has(mode)) {
    process.stderr.write(`unknown mode ${mode}; want one of ${[...allowed].join('|')}\n`);
    process.exitCode = 1;
    return;
  }
  (async () => {
    if (mode === 'fetch') {
      await modeFetch();
      return;
    }
    if (mode === 'determinism') {
      // Real check, not a label: two full evaluations must be byte-identical.
      const first = evaluateAll();
      const second = evaluateAll();
      if (first !== second) {
        process.stderr.write('determinism FAILED: two evaluateAll() runs differ\n');
        process.exitCode = 1;
        return;
      }
      console.log(first);
      console.error('determinism: two evaluateAll() runs byte-identical');
      return;
    }
    if (mode === 'all') {
      await modeFetch();
    }
    console.log(evaluateAll());
  })().catch((e) => {
    process.stderr.write(`${e?.message ?? e}\n`);
    process.exitCode = 1;
  });
}

main();

