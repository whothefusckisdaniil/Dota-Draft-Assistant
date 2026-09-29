#!/usr/bin/env node
/**
 * Production data refresh generator (ТЗ №6 + №7).
 *
 *   OpenDota metadata  ──▶ canonical heroes[] + latestPatch
 *          │
 *          ├─▶ heroIds ──▶ STRATZ GraphQL (4 last complete weeks) ──▶ matchups
 *          │
 *          └─▶ heroes.json
 *
 *                     ▼  validate  ▼  publish atomically
 *              public/data/{heroes,matchups,meta}.json
 *
 * Rules:
 *  - Hero metadata is fetched fresh from OpenDota on EVERY run. The committed
 *    `heroes.json` is never used as an input, so new heroes, retired heroes,
 *    roles, portraits and pub/pro stats flow in automatically.
 *  - 4 last fully completed weekly buckets (zero current incomplete week).
 *  - Calibrated rank brackets: HERALD_GUARDIAN, CRUSADER_ARCHON, LEGEND_ANCIENT, DIVINE_IMMORTAL.
 *  - STRATZ is queried for exactly the hero ids OpenDota just returned.
 *  - Strict data contract validation before anything is published.
 *  - All three files are swapped in as one directory, so heroes/matchups/meta
 *    can never describe different snapshots.
 *  - On ANY failure: non-zero exit, previous dataset left byte-for-byte intact.
 *
 * There are deliberately no fallbacks to previously committed values (an old
 * `latestPatch`, an old roster). A failed fetch is a failed run.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getCompleteWeeklyBuckets, BUCKET_SEC } from './stratz/buckets.mjs';
import { fetchPositionsFromStratz, validatePositionData } from './stratz/positions.mjs';
import { fetchItemStats, fetchItemsMetadata, pruneItemCatalogue, validateItemData } from './stratz/items.mjs';
import { POSITION_ELIGIBILITY } from './stratz/eligibility.mjs';
import { fetchOpenDotaMetadata, validateHeroMetadata } from './opendota/metadata.mjs';
import { publishDatasetAtomically } from './dataset-publish.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(ROOT, 'public', 'data');
const ENDPOINT = 'https://api.stratz.com/graphql';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const CHUNK_SIZE = 32;
const WEEKS_COUNT = 4;
const BRACKETS = ['HERALD_GUARDIAN', 'CRUSADER_ARCHON', 'LEGEND_ANCIENT', 'DIVINE_IMMORTAL'];

function loadToken() {
  const fromEnv = process.env.STRATZ_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const envFile = readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of envFile.split(/\r?\n/)) {
      const m = line.match(/^\s*STRATZ_API_TOKEN\s*=\s*(.*?)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    }
  } catch {
    /* ignore missing .env */
  }
  throw new Error('STRATZ_API_TOKEN is not set (environment variable or .env file)');
}

function sanitize(text) {
  const token = process.env.STRATZ_API_TOKEN?.trim();
  let out = text;
  if (token) out = out.split(token).join('<redacted-token>');
  return out.replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer <redacted>');
}

class StratzTransport {
  constructor(token) {
    this.token = token;
    this.browser = null;
    this.page = null;
  }

  async init() {
    const { chromium } = await import('playwright');
    this.browser = await chromium.launch({
      headless: true,
      channel: 'chromium',
      args: ['--disable-blink-features=AutomationControlled'],
    });
    const ctx = await this.browser.newContext({ userAgent: UA });
    this.page = await ctx.newPage();
  }

