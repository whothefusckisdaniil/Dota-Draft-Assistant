#!/usr/bin/env node
/**
 * Production data refresh generator (ТЗ №6 + №7).
 *
 *   OpenDota metadata  ──▶ canonical heroes[] + latestPatch
 *          │
 *          ├─▶ heroIds ──▶ STRATZ GraphQL (rolling last 30 days) ──▶ matchups
 *          │                                                     └──▶ positions
 *          └─▶ heroes.json
 *
 *                     ▼  validate  ▼  publish atomically
 *              public/data/{heroes,matchups,positions,meta}.json
 *
 * The dataset serves the Counterpick engine only (ТЗ №77): no item catalogue,
 * no item purchase statistics and no item-build layer are fetched or published.
 *
 * Rules:
 *  - Hero metadata is fetched fresh from OpenDota on EVERY run. The committed
 *    `heroes.json` is never used as an input, so new heroes, retired heroes,
 *    roles, portraits and pub/pro stats flow in automatically.
 *  - 4 last fully completed weekly buckets (zero current incomplete week).
 *  - Calibrated rank brackets: HERALD_GUARDIAN, CRUSADER_ARCHON, LEGEND_ANCIENT, DIVINE_IMMORTAL.
 *  - STRATZ is queried for exactly the hero ids OpenDota just returned.
 *  - Strict data contract validation before anything is published.
 *  - All four files are swapped in as one directory, so heroes/matchups/
 *    positions/meta can never describe different snapshots.
 *  - On ANY failure: non-zero exit, previous dataset left byte-for-byte intact.
 *
 * There are deliberately no fallbacks to previously committed values (an old
 * `latestPatch`, an old roster). A failed fetch is a failed run.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getCompleteWeeklyBuckets, getRollingWindow, BUCKET_SEC, ROLLING_DAYS } from './stratz/buckets.mjs';
import { fetchPositionsFromStratz, validatePositionData } from './stratz/positions.mjs';
import { POSITION_ELIGIBILITY } from './stratz/eligibility.mjs';
import { fetchOpenDotaMetadata, validateHeroMetadata } from './opendota/metadata.mjs';
import { publishDatasetAtomically } from './dataset-publish.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(ROOT, 'public', 'data');
const ENDPOINT = 'https://api.stratz.com/graphql';

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

/**
 * STRATZ GraphQL client.
 *
 * STRATZ's API sits behind Cloudflare. API clients are expected to identify
 * themselves with `User-Agent: STRATZ_API` plus their bearer token; such
 * requests are let through, generic clients get a "Just a moment…" challenge
 * (verified 2026-11-16: 200 with STRATZ_API, 403 challenge with a generic UA).
 * Earlier versions drove a headless Chromium with automation detection
 * disabled to get past that challenge; that is not needed and not done any more.
 *
 * The class keeps its init/query/close shape so research scripts and tests that
 * inject a transport keep working.
 */
export const STRATZ_USER_AGENT = 'STRATZ_API';
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

class StratzTransport {
  constructor(token, { fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxAttempts = 4 } = {}) {
    if (!token) throw new Error('STRATZ_API_TOKEN is not set');
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.maxAttempts = maxAttempts;
  }

  async init() {}

  async query(queryStr, variables) {
    let lastError = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      let res;
      try {
        const r = await this.fetchImpl(ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': STRATZ_USER_AGENT,
            Authorization: `Bearer ${this.token}`,
          },
          body: JSON.stringify({ query: queryStr, variables }),
        });
        res = { status: r.status, text: await r.text() };
      } catch (e) {
        lastError = new Error(`STRATZ network error: ${sanitize(e.message)}`);
        if (attempt < this.maxAttempts) await this.sleep(2000 * attempt);
        continue;
      }

      if (res.status === 403 && /just a moment|cf-chl|challenge-platform|Attention Required/i.test(res.text)) {
        // Not retried: a challenge here means STRATZ changed how API clients are admitted.
        throw new Error(
          'STRATZ API request was stopped by Cloudflare even with User-Agent STRATZ_API. ' +
            'STRATZ may have changed its API access rules — check https://stratz.com/api. ' +
            'The previous dataset stays published.',
        );
      }
      if (RETRYABLE.has(res.status) && attempt < this.maxAttempts) {
        lastError = new Error(`HTTP ${res.status}`);
        await this.sleep((res.status === 429 ? 15000 : 3000) * attempt);
        continue;
      }
      if (res.status === 429) throw new Error(`HTTP 429 rate limited: ${sanitize(res.text.slice(0, 200))}`);
      if (res.status === 401 || (res.status === 403 && /token/i.test(res.text))) {
        throw new Error(`STRATZ token rejected (HTTP ${res.status}) — renew it at https://stratz.com/api: ${sanitize(res.text.slice(0, 200))}`);
      }
      if (res.status !== 200) throw new Error(`GraphQL HTTP ${res.status}: ${sanitize(res.text.slice(0, 300))}`);

      const parsed = JSON.parse(res.text);
      if (parsed.errors) throw new Error(`GraphQL errors: ${sanitize(JSON.stringify(parsed.errors).slice(0, 600))}`);
      return parsed;
    }
    throw lastError ?? new Error('No response from STRATZ GraphQL');
  }

  async close() {}
}

