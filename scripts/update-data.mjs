#!/usr/bin/env node
/**
 * Data refresh: OpenDota → public/data/{heroes,matchups,meta}.json
 * Run:  node scripts/update-data.mjs
 * Rules: limited concurrency, retries with exponential backoff, validate
 * everything before touching the dataset; on failure old data stays untouched.
 * No deps: global fetch (Node 18+).
 */
import { writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

const API = 'https://api.opendota.com/api';
const CDN = 'https://cdn.cloudflare.steamstatic.com';
const OUT = path.resolve(process.cwd(), 'public', 'data');
const CONCURRENCY = 3;
const RETRIES = 6;
const BASE_BACKOFF_MS = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} for ${url}`);
      } else if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      } else {
        return await res.json();
      }
    } catch (e) {
      lastErr = e;
    }
    const wait = BASE_BACKOFF_MS * 2 ** (attempt - 1);
    console.warn(`  retry ${attempt}/${RETRIES} after ${Math.round(wait / 1000)}s (${lastErr?.message ?? 'error'})`);
    await sleep(wait);
  }
  throw lastErr;
}

/** Fixed-size worker pool with limited concurrency. */
async function pooled(items, worker) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) await worker(queue.shift());
  });
  await Promise.all(workers);
}

function normalizeHero(h, statsById) {
  const s = statsById.get(h.id) ?? {};
  return {
    id: h.id,
    name: h.localized_name,
    primaryAttr: h.primary_attr,
    attackType: h.attack_type,
    roles: Array.isArray(h.roles) ? h.roles : [],
    img: typeof s.img === 'string' ? `${CDN}${s.img}` : '',
    icon: typeof s.icon === 'string' ? `${CDN}${s.icon}` : '',
    proPick: typeof s.pro_pick === 'number' ? s.pro_pick : 0,
    proWin: typeof s.pro_win === 'number' ? s.pro_win : 0,
    pubPick: typeof s.pub_pick === 'number' ? s.pub_pick : 0,
    pubWin: typeof s.pub_win === 'number' ? s.pub_win : 0,
  };
}

/** Validate the full snapshot; throws on any integrity problem. */
function validateSnapshot(heroes, matchups, meta) {
  if (!Array.isArray(heroes) || heroes.length < 100) throw new Error(`hero count too small: ${heroes.length}`);
  const ids = new Set();
  for (const h of heroes) {
    if (!Number.isInteger(h.id) || h.id <= 0) throw new Error(`invalid hero id: ${h.id}`);
    if (typeof h.name !== 'string' || h.name.length === 0) throw new Error(`invalid name for hero ${h.id}`);
    if (!Array.isArray(h.roles)) throw new Error(`invalid roles for hero ${h.id}`);
    if (ids.has(h.id)) throw new Error(`duplicate hero id ${h.id}`);
    ids.add(h.id);
  }
  const enemyIds = Object.keys(matchups);
  if (enemyIds.length < 100) throw new Error(`matchup tables too few: ${enemyIds.length}`);
  let totalRows = 0;
  for (const [enemyId, rows] of Object.entries(matchups)) {
    if (!ids.has(Number(enemyId))) throw new Error(`matchup table for unknown hero ${enemyId}`);
    if (!Array.isArray(rows)) throw new Error(`matchup rows not an array for ${enemyId}`);
    for (const r of rows) {
      totalRows += 1;
      if (!Number.isInteger(r.hero_id) || !ids.has(r.hero_id)) throw new Error(`unknown hero_id in table ${enemyId}`);
      if (!Number.isFinite(r.games_played) || r.games_played < 0) throw new Error(`bad games in table ${enemyId}`);
      if (!Number.isFinite(r.wins) || r.wins < 0 || r.wins > r.games_played) throw new Error(`bad wins in table ${enemyId} row ${r.hero_id}`);
    }
  }
  if (totalRows < 10000) throw new Error(`too few matchup rows: ${totalRows}`);
  if (!meta.latestPatch || typeof meta.latestPatch !== 'string') throw new Error('missing latestPatch in meta');
  return { totalRows };
}

async function main() {
  console.log('1/5 Fetching hero list + stats + patch…');
  const [list, stats, patches] = await Promise.all([
    fetchJson(`${API}/heroes`),
    fetchJson(`${API}/heroStats`),
    fetchJson(`${API}/constants/patch`),
  ]);
  const statsById = new Map(stats.map((s) => [s.id, s]));
  const heroes = list.map((h) => normalizeHero(h, statsById));
  const patchList = Object.values(patches).sort((a, b) => b.id - a.id);
  const latestPatch = patchList[0]?.name ?? '';

  console.log(`2/5 Fetching ${heroes.length} matchup tables (concurrency ${CONCURRENCY})…`);
  const matchups = {};
  let done = 0;
  let failed = 0;
  await pooled(heroes, async (hero) => {
    try {
      matchups[hero.id] = await fetchJson(`${API}/heroes/${hero.id}/matchups`);
    } catch (e) {
      failed += 1;
      console.error(`  FAILED ${hero.name} (#${hero.id}): ${e.message}`);
    }
    done += 1;
    if (done % 20 === 0) console.log(`  ${done}/${heroes.length}`);
  });
  if (failed > 0) throw new Error(`${failed} matchup tables failed to load — dataset NOT updated`);
  for (const h of heroes) {
    if (!Array.isArray(matchups[h.id])) throw new Error(`missing matchup table for hero ${h.id}`);
  }

  const meta = { source: 'OpenDota', generatedAt: new Date().toISOString(), latestPatch, heroCount: heroes.length };
  console.log('3/5 Validating snapshot…');
  const { totalRows } = validateSnapshot(heroes, matchups, meta);
  console.log(`  ok: ${heroes.length} heroes, ${totalRows} matchup rows, patch ${latestPatch}`);

  console.log('4/5 Writing dataset (atomic per file)…');
  await mkdir(OUT, { recursive: true });
  for (const [name, data] of [['heroes.json', heroes], ['matchups.json', matchups], ['meta.json', meta]]) {
    const tmp = path.join(OUT, `.${name}.tmp`);
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, path.join(OUT, name));
  }
  console.log('5/5 Dataset updated.');
}

main().catch((e) => {
  console.error('UPDATE FAILED — existing dataset left untouched.', e);
  process.exit(1);
});