  async ensureNavigated() {
    if (!this.page.url() || this.page.url() === 'about:blank') {
      await this.page.goto(ENDPOINT, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await this.waitChallenge();
    }
  }

  async waitChallenge() {
    for (let i = 0; i < 60; i += 1) {
      const title = await this.page.title().catch(() => '');
      if (!/just a moment/i.test(title)) return true;
      await this.page.waitForTimeout(2000);
    }
    return false;
  }

  async query(queryStr, variables) {
    await this.ensureNavigated();
    let res = null;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      res = await this.page.evaluate(
        async ({ endpoint, query, variables, token }) => {
          const r = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ query, variables }),
          });
          return { status: r.status, text: await r.text() };
        },
        { endpoint: ENDPOINT, query: queryStr, variables, token: this.token },
      );

      const challenged =
        res.status === 403 && /just a moment|cf-chl|challenge-platform|Attention Required/i.test(res.text);
      if (!challenged) break;

      console.warn(`  [Cloudflare challenge] attempt ${attempt}/5 — re-navigating…`);
      await this.page.goto(ENDPOINT, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      const cleared = await this.waitChallenge();
      if (!cleared) throw new Error('Cloudflare interstitial did not clear within 60s');
    }

    if (!res) throw new Error('No response from STRATZ GraphQL');
    if (res.status === 429) throw new Error(`HTTP 429 rate limited: ${sanitize(res.text.slice(0, 200))}`);
    if (res.status !== 200) throw new Error(`GraphQL HTTP ${res.status}: ${sanitize(res.text.slice(0, 300))}`);

    const parsed = JSON.parse(res.text);
    if (parsed.errors) throw new Error(`GraphQL errors: ${sanitize(JSON.stringify(parsed.errors).slice(0, 600))}`);
    return parsed;
  }

  async close() {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.page = null;
    }
  }
}

export function buildChunkQuery(heroIds, buckets) {
  const nodes = buckets
    .map(
      (b) =>
        `w${b}: matchUp(heroIds: [${heroIds.join(', ')}], week: ${b * BUCKET_SEC}, bracketBasicIds: [${BRACKETS.join(', ')}], take: 200) { heroId vs { heroId1 heroId2 matchCount winCount } }`,
    )
    .join('\n    ');
  return `{ heroStats {\n    ${nodes}\n  } }`;
}


export { StratzTransport };

export {
  loadToken,
  sanitize,
  getCompleteWeeklyBuckets,
  BUCKET_SEC,
  BRACKETS,
  CHUNK_SIZE,
  WEEKS_COUNT,
  validateProductionContract,
  // `buildChunkQuery`, `fetchMatchupsFromStratz` and `buildDataset` are exported
  // inline at their definitions below.
};

function pctile(arr, q) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
}

function dist(arr) {
  return {
    medianPct: Number((100 * pctile(arr, 0.5)).toFixed(3)),
    p95Pct: Number((100 * pctile(arr, 0.95)).toFixed(3)),
    p99Pct: Number((100 * pctile(arr, 0.99)).toFixed(3)),
    maxPct: Number((100 * (arr.length ? Math.max(...arr) : 0)).toFixed(3)),
  };
}