export function buildChunkQuery(heroIds, buckets, brackets = BRACKETS, { withSynergy = false } = {}) {
  const nodes = buckets
    .map(
      (b) =>
        `w${b}: matchUp(heroIds: [${heroIds.join(', ')}], week: ${b * BUCKET_SEC}, bracketBasicIds: [${brackets.join(', ')}], take: 200) { heroId vs { heroId1 heroId2 matchCount winCount }${withSynergy ? ' with { heroId1 heroId2 matchCount winCount }' : ''} }`,
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

/** Reverse-pair games asymmetry: a face counts as asymmetric above 3% AND 15 games. */
export const ASYMMETRY_SOFT_REL = 0.03;
export const ASYMMETRY_MIN_ABS = 15;
/** Any face above this relative difference blocks the refresh. */
export const ASYMMETRY_HARD_REL = 0.1;
/** At most this share of all rows (but at least MIN_BUDGET) may be softly asymmetric. */
export const ASYMMETRY_MAX_SHARE = 0.001;
export const ASYMMETRY_MIN_BUDGET = 4;

/**
 * New heroes (a hero released days ago). In a 30-day window such a hero has a
 * sliver of everyone else's games and may not have met every opponent yet. It
 * must not block the daily refresh for all other heroes, so for these heroes
 * only: a pair with 0 games is "no data" (the app already treats it so), and
 * the 40–60% aggregate win-rate band is skipped. Everything else stays strict.
 * The rarest established hero (Chen) sits at ~6% of the median hero's games,
 * so the 3% line keeps every existing hero under the full contract, and more
 * than MAX_NEW_HEROES such heroes means broken data, not a release.
 */
const NEW_HERO_GAMES_SHARE = 0.03;
const MAX_NEW_HEROES = 3;

export function findNewHeroes(heroes, table) {
  const totals = heroes.map((h) => ({
    id: h.id,
    games: (table[String(h.id)] ?? []).reduce((s, r) => s + Math.max(0, Number(r.games_played) || 0), 0),
  }));
  const sorted = totals.map((t) => t.games).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return new Set(totals.filter((t) => t.games < median * NEW_HERO_GAMES_SHARE).map((t) => t.id));
}

/** Every hero gets a table with every opponent: pairs STRATZ did not return
 *  (nobody played them yet) become explicit 0-game rows, so the contract can
 *  tell "a new hero has not met X yet" from a broken response. Unknown keys are
 *  kept so the contract still reports them. */
export function fillMissingPairs(heroes, table) {
  const ids = heroes.map((h) => h.id);
  const out = {};
  for (const id of ids) {
    const rows = table[String(id)] ?? [];
    const have = new Set(rows.map((r) => r.hero_id));
    const extra = ids.filter((o) => o !== id && !have.has(o)).map((o) => ({ hero_id: o, games_played: 0, wins: 0 }));
    out[String(id)] = extra.length ? [...rows, ...extra] : rows;
  }
  for (const k of Object.keys(table)) if (!(k in out)) out[k] = table[k];
  return out;
}

/**
 * @param {{ allowZeroGames?: boolean }} [options] allowZeroGames: per-rank tables
 *   may legitimately have a pair nobody played in that bracket (e.g. Herald on
 *   the first day of a patch); the app treats such a row as "no data".
 */
function validateProductionContract(heroes, dataset, { allowZeroGames = false } = {}) {
  const expectedHeroIds = heroes.map((h) => h.id).sort((a, b) => a - b);
  const expectedIds = new Set(expectedHeroIds);
  const presentIds = new Set(Object.keys(dataset).map(Number));

  if (expectedHeroIds.length < 100) throw new Error(`Too few heroes in definition: ${expectedHeroIds.length}`);
  const newHeroes = findNewHeroes(heroes, dataset);
  if (newHeroes.size > MAX_NEW_HEROES) {
    throw new Error(`${newHeroes.size} heroes have under ${NEW_HERO_GAMES_SHARE * 100}% of the median hero's games (${[...newHeroes].slice(0, 8).join(',')}): broken data, not a new hero`);
  }

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
  let pairsOverHardLimit = 0;
  const asymmetricFaces = [];
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
      const newPair = newHeroes.has(enemyId) || newHeroes.has(r.hero_id);
      if (allowZeroGames || newPair ? r.games_played < 0 : r.games_played <= 0) gamesNotPositive += 1;
      if (r.wins < 0 || r.wins > r.games_played) winsOutOfRange += 1;
      if (!expectedIds.has(r.hero_id)) unknownOpponents += 1;
      g += r.games_played;
      w += r.wins;
      colTotal.set(r.hero_id, (colTotal.get(r.hero_id) ?? 0) + r.games_played);

      const rev = dataset[String(r.hero_id)]?.find((x) => x.hero_id === enemyId);
      if (!rev) {
        missingReversePairs += 1;
      } else if (r.games_played > 0) {
        const dRel = Math.abs(r.games_played - rev.games_played) / r.games_played;
        gamesDiffRel.push(dRel);
        // Small sample pairs (e.g. Chen vs Elder Titan ~150 games) can have ±5 matches diff (~3.3%).
        // A pair exceeds tolerance if relative diff > 3% AND absolute diff > 15 games.
        if (dRel > ASYMMETRY_SOFT_REL && Math.abs(r.games_played - rev.games_played) > ASYMMETRY_MIN_ABS) {
          pairsOver3pct += 1;
          asymmetricFaces.push({ enemyId, heroId: r.hero_id, games: r.games_played, reverseGames: rev.games_played });
          if (dRel > ASYMMETRY_HARD_REL) pairsOverHardLimit += 1;
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
  const wrOutOfBand = heroAggWr.filter((x) => !newHeroes.has(x.heroId) && (x.wr < 40 || x.wr > 60));

  const totalExpectedPairs = expectedHeroIds.length * (expectedHeroIds.length - 1);
  if (totalPairs !== totalExpectedPairs) {
    throw new Error(`Total pair rows mismatch: expected ${totalExpectedPairs}, got ${totalPairs}`);
  }
  if (wrongOpponentCount.length > 0) throw new Error(`${wrongOpponentCount.length} heroes have != ${expectedHeroIds.length - 1} opponents`);
  if (selfRows > 0) throw new Error(`Found ${selfRows} self-matchup rows`);
  if (duplicateOpponents > 0) throw new Error(`Found ${duplicateOpponents} duplicate opponent entries`);
  if (gamesNotPositive > 0) throw new Error(`Found ${gamesNotPositive} rows with games_played ${allowZeroGames ? '< 0' : '<= 0'}`);
  if (winsOutOfRange > 0) throw new Error(`Found ${winsOutOfRange} rows with wins out of [0, games] range`);
  if (unknownOpponents > 0) throw new Error(`Found ${unknownOpponents} unknown opponent IDs`);
  if (missingReversePairs > 0) throw new Error(`Found ${missingReversePairs} missing reverse pairs`);
  // STRATZ itself returns slightly different matchCount for A→B and B→A
  // (reproducible, see research/data-quality/stratz-support-escalation-final.md).
  // A few faces just above 3% are that known vendor behaviour and barely move a
  // win rate, so they are tolerated and reported. Anything grossly asymmetric,
  // or asymmetry spread over many pairs, still blocks the refresh.
  const asymmetryBudget = Math.max(ASYMMETRY_MIN_BUDGET, Math.floor(totalPairs * ASYMMETRY_MAX_SHARE));
  if (pairsOverHardLimit > 0 || pairsOver3pct > asymmetryBudget) {
    throw new Error(
      `Found ${pairsOver3pct} reverse pairs exceeding games asymmetry tolerance (>3% relative AND >15 games absolute; ` +
        `${pairsOverHardLimit} above ${ASYMMETRY_HARD_REL * 100}%, allowed: ${asymmetryBudget} faces, none above ${ASYMMETRY_HARD_REL * 100}%)`,
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
    newHeroes: [...newHeroes],
    totalPairs,
    reversePairAsymmetry: dist(gamesDiffRel),
    asymmetricFaces,
    winsSumSkew: dist(skewRel),
    rowColSkew: dist(rowColRel),
    heroAggWr,
  };
}


/**
 * Query STRATZ for every `heroId` and return `enemyId -> MatchupRow[]`.
 * Pure with respect to `heroIds`: whatever list it is handed is the list queried.
 */
export function aggregateStratzMatchupChunks(chunks, windowInfo, validHeroIdsSet) {
  // validHeroIdsSet: Set of ALL valid hero IDs (global, for opponent validation)
  // Each chunk has its own chunkHeroIds array (per-chunk, for dryad validation)
  const totals = new Map(); // enemyId -> opponentId -> { games, wins }
  const bucketSeenHeroes = new Map(); // bucket -> Set of heroId
  const bucketSeenPairs = new Map(); // bucket -> Set of `${enemyId}:${opponent}`

  for (const { chunkIndex, chunkHeroIds, response } of chunks) {
    // Per-chunk Set for dryad.heroId validation
    const chunkHeroIdsSet = new Set(chunkHeroIds);
    if (chunkHeroIdsSet.size !== chunkHeroIds.length) {
      throw new Error(`Chunk ${chunkIndex} contains duplicate Hero IDs`);
    }

    for (const b of windowInfo.buckets) {
      // Rolling window: the oldest week may count only partly (see getRollingWindow).
      const weight = windowInfo.weights?.[b] ?? 1;
      if (!(weight > 0 && weight <= 1)) throw new Error(`Invalid weight ${weight} for bucket ${b}`);
      if (!bucketSeenHeroes.has(b)) bucketSeenHeroes.set(b, new Set());
      if (!bucketSeenPairs.has(b)) bucketSeenPairs.set(b, new Set());

      const dryads = response.data?.heroStats?.[`w${b}`] ?? [];
      for (const dryad of dryads) {
        const heroId = Number(dryad.heroId);

        // heroId must be a valid integer
        if (!Number.isInteger(heroId) || heroId <= 0) {
          throw new Error(`Invalid heroId in dryad: ${heroId}`);
        }

        // dryad.heroId must belong to this chunk's requested hero IDs (per-chunk validation)
        if (!chunkHeroIdsSet.has(heroId)) {
          throw new Error(`dryad.heroId ${heroId} not in current requested heroIds chunk ${chunkIndex}`);
        }

        // no duplicate dryad.heroId in one bucket (checked across all chunks via bucketSeenHeroes)
        const heroSeenInBucket = bucketSeenHeroes.get(b);
        if (heroSeenInBucket.has(heroId)) {
          throw new Error(`Duplicate heroId ${heroId} in bucket ${b}`);
        }
        heroSeenInBucket.add(heroId);

        const enemyId = heroId;
        for (const r of dryad.vs ?? []) {
          const heroId1 = r.heroId1;
          const heroId2 = r.heroId2;
          const matchCount = r.matchCount;
          const winCount = r.winCount;

          // heroId1 and heroId2 must be valid Hero IDs
          if (!Number.isInteger(heroId1) || heroId1 <= 0) {
            throw new Error(`Invalid heroId1: ${heroId1}`);
          }
          if (!Number.isInteger(heroId2) || heroId2 <= 0) {
            throw new Error(`Invalid heroId2: ${heroId2}`);
          }

          // heroId1 !== heroId2
          if (heroId1 === heroId2) {
            throw new Error(`Self-matchup row: heroId1 === heroId2 (${heroId1})`);
          }

          // enemyId must match heroId1 or heroId2
          if (heroId1 !== enemyId && heroId2 !== enemyId) {
            throw new Error(`Orientation error: enemyId ${enemyId} not in heroId1/heroId2 for dryad ${heroId}`);
          }

          const opponent = heroId1 === enemyId ? heroId2 : heroId1;
          // opponent must not equal enemyId
          if (opponent === enemyId) {
            throw new Error(`Opponent equals current hero ${enemyId}`);
          }

          // opponent must belong to the global valid hero ID set
          if (!validHeroIdsSet.has(opponent)) {
            throw new Error(`Opponent ${opponent} not in global valid hero ID set`);
          }

          // matchCount must be valid integer
          if (!Number.isInteger(matchCount) || matchCount < 0) {
            throw new Error(`Invalid matchCount ${matchCount} for row ${enemyId}->${opponent}`);
          }

          // winCount must be in range [0, matchCount]
          if (!Number.isInteger(winCount) || winCount < 0 || winCount > matchCount) {
            throw new Error(`Invalid winCount ${winCount} for matchCount ${matchCount}, row ${enemyId}->${opponent}`);
          }

          // no duplicate matchup rows in one bucket
          const pairKey = `${enemyId}:${opponent}`;
          const pairSeen = bucketSeenPairs.get(b);
          if (pairSeen.has(pairKey)) {
            throw new Error(`Duplicate matchup row ${pairKey} in bucket ${b}`);
          }
          pairSeen.add(pairKey);

          // Process the row
          if (!totals.has(enemyId)) totals.set(enemyId, new Map());
          const rowMap = totals.get(enemyId);
          const wins = heroId1 === enemyId ? winCount : matchCount - winCount;
          const cur = rowMap.get(opponent) ?? { games: 0, wins: 0 };
          cur.games += weight * matchCount;
          cur.wins += weight * wins;
          rowMap.set(opponent, cur);
        }
      }
    }
  }
  const matchups = {};
  for (const [enemyId, rowMap] of totals) {
    matchups[String(enemyId)] = [...rowMap.entries()]
      .map(([opponent, v]) => {
        // Integers again after weighting; with all weights 1 this is exact.
        const games = Math.round(v.games);
        return { hero_id: opponent, games_played: games, wins: Math.min(games, Math.round(v.wins)) };
      })
      .sort((a, b) => b.games_played - a.games_played);
  }
  return matchups;
}

/**
 * Same-team ("with") tables from the same matchUp responses: `enemyId -> rows`
 * where each row is a teammate and `wins` = wins of the team with both heroes.
 * Weighted by the rolling-window bucket weights like the matchups.
 */
export function aggregateStratzSynergyChunks(chunks, windowInfo, validHeroIdsSet) {
  const totals = new Map();
  for (const { response } of chunks) {
    for (const b of windowInfo.buckets) {
      const weight = windowInfo.weights?.[b] ?? 1;
      for (const dryad of response.data?.heroStats?.[`w${b}`] ?? []) {
        const heroId = Number(dryad.heroId);
        for (const r of dryad.with ?? []) {
          const { heroId1, heroId2, matchCount, winCount } = r;
          if (heroId1 !== heroId && heroId2 !== heroId) {
            throw new Error(`Synergy orientation error: ${heroId} not in ${heroId1}/${heroId2}`);
          }
          const mate = heroId1 === heroId ? heroId2 : heroId1;
          if (mate === heroId || !validHeroIdsSet.has(mate)) throw new Error(`Invalid synergy teammate ${mate} for ${heroId}`);
          if (!Number.isInteger(matchCount) || matchCount < 0 || !Number.isInteger(winCount) || winCount < 0 || winCount > matchCount) {
            throw new Error(`Invalid synergy counts ${winCount}/${matchCount} for ${heroId}+${mate}`);
          }
          if (!totals.has(heroId)) totals.set(heroId, new Map());
          const m = totals.get(heroId);
          const cur = m.get(mate) ?? { games: 0, wins: 0 };
          cur.games += weight * matchCount;
          cur.wins += weight * winCount; // same team: heroId1's wins are the pair's wins
          m.set(mate, cur);
        }
      }
    }
  }
  const out = {};
  for (const [heroId, m] of totals) {
    out[String(heroId)] = [...m.entries()].map(([mate, v]) => {
      const games = Math.round(v.games);
      return { hero_id: mate, games_played: games, wins: Math.min(games, Math.round(v.wins)) };
    }).sort((a, b) => b.games_played - a.games_played);
  }
  return out;
}

/**
 * Average both directions of a same-team table (A with B / B with A). Same
 * reason as symmetrizeBracketTable: the bracket filter applies to one player,
 * and a synergy pair must have one answer. `wins` stays the team's wins.
 */
export function symmetrizeSynergyTable(table) {
  const out = {};
  for (const [hero, rows] of Object.entries(table)) {
    out[hero] = rows.map((r) => {
      const rev = table[String(r.hero_id)]?.find((x) => x.hero_id === Number(hero));
      if (!rev) throw new Error(`symmetrize synergy: missing reverse row ${r.hero_id}+${hero}`);
      const g = Math.round((r.games_played + rev.games_played) / 2);
      return { hero_id: r.hero_id, games_played: g, wins: Math.min(g, Math.round((r.wins + rev.wins) / 2)) };
    }).sort((a, b) => b.games_played - a.games_played);
  }
  return out;
}

/** Contract for a same-team table: full roster, sane counts, plausible team win rates. */
export function validateSynergyTable(heroes, table, { allowZeroGames = false, newHeroIds = [] } = {}) {
  const newHeroes = new Set(newHeroIds);
  const ids = heroes.map((h) => h.id);
  const idSet = new Set(ids);
  const problems = [];
  if (Object.keys(table).length !== ids.length) problems.push(`${Object.keys(table).length} tables for ${ids.length} heroes`);
  for (const id of ids) {
    const rows = table[String(id)];
    if (!Array.isArray(rows)) { problems.push(`no table for hero ${id}`); continue; }
    if (rows.length !== ids.length - 1) problems.push(`hero ${id} has ${rows.length} teammates`);
    let g = 0;
    let w = 0;
    const seen = new Set();
    for (const r of rows) {
      if (r.hero_id === id || !idSet.has(r.hero_id) || seen.has(r.hero_id)) problems.push(`bad teammate ${r.hero_id} for ${id}`);
      seen.add(r.hero_id);
      if (!Number.isInteger(r.games_played) || (allowZeroGames ? r.games_played < 0 : r.games_played <= 0)) problems.push(`games ${r.games_played} for ${id}+${r.hero_id}`);
      if (!Number.isInteger(r.wins) || r.wins < 0 || r.wins > r.games_played) problems.push(`wins ${r.wins} for ${id}+${r.hero_id}`);
      g += r.games_played;
      w += r.wins;
    }
    const wr = g > 0 ? (100 * w) / g : 50;
    if (!newHeroes.has(id) && (wr < 35 || wr > 65)) problems.push(`hero ${id} team win rate ${wr.toFixed(1)}% outside 35–65%`);
    if (problems.length > 20) break;
  }
  if (problems.length) throw new Error(`Synergy contract failed: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? ` (+${problems.length - 5} more)` : ''}`);
  return { heroes: ids.length };
}

export async function fetchMatchupsFromStratz(heroIds, windowInfo, { token, log = console.log, brackets = BRACKETS, includeSynergy = false } = {}) {
  if (!brackets.length || brackets.some((b) => !BRACKETS.includes(b))) throw new Error(`Invalid brackets: ${brackets}`);
  log(`    Querying STRATZ GraphQL in ${Math.ceil(heroIds.length / CHUNK_SIZE)} chunk requests (${brackets.length === BRACKETS.length ? 'all brackets' : brackets.join(', ')})…`);
  const transport = new StratzTransport(token);
  await transport.init();

  const chunks = [];
  for (let i = 0; i < heroIds.length; i += CHUNK_SIZE) {
    chunks.push(heroIds.slice(i, i + CHUNK_SIZE));
  }

  // Validate heroIds are valid
  const validHeroIds = new Set(heroIds.filter(id => Number.isInteger(id) && id > 0));

  // Collect responses first, then aggregate
  const chunkResponses = [];
  try {
    for (let ci = 0; ci < chunks.length; ci += 1) {
      const chunk = chunks[ci];
      const q = buildChunkQuery(chunk, windowInfo.buckets, brackets, { withSynergy: includeSynergy });
      const t0 = Date.now();
      const res = await transport.query(q);
      log(`    Chunk ${ci + 1}/${chunks.length} (${chunk.length} heroes) fetched in ${Date.now() - t0}ms`);

      chunkResponses.push({
        chunkIndex: ci,
        chunkHeroIds: chunk,
        response: res,
      });
    }
  } finally {
    await transport.close();
  }

  const chunksForAggregation = chunkResponses.map((cr) => ({
    chunkIndex: cr.chunkIndex,
    chunkHeroIds: cr.chunkHeroIds,
    response: cr.response,
  }));
  // Use the same aggregation logic for both production and tests
  const vs = aggregateStratzMatchupChunks(chunksForAggregation, windowInfo, validHeroIds);
  if (!includeSynergy) return vs;
  return { vs, with: aggregateStratzSynergyChunks(chunksForAggregation, windowInfo, validHeroIds) };
}

/** The only files a refresh publishes (ТЗ №77: Counterpick data only). */
export const PUBLISHED_FILES = Object.freeze([
  'heroes.json', 'matchups.json', 'positions.json', 'meta.json', 'matchups-by-bracket.json',
  'synergy.json', 'synergy-by-bracket.json',
]);

/** Rank brackets offered in the UI, each published as its own matchup table. */
export const BRACKET_LABELS = Object.freeze({
  HERALD_GUARDIAN: 'Herald–Guardian',
  CRUSADER_ARCHON: 'Crusader–Archon',
  LEGEND_ANCIENT: 'Legend–Ancient',
  DIVINE_IMMORTAL: 'Divine–Immortal',
});

/**
 * Per-bracket tables are directional. Within ONE bracket, STRATZ's A→B and B→A
 * rows differ a lot (median 3–6.5%, Herald up to 72% on the 2026-11-16 window),
 * i.e. the bracket filter applies to one player of the pair, not to the match;
 * the directions only (almost) agree once all brackets are summed. Each rank
 * table is therefore symmetrised: both directions are averaged, so a row
 * describes matches where either hero's player was in that bracket. Games
 * stay on the real scale (the mean, not the sum, of the two directions).
 * Rows keep the enemy-perspective convention: `wins` = wins of the table's key hero.
 */
export function symmetrizeBracketTable(table) {
  const out = {};
  for (const [enemy, rows] of Object.entries(table)) {
    out[enemy] = rows.map((r) => {
      const rev = table[String(r.hero_id)]?.find((x) => x.hero_id === Number(enemy));
      if (!rev) throw new Error(`symmetrize: missing reverse row ${r.hero_id}->${enemy}`);
      // wins of `enemy` against r.hero_id, seen from both directions
      const games = (r.games_played + rev.games_played) / 2;
      const enemyWins = (r.wins + (rev.games_played - rev.wins)) / 2;
      const g = Math.round(games);
      return { hero_id: r.hero_id, games_played: g, wins: Math.min(g, Math.max(0, Math.round(enemyWins))) };
    }).sort((a, b) => b.games_played - a.games_played);
  }
  return out;
}

/**
 * The all-ranks table is the sum of the per-bracket tables (raw, directional). STRATZ bracket
 * groups partition the multi-bracket aggregate exactly (verified in FIX12:
 * querying each group separately reproduces the combined matchCount/winCount in
 * 32/32 pair-weeks), so this equals the combined query while guaranteeing the
 * rank tables and the "All ranks" table describe the same matches.
 */
export function sumBracketTables(byBracket) {
  const totals = new Map();
  for (const tables of Object.values(byBracket)) {
    for (const [enemy, rows] of Object.entries(tables)) {
      if (!totals.has(enemy)) totals.set(enemy, new Map());
      const m = totals.get(enemy);
      for (const r of rows) {
        const cur = m.get(r.hero_id) ?? { games: 0, wins: 0 };
        cur.games += r.games_played;
        cur.wins += r.wins;
        m.set(r.hero_id, cur);
      }
    }
  }
  const out = {};
  for (const [enemy, m] of totals) {
    out[enemy] = [...m.entries()]
      .map(([hero_id, v]) => ({ hero_id, games_played: v.games, wins: v.wins }))
      .sort((a, b) => b.games_played - a.games_played);
  }
  return out;
}

/**
 * The whole refresh as a function: OpenDota metadata -> STRATZ matchups ->
 * STRATZ positions -> validation -> meta payloads. Writes nothing.
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
  now = new Date(),
  log = console.log,
} = {}) {
  // 1. Fresh OpenDota metadata. A throw here means nothing downstream runs.
  log('1/6 Fetching fresh hero metadata from OpenDota...');
  const { heroes, latestPatch, latestPatchDate = null } = await fetchMetadata();
  // Re-validated even though the loader already validates: the guard belongs to
  // the pipeline, not to one implementation of the loader, and a patch string
  // must never silently become ''.
  validateHeroMetadata(heroes, latestPatch);
  const heroIds = heroes.map((h) => h.id).sort((a, b) => a - b);
  log(`    OpenDota returned ${heroIds.length} heroes, latest patch ${latestPatch}`);

  // 2. Rolling window: the last ROLLING_DAYS days of the current patch,
  //    recomputed on every run (see getRollingWindow).
  if (!latestPatchDate) log(`    WARNING: OpenDota gave no release date for patch ${latestPatch}; the window is not cut at the patch`);
  const windowInfo = getRollingWindow(now, ROLLING_DAYS, { patchName: latestPatch, patchReleasedUtc: latestPatchDate });
  log(
    `2/6 Rolling ${windowInfo.days}-day window over weekly buckets: ` +
      windowInfo.buckets.map((b) => `${b}×${windowInfo.weights[b]}`).join(', ') +
      ` (current week ${windowInfo.currentBucket} taken live)`,
  );
  log(`    Window: ${windowInfo.windowStartUtc} -> ${windowInfo.windowEndUtc} (${windowInfo.effectiveDays} effective days)`);
  log(`    Patch ${latestPatch} released ${windowInfo.patch.releasedUtc ?? 'unknown'}: ${windowInfo.patch.mode}`);

  // 3+4. STRATZ, queried for exactly the fresh hero ids. Matchups and position
  // stats are two independent queries over the SAME buckets, so the two layers
  // can never describe different weeks (§6). A failure in either aborts the
  // whole run; nothing is published partially.
  log('3/6 Fetching STRATZ matchups...');
  // One table per rank bracket (for the rank selector); "All ranks" is their
  // sum. Positions stay all-bracket: the eligibility gate needs >= 500 games
  // per lane, which a single bracket does not give for rarer heroes, and a
  // hero's lanes barely change by rank.
  const rawByBracket = {};
  const rawSynergyByBracket = {};
  for (const bracket of BRACKETS) {
    const res = await fetchMatchups(heroIds, windowInfo, { log, brackets: [bracket], includeSynergy: true });
    // A fetcher may return just the matchup table (tests, older callers) or
    // { vs, with } when it also collected the same-team tables.
    const hasSynergy = res && typeof res === 'object' && 'vs' in res && 'with' in res;
    rawByBracket[bracket] = fillMissingPairs(heroes, hasSynergy ? res.vs : res);
    if (hasSynergy) rawSynergyByBracket[bracket] = fillMissingPairs(heroes, res.with);
  }
  const matchups = sumBracketTables(rawByBracket);
  const synergyComplete = BRACKETS.every((b) => rawSynergyByBracket[b]);
  log('4/6 Fetching STRATZ positions...');
  const positions = await fetchPositions(heroIds, windowInfo, { log });

  // 5. Strict 13-point data contract validation, against the FRESH roster.
  log('5/6 Validating dataset integrity contract...');
  const validationResult = validateProductionContract(heroes, matchups);
  log(`    Validation passed! Total rows: ${validationResult.totalPairs}`);
  const newHeroIds = validationResult.newHeroes;
  for (const id of newHeroIds) {
    const h = heroes.find((x) => x.id === id);
    log(`    WARNING: new hero ${id} (${h?.name ?? '?'}) has little data yet — published with 0-game pairs as "no data"`);
  }
  for (const f of validationResult.asymmetricFaces) {
    log(`    WARNING: reverse-pair games asymmetry ${f.enemyId}->${f.heroId}: ${f.games} vs ${f.reverseGames} (known STRATZ behaviour, within budget)`);
  }
  log(`    Reverse pair asymmetry median: ${validationResult.reversePairAsymmetry.medianPct}% (p99: ${validationResult.reversePairAsymmetry.p99Pct}%, max: ${validationResult.reversePairAsymmetry.maxPct}%)`);
  log(`    Wins sum skew median: ${validationResult.winsSumSkew.medianPct}% (p99: ${validationResult.winsSumSkew.p99Pct}%, max: ${validationResult.winsSumSkew.maxPct}%)`);
  // Rank tables: symmetrised only after the raw all-ranks table passed the
  // contract (roster, completeness, ranges), then validated in full.
  const matchupsByBracket = Object.fromEntries(
    BRACKETS.map((bracket) => [bracket, symmetrizeBracketTable(rawByBracket[bracket])]),
  );
  const bracketQuality = {};
  for (const bracket of BRACKETS) {
    try {
      const v = validateProductionContract(heroes, matchupsByBracket[bracket], { allowZeroGames: true });
      bracketQuality[bracket] = { reversePairAsymmetry: v.reversePairAsymmetry, winsSumSkew: v.winsSumSkew, asymmetricFaces: v.asymmetricFaces.length };
      log(`    Bracket ${bracket} passed (${v.asymmetricFaces.length} known-asymmetry faces)`);
    } catch (e) {
      throw new Error(`Bracket ${bracket}: ${e.message}`, { cause: e });
    }
  }
  // Same-team tables (allies / synergy, ban suggestions). Optional layer: a
  // fetcher without them publishes the counterpick data alone.
  let synergy = null;
  let synergyByBracket = null;
  if (synergyComplete) {
    synergy = symmetrizeSynergyTable(sumBracketTables(rawSynergyByBracket));
    // zero-game pairs allowed: right after a patch a rare pair may not have met yet
    validateSynergyTable(heroes, synergy, { allowZeroGames: true, newHeroIds });
    synergyByBracket = {};
    for (const bracket of BRACKETS) {
      synergyByBracket[bracket] = symmetrizeSynergyTable(rawSynergyByBracket[bracket]);
      try {
        validateSynergyTable(heroes, synergyByBracket[bracket], { allowZeroGames: true, newHeroIds });
      } catch (e) {
        throw new Error(`Bracket ${bracket}: ${e.message}`, { cause: e });
      }
    }
    log(`    Synergy tables passed (all ranks + ${BRACKETS.length} brackets)`);
  } else {
    log('    WARNING: no same-team data from the fetcher — publishing without synergy');
  }
  // A new hero may have no lane stats yet: an all-zero entry keeps the roster
  // complete and makes it ineligible for every lane until it is really played.
  for (const id of newHeroIds) {
    if (!positions[String(id)]) {
      positions[String(id)] = {
        totalGames: 0,
        positions: Object.fromEntries(['1', '2', '3', '4', '5'].map((n) => [n, { games: 0, share: 0 }])),
      };
    }
  }
  const positionInfo = validatePositionData(positions, { heroes, windowInfo, newHeroIds });
  log(`    Position data passed! ${positionInfo.heroCount} heroes across buckets [${positionInfo.buckets.join(', ')}]`);

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
      kind: 'rolling-days',
      days: windowInfo.days,
      windowStartUtc: windowInfo.windowStartUtc,
      windowEndUtc: windowInfo.windowEndUtc,
      weeklyBuckets: windowInfo.buckets,
      bucketWeights: windowInfo.weights,
      currentBucket: windowInfo.currentBucket,
      effectiveDays: windowInfo.effectiveDays,
      patch: windowInfo.patch,
      method:
        'Last 30 days, never before the current patch release (a patch younger than 7 days is filled up to 7 days ' +
        'with pre-patch days at weight 0.25). STRATZ publishes matchups only per weekly bucket, so each week is ' +
        'weighted by the share of its covered time that falls inside the window.',
    },
    population: {
      type: 'rank-bracket',
      description: 'Rank-bracket data (calibrated ranks: Herald through Immortal)',
      brackets: BRACKETS,
    },
    matchupPatchFilter: false,
    synergy: synergy
      ? {
          files: ['synergy.json', 'synergy-by-bracket.json'],
          perspective: 'wins = wins of the team with both heroes (same-team "with" rows, both directions averaged)',
        }
      : null,
    brackets: {
      file: 'matchups-by-bracket.json',
      ids: BRACKETS,
      labels: BRACKET_LABELS,
      allRanks: 'matchups.json = sum of the raw bracket tables (= the combined all-bracket query)',
      perBracket:
        'STRATZ applies the bracket to one player of a pair, so A→B and B→A differ within a bracket; ' +
        'each bracket table averages both directions (matches where either hero was played in that bracket).',
      positions: 'all brackets (positions.json)',
    },
    positionData: {
      source: 'STRATZ',
      days: windowInfo.days,
      weeklyBuckets: windowInfo.buckets,
      bucketWeights: windowInfo.weights,
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
      brackets: bracketQuality,
    },
  };

  return { heroes, matchups, matchupsByBracket, synergy, synergyByBracket, positions, meta, validationResult, positionInfo };
}

/** The atomic publish payload: exactly PUBLISHED_FILES, nothing else. */
export function buildPublishPayload({ heroes, matchups, positions, meta, matchupsByBracket, synergy = null, synergyByBracket = null }) {
  const payload = {
    'heroes.json': heroes,
    'matchups.json': matchups,
    'positions.json': positions,
    'meta.json': meta,
    'matchups-by-bracket.json': matchupsByBracket,
  };
  // Synergy is an optional layer: both files or neither.
  if (synergy && synergyByBracket) {
    payload['synergy.json'] = synergy;
    payload['synergy-by-bracket.json'] = synergyByBracket;
  }
  for (const [name, value] of Object.entries(payload)) {
    if (value === undefined || value === null) throw new Error(`Refusing to publish: ${name} is missing`);
  }
  return payload;
}

async function main() {
  console.log('--- Production Dataset Generator (STRATZ matchups + OpenDota metadata) ---');
  const token = loadToken();

  // 1-5: fetch fresh metadata, query STRATZ, validate. Any throw aborts the run
  // before a single byte of the live dataset is touched.
  const result = await buildDataset({
    fetchMatchups: (heroIds, windowInfo, opts) =>
      fetchMatchupsFromStratz(heroIds, windowInfo, { ...opts, token }),
    fetchPositions: (heroIds, windowInfo, opts) =>
      fetchPositionsFromStratz(heroIds, windowInfo, { ...opts, token }),
  });
  const { heroes, meta } = result;

  // 6. Publish every layer as ONE directory swap — positions cannot lag behind
  // the heroes they are keyed by.
  console.log(`6/6 Publishing dataset atomically (${PUBLISHED_FILES.join(', ')})...`);
  const sizes = await publishDatasetAtomically(
    DATA_DIR,
    buildPublishPayload(result),
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

