#!/usr/bin/env node
/**
 * OpenDota-only data refresh — the rollback path for the STRATZ pipeline.
 * Run:  npm run update:data:opendota-fallback
 *
 * Hero metadata comes from the shared loader (`scripts/opendota/metadata.mjs`),
 * the same one the production generator uses, so a rollback produces the exact
 * same `heroes.json` shape. The three files are published as one directory swap
 * via `scripts/dataset-publish.mjs`.
 */
import path from 'node:path';
import { fetchJson, fetchOpenDotaMetadata, OPEN_DOTA_API } from './opendota/metadata.mjs';
import { publishDatasetAtomically } from './dataset-publish.mjs';

const OUT = path.resolve(process.cwd(), 'public', 'data');
const CONCURRENCY = 3;

/** Fixed-size worker pool with limited concurrency. */
async function pooled(items, worker) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) await worker(queue.shift());
  });
  await Promise.all(workers);
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
  const { heroes, latestPatch } = await fetchOpenDotaMetadata();

  console.log(`2/5 Fetching ${heroes.length} matchup tables (concurrency ${CONCURRENCY})…`);
  const matchups = {};
  let done = 0;
  let failed = 0;
  await pooled(heroes, async (hero) => {
    try {
      matchups[hero.id] = await fetchJson(`${OPEN_DOTA_API}/heroes/${hero.id}/matchups`);
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

  console.log('4/5 Publishing dataset atomically…');
  const sizes = await publishDatasetAtomically(OUT, {
    'heroes.json': heroes,
    'matchups.json': matchups,
    'meta.json': meta,
  });
  for (const [name, bytes] of Object.entries(sizes)) console.log(`  ${name} — ${bytes} bytes`);
  console.log('5/5 Dataset updated.');
}

main().catch((e) => {
  console.error('UPDATE FAILED — existing dataset left untouched.', e);
  process.exit(1);
});