function validateProductionContract(heroes, dataset) {
  const expectedHeroIds = heroes.map((h) => h.id).sort((a, b) => a - b);
  const expectedIds = new Set(expectedHeroIds);
  const presentIds = new Set(Object.keys(dataset).map(Number));

  if (expectedHeroIds.length < 100) throw new Error(`Too few heroes in definition: ${expectedHeroIds.length}`);

  const missingHeroIds = expectedHeroIds.filter((id) => !presentIds.has(id));
  const extraHeroIds = [...presentIds].filter((id) => !expectedIds.has(id));
  if (missingHeroIds.length > 0 || extraHeroIds.length > 0) {
    throw new Error(`Hero ID mismatch! Missing: ${missingHeroIds.join(',')}, Extra: ${extraHeroIds.join(',')}`);
  }

  const wrongOpponentCount = [];
  let selfRows = 0;
  let duplicateOpponents = 0;
  let gamesNotPositive = 0;
  let winsOutOfRange = 0;
  let unknownOpponents = 0;
  let missingReversePairs = 0;
  let pairsOver3pct = 0;
  let skewOver5pct = 0;
  const gamesDiffRel = [];
  const skewRel = [];
  const heroAggWr = [];
  const rowTotal = new Map();
  const colTotal = new Map();
  let totalPairs = 0;

  for (const [key, rows] of Object.entries(dataset)) {
    const enemyId = Number(key);
    totalPairs += rows.length;
    if (rows.length !== expectedHeroIds.length - 1) {
      wrongOpponentCount.push({ enemyId, opponents: rows.length });
    }
    const seen = new Set();
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

      const rev = dataset[String(r.hero_id)]?.find((x) => x.hero_id === enemyId);
      if (!rev) {
        missingReversePairs += 1;
      } else {
        const dRel = Math.abs(r.games_played - rev.games_played) / r.games_played;
        gamesDiffRel.push(dRel);
        // Small sample pairs (e.g. Chen vs Elder Titan ~150 games) can have ±5 matches diff (~3.3%).
        // A pair exceeds tolerance if relative diff > 3% AND absolute diff > 15 games.
        if (dRel > 0.03 && Math.abs(r.games_played - rev.games_played) > 15) {
          pairsOver3pct += 1;
        }
        const sRel = Math.abs(r.wins + rev.wins - r.games_played) / r.games_played;
        skewRel.push(sRel);
        if (sRel > 0.05 && Math.abs(r.wins + rev.wins - r.games_played) > 15) {
          skewOver5pct += 1;
        }
      }
    }
    rowTotal.set(enemyId, g);
    heroAggWr.push({ heroId: enemyId, games: g, wins: w, wr: Number(((100 * w) / Math.max(1, g)).toFixed(2)) });
  }

  const rowColRel = expectedHeroIds.map((id) => {
    const rt = rowTotal.get(id) ?? 0;
    return rt ? Math.abs(rt - (colTotal.get(id) ?? 0)) / rt : 0;
  });
  const rowColOver1p5 = rowColRel.filter((x) => x > 0.015).length;
  const wrOutOfBand = heroAggWr.filter((x) => x.wr < 40 || x.wr > 60);

  const totalExpectedPairs = expectedHeroIds.length * (expectedHeroIds.length - 1);
  if (totalPairs !== totalExpectedPairs) {
    throw new Error(`Total pair rows mismatch: expected ${totalExpectedPairs}, got ${totalPairs}`);
  }
  if (wrongOpponentCount.length > 0) throw new Error(`${wrongOpponentCount.length} heroes have != ${expectedHeroIds.length - 1} opponents`);
  if (selfRows > 0) throw new Error(`Found ${selfRows} self-matchup rows`);
  if (duplicateOpponents > 0) throw new Error(`Found ${duplicateOpponents} duplicate opponent entries`);
  if (gamesNotPositive > 0) throw new Error(`Found ${gamesNotPositive} rows with games_played <= 0`);
  if (winsOutOfRange > 0) throw new Error(`Found ${winsOutOfRange} rows with wins out of [0, games] range`);
  if (unknownOpponents > 0) throw new Error(`Found ${unknownOpponents} unknown opponent IDs`);
  if (missingReversePairs > 0) throw new Error(`Found ${missingReversePairs} missing reverse pairs`);
  if (pairsOver3pct > 0) {
    throw new Error(
      `Found ${pairsOver3pct} reverse pairs exceeding games asymmetry tolerance (>3% relative AND >15 games absolute)`,
    );
  }
  if (skewOver5pct > 0) {
    throw new Error(
      `Found ${skewOver5pct} pairs with wins sum skew > 5% (and >15 games absolute)`,
    );
  }
  if (wrOutOfBand.length > 0) throw new Error(`Found ${wrOutOfBand.length} heroes with aggregate WR outside 40-60%`);
  if (rowColOver1p5 > 0) throw new Error(`Found ${rowColOver1p5} heroes with row/column total skew > 1.5%`);

  return {
    totalPairs,
    reversePairAsymmetry: dist(gamesDiffRel),
    winsSumSkew: dist(skewRel),
    rowColSkew: dist(rowColRel),
    heroAggWr,
  };
}


/**
 * Query STRATZ for every `heroId` and return `enemyId -> MatchupRow[]`.
 * Pure with respect to `heroIds`: whatever list it is handed is the list queried.
 */
export async function fetchMatchupsFromStratz(heroIds, windowInfo, { token, log = console.log } = {}) {
  log(`    Querying STRATZ GraphQL in ${Math.ceil(heroIds.length / CHUNK_SIZE)} chunk requests…`);
  const transport = new StratzTransport(token);
  await transport.init();

  const chunks = [];
  for (let i = 0; i < heroIds.length; i += CHUNK_SIZE) {
    chunks.push(heroIds.slice(i, i + CHUNK_SIZE));
  }

  // totals: enemyId -> opponentId -> { games, wins }
  const totals = new Map();
  try {
    for (let ci = 0; ci < chunks.length; ci += 1) {
      const chunk = chunks[ci];
      const q = buildChunkQuery(chunk, windowInfo.buckets);
      const t0 = Date.now();
      const res = await transport.query(q);
      log(`    Chunk ${ci + 1}/${chunks.length} (${chunk.length} heroes) fetched in ${Date.now() - t0}ms`);

      for (const b of windowInfo.buckets) {
        const dryads = res.data?.heroStats?.[`w${b}`] ?? [];
        for (const dryad of dryads) {
          const enemyId = Number(dryad.heroId);
          if (!totals.has(enemyId)) totals.set(enemyId, new Map());
          const rowMap = totals.get(enemyId);
          for (const r of dryad.vs ?? []) {
            const opponent = r.heroId1 === enemyId ? r.heroId2 : r.heroId1;
            const wins = r.heroId1 === enemyId ? r.winCount : r.matchCount - r.winCount;
            const cur = rowMap.get(opponent) ?? { games: 0, wins: 0 };
            cur.games += r.matchCount;
            cur.wins += wins;
            rowMap.set(opponent, cur);
          }
        }
      }
    }
  } finally {
    await transport.close();
  }

  const matchups = {};
  for (const [enemyId, rowMap] of totals) {
    matchups[String(enemyId)] = [...rowMap.entries()]
      .map(([opponent, v]) => ({ hero_id: opponent, games_played: v.games, wins: v.wins }))
      .sort((a, b) => b.games_played - a.games_played);
  }
  return matchups;
}

/**
 * The whole refresh as a function: OpenDota metadata -> STRATZ matchups ->
 * validation -> meta payloads. Writes nothing.
 *
 * Dependency injection is not ceremony: the ТЗ №7 ordering guarantees (STRATZ
 * must not run when OpenDota failed; STRATZ must be asked for exactly the fresh
 * hero ids; `latestPatch` must never come from the old meta.json) are only
 * observable if the network calls are replaceable.
 */
export async function buildDataset({
  fetchMetadata = fetchOpenDotaMetadata,
  fetchMatchups = fetchMatchupsFromStratz,
  fetchPositions = fetchPositionsFromStratz,
  fetchItems = fetchItemsMetadata,
  fetchItemsStats = fetchItemStats,
  now = new Date(),
  log = console.log,
} = {}) {
  // 1. Fresh OpenDota metadata. A throw here means nothing downstream runs.
  log('1/6 Fetching fresh hero metadata from OpenDota...');
  const { heroes, latestPatch } = await fetchMetadata();
  // Re-validated even though the loader already validates: the guard belongs to
  // the pipeline, not to one implementation of the loader, and a patch string
  // must never silently become ''.
  validateHeroMetadata(heroes, latestPatch);
  const heroIds = heroes.map((h) => h.id).sort((a, b) => a - b);
  log(`    OpenDota returned ${heroIds.length} heroes, latest patch ${latestPatch}`);

  // 2. Dynamic weekly buckets (4 complete weeks, zero current incomplete).
  const windowInfo = getCompleteWeeklyBuckets(now, WEEKS_COUNT);
  log(
    `2/6 Weekly buckets computed: [${windowInfo.buckets.join(', ')}] (current partial: ${windowInfo.currentBucket} excluded)`,
  );
  log(`    Window: ${windowInfo.windowStartUtc} -> ${windowInfo.windowEndUtcExclusive} (28 days)`);

  // 3+4. STRATZ, queried for exactly the fresh hero ids. Matchups and position
  // stats are two independent queries over the SAME buckets, so the two layers
  // can never describe different weeks (§6).
  const matchups = await fetchMatchups(heroIds, windowInfo, { log });
  const positions = await fetchPositions(heroIds, windowInfo, { log });
  // §11 order: matchups -> positions -> item metadata -> item stats. A failure
  // in ANY of these aborts the whole run; nothing is published partially.
  //
  // §10: the hero-game denominator for each (hero, position) comes from the
  // position layer we JUST fetched, not from the item endpoint (which cannot
  // supply it) and not from summing purchases (which would be nonsense). It has
  // to be assembled here, before the item fetch, not after it.
  const heroGamesByPosition = new Map();
  for (const h of heroes) {
    const entry = positions[String(h.id)];
    for (const lane of ['1', '2', '3', '4', '5']) {
      heroGamesByPosition.set(`${h.id}:${lane}`, entry?.positions?.[lane]?.games ?? 0);
    }
  }
  const rawItems = await fetchItems({ log });
  const itemStats = await fetchItemsStats(heroIds, windowInfo, { log, heroGamesByPosition });

  // 5. Strict 13-point data contract validation, against the FRESH roster.
  log('5/6 Validating dataset integrity contract...');
  const validationResult = validateProductionContract(heroes, matchups);
  log(`    Validation passed! Total rows: ${validationResult.totalPairs}`);
  log(`    Reverse pair asymmetry median: ${validationResult.reversePairAsymmetry.medianPct}% (p99: ${validationResult.reversePairAsymmetry.p99Pct}%, max: ${validationResult.reversePairAsymmetry.maxPct}%)`);
  log(`    Wins sum skew median: ${validationResult.winsSumSkew.medianPct}% (p99: ${validationResult.winsSumSkew.p99Pct}%, max: ${validationResult.winsSumSkew.maxPct}%)`);
  const positionInfo = validatePositionData(positions, { heroes, windowInfo });
  log(`    Position data passed! ${positionInfo.heroCount} heroes across buckets [${positionInfo.buckets.join(', ')}]`);

  // §6/§10: item statistics are keyed by the position we REQUESTED. The catalogue
  // is narrowed only after the statistics are in, so that neutral items (not
  // shop items, but genuinely bought) survive while internal-only entities do not.
  const pruned = pruneItemCatalogue(rawItems, itemStats);
  const items = pruned.items;
  log(`    Catalogue pruned to ${pruned.keptCount} items (${pruned.shopOnly} shop, ` +
      `${pruned.nonShopButBought} non-shop but purchased, e.g. neutral items)`);
  const itemInfo = validateItemData(items, itemStats, { heroes, windowInfo });
  log(`    Item data passed! ${itemInfo.itemCount} items, ${itemInfo.heroesWithData} heroes, ` +
      `${itemInfo.positions} hero-position cells, ${itemInfo.cells} item cells`);

  const totalPairGames = Object.values(matchups).reduce(
    (s, rows) => s + rows.reduce((x, r) => x + r.games_played, 0),
    0,
  );

  const meta = {
    source: 'STRATZ',
    heroMetadataSource: 'OpenDota',
    generatedAt: now.toISOString(),
    latestPatch,
    heroCount: heroes.length,
    matchupWindow: {
      kind: 'sum-of-complete-weekly-buckets',
      weeks: windowInfo.buckets.length,
      weeklyBuckets: windowInfo.buckets,
      completeWeeksOnly: true,
      windowStartUtc: windowInfo.windowStartUtc,
      windowEndUtcExclusive: windowInfo.windowEndUtcExclusive,
      excludedBuckets: {
        currentIncomplete: windowInfo.currentBucket,
        reason: 'partial week — not production-ready',
      },
    },
    population: {
      type: 'rank-bracket',
      description: 'Rank-bracket data (calibrated ranks: Herald through Immortal)',
      brackets: BRACKETS,
    },
    matchupPatchFilter: false,
    positionData: {
      source: 'STRATZ',
      weeks: windowInfo.buckets.length,
      weeklyBuckets: windowInfo.buckets,
      completeWeeksOnly: true,
      population: {
        type: 'rank-bracket',
        description: 'Rank-bracket data (calibrated ranks: Herald through Immortal)',
        brackets: BRACKETS,
      },
      eligibility: {
        minShare: POSITION_ELIGIBILITY.minShare,
        minGames: POSITION_ELIGIBILITY.minGames,
        rule: 'hard gate — a hero must clear both thresholds for a position to be ranked there',
      },
    },
    itemData: {
      source: 'STRATZ',
      weeks: windowInfo.buckets.length,
      weeklyBuckets: windowInfo.buckets,
      completeWeeksOnly: true,
      population: {
        type: 'rank-bracket',
        description: 'Rank-bracket data (calibrated ranks: Herald through Immortal)',
        brackets: BRACKETS,
      },
      statistics: {
        type: 'item-purchases',
        matchCountSemantics: 'purchase-events',
        note:
          'purchases counts purchase EVENTS, not distinct games — it may exceed ' +
          'heroGames. wins is a subset of purchases. No rate is precomputed here, ' +
          'and nothing in this layer is conditioned on the enemy draft.',
      },
      // itemFullPurchase is not patch-filtered; it is bucketed by week only.
      patchFiltered: false,
    },
    schema: {
      matchupsFile: '{ "<enemyHeroId>": [{ "hero_id": <opponentHeroId>, "games_played": n, "wins": n }] }',
      winsPerspective:
        'wins = wins of the KEY hero (the enemy facing the candidates) — identical convention to OpenDota',
      heroCount: heroes.length,
      totalRows: validationResult.totalPairs,
      totalPairGames,
    },
    dataQuality: {
      reversePairAsymmetry: validationResult.reversePairAsymmetry,
      winsSumSkew: validationResult.winsSumSkew,
      rowColSkew: validationResult.rowColSkew,
      checksPassed: 13,
    },
  };

  return { heroes, matchups, positions, items, itemStats, meta, validationResult, positionInfo, itemInfo };
}

async function main() {
  console.log('--- Production Dataset Generator (STRATZ matchups + OpenDota metadata) ---');
  const token = loadToken();

  // 1-5: fetch fresh metadata, query STRATZ, validate. Any throw aborts the run
  // before a single byte of the live dataset is touched.
  const { heroes, matchups, positions, items, itemStats, meta } = await buildDataset({
    fetchMatchups: (heroIds, windowInfo, opts) =>
      fetchMatchupsFromStratz(heroIds, windowInfo, { ...opts, token }),
    fetchPositions: (heroIds, windowInfo, opts) =>
      fetchPositionsFromStratz(heroIds, windowInfo, { ...opts, token }),
    fetchItems: (opts) => fetchItemsMetadata({ ...opts, token }),
    fetchItemsStats: (heroIds, windowInfo, opts) =>
      fetchItemStats(heroIds, windowInfo, { ...opts, token }),
  });

  // 6. Publish every layer as ONE directory swap — items cannot lag behind the
  // heroes they are keyed by.
  console.log('6/6 Publishing dataset atomically (heroes, matchups, positions, items, item-stats, meta)...');
  const sizes = await publishDatasetAtomically(
    DATA_DIR,
    {
      'heroes.json': heroes,
      'matchups.json': matchups,
      'positions.json': positions,
      'items.json': items,
      'item-stats.json': itemStats,
      'meta.json': meta,
    },
    // STRATZ always returns a full matrix; enforce it at the last gate too.
    { requireCompleteTables: true },
  );
  for (const [name, bytes] of Object.entries(sizes)) {
    console.log(`    ${name} — ${bytes} bytes`);
  }

  console.log(`--- Dataset updated: ${heroes.length} heroes, latest patch ${meta.latestPatch} ---`);
}

// Only run when executed directly (`node scripts/update-data-stratz.mjs`).
// Imported by scripts/update-data-stratz.test.ts, which must reach the exported
// helpers without launching a browser or hitting the network.
const isDirectRun =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((err) => {
    console.error('\nUPDATE FAILED — production public/data left completely untouched!');
    console.error(err);
    process.exit(1);
  });
}

