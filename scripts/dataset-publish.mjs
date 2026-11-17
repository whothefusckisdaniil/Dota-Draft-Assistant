#!/usr/bin/env node
/**
 * Atomic whole-dataset publication.
 *
 * Why this exists: writing `heroes.json`, `matchups.json`, `positions.json` and `meta.json` one
 * rename at a time can leave a mixed snapshot on disk — e.g. new `heroes.json`
 * (128 heroes, hero `X` added) next to old `matchups.json` (127 tables). Every
 * cross-file invariant in the app then silently breaks, and the state is only
 * discoverable by hand. A crash between renames has the same effect.
 *
 * The fix is a directory swap on a single filesystem:
 *
 *   public/data.__next/   fully written + re-validated
 *   public/data.__prev/   the outgoing snapshot (moved aside, then deleted)
 *   public/data/          live
 *
 * `rename()` of a directory is atomic, and moving the old tree aside before
 * moving the new one in makes the visible window a single rename. If the second
 * rename fails, the old tree is moved straight back.
 *
 * Both temporary siblings are dot-prefixed so a half-finished run is obvious
 * and never picked up by a static host or `git add public/data`.
 */
import { mkdir, rename, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const NEXT_SUFFIX = 'data.__next';
export const PREV_SUFFIX = 'data.__prev';

/**
 * Every file a complete dataset must contain — and the only files it may
 * contain. The Counterpick dataset has no item layers (ТЗ №77).
 */
export const DATASET_FILES = [
  'heroes.json',
  'matchups.json',
  'positions.json',
  'meta.json',
];

/**
 * Layers a dataset MAY contain. Per-rank matchup tables come from STRATZ only;
 * the OpenDota fallback has no rank split and publishes without them (the UI
 * then hides the rank selector).
 */
export const OPTIONAL_DATASET_FILES = ['matchups-by-bracket.json', 'synergy.json', 'synergy-by-bracket.json', 'role-stats.json'];
const ALLOWED_FILES = [...DATASET_FILES, ...OPTIONAL_DATASET_FILES];

/**
 * Re-read the staged files and prove they are complete, parseable and
 * cross-consistent. Writing without this step would mean trusting that the
 * in-memory objects match what actually landed on disk.
 */
export async function verifyStagedDataset(stagedDir, { heroCount, requireCompleteTables = false } = {}) {
  const present = new Set(await readdir(stagedDir));
  const missing = DATASET_FILES.filter((f) => !present.has(f));
  if (missing.length > 0) throw new Error(`staged dataset missing files: ${missing.join(', ')}`);
  const unexpected = [...present].filter((f) => !ALLOWED_FILES.includes(f)).sort();
  if (unexpected.length > 0) throw new Error(`staged dataset contains unexpected files: ${unexpected.join(', ')}`);

  // Read by NAME, not by position in DATASET_FILES. The positional form broke
  // the moment a fourth file was added: `metaRaw` silently became
  // positions.json, so the meta.heroCount cross-check read `undefined` and the
  // guard fired on a perfectly good dataset. A dataset layer added later must
  // never be able to displace another one here.
  const raw = Object.fromEntries(
    await Promise.all(
      DATASET_FILES.map(async (f) => [f, await readFile(path.join(stagedDir, f), 'utf8')]),
    ),
  );
  let heroes, matchups, positions, meta;
  try {
    ({ heroes, matchups, positions, meta } = {
      heroes: JSON.parse(raw['heroes.json']),
      matchups: JSON.parse(raw['matchups.json']),
      positions: JSON.parse(raw['positions.json']),
      meta: JSON.parse(raw['meta.json']),
    });
  } catch (e) {
    throw new Error(`staged dataset contains invalid JSON: ${e.message}`);
  }

  if (!Array.isArray(heroes) || heroes.length === 0) throw new Error('staged heroes.json is not a non-empty array');
  if (!matchups || typeof matchups !== 'object' || Array.isArray(matchups)) {
    throw new Error('staged matchups.json is not an object');
  }
  if (!positions || typeof positions !== 'object' || Array.isArray(positions)) {
    throw new Error('staged positions.json is not an object');
  }
  if (!meta || typeof meta !== 'object') throw new Error('staged meta.json is not an object');

  // The invariant the mixed-snapshot bug destroys: one snapshot, one hero set.
  const ids = new Set(heroes.map((h) => h.id));
  if (ids.size !== heroes.length) {
    throw new Error(`staged heroes.json contains duplicate ids (${heroes.length} entries, ${ids.size} unique)`);
  }
  const tableIds = Object.keys(matchups).map(Number);
  if (tableIds.length !== heroes.length) {
    throw new Error(
      `staged hero/matchup count mismatch: ${heroes.length} heroes vs ${tableIds.length} matchup tables`,
    );
  }
  for (const id of tableIds) {
    if (!ids.has(id)) throw new Error(`staged matchups.json has a table for unknown hero ${id}`);
    const rows = matchups[String(id)];
    if (!Array.isArray(rows)) throw new Error(`staged table ${id} is not an array`);
    // Completeness is opt-in. STRATZ guarantees a full N-1 matrix and that is
    // exactly what `validateProductionContract` enforces, so demanding it here
    // would be redundant. OpenDota genuinely ships gaps (its /matchups tables
    // omit opponents it has no data for), and the OpenDota fallback must stay
    // usable as a rollback path — so a missing pair is allowed there.
    if (requireCompleteTables && rows.length !== heroes.length - 1) {
      throw new Error(
        `staged table ${id} has ${rows.length} rows, expected ${heroes.length - 1}`,
      );
    }
  }
  // Checked against the roster that actually landed on disk — comparing
  // meta.heroCount to itself would accept any value whatsoever.
  if (meta.heroCount !== heroes.length) {
    throw new Error(`staged meta.heroCount=${meta.heroCount} does not match the ${heroes.length} heroes written`);
  }
  // Same invariant for the position layer: one entry per hero, same roster.
  // §6 — positions must never describe a different snapshot than matchups.
  const positionIds = Object.keys(positions).map(Number);
  if (positionIds.length !== heroes.length) {
    throw new Error(
      `staged hero/position count mismatch: ${heroes.length} heroes vs ${positionIds.length} position entries`,
    );
  }
  for (const id of positionIds) {
    if (!ids.has(id)) throw new Error(`staged positions.json has an entry for unknown hero ${id}`);
  }
  // Optional layers: same roster, one table per hero (per bracket for the
  // *-by-bracket files). Synergy comes as a pair or not at all.
  const readOptional = async (name) => {
    try {
      return JSON.parse(await readFile(path.join(stagedDir, name), 'utf8'));
    } catch (e) {
      throw new Error(`staged ${name} is invalid JSON: ${e.message}`);
    }
  };
  const checkTables = (label, tables) => {
    const tableIds = Object.keys(tables ?? {}).map(Number);
    if (tableIds.length !== heroes.length || tableIds.some((id) => !ids.has(id))) {
      throw new Error(`staged ${label} does not cover exactly the ${heroes.length} heroes`);
    }
    for (const id of tableIds) {
      const rows = tables[String(id)];
      if (!Array.isArray(rows)) throw new Error(`staged ${label} table ${id} is not an array`);
      if (requireCompleteTables && rows.length !== heroes.length - 1) {
        throw new Error(`staged ${label} table ${id} has ${rows.length} rows, expected ${heroes.length - 1}`);
      }
    }
  };
  const checkByBracket = (name, byBracket) => {
    if (!byBracket || typeof byBracket !== 'object' || Array.isArray(byBracket) || Object.keys(byBracket).length === 0) {
      throw new Error(`staged ${name} is not a non-empty object`);
    }
    for (const [bracket, tables] of Object.entries(byBracket)) checkTables(`bracket ${bracket} (${name})`, tables);
  };
  if (present.has('matchups-by-bracket.json')) checkByBracket('matchups-by-bracket.json', await readOptional('matchups-by-bracket.json'));
  if (present.has('synergy.json') !== present.has('synergy-by-bracket.json')) {
    throw new Error('staged dataset must contain both synergy.json and synergy-by-bracket.json, or neither');
  }
  if (present.has('synergy.json')) {
    checkTables('synergy.json', await readOptional('synergy.json'));
    checkByBracket('synergy-by-bracket.json', await readOptional('synergy-by-bracket.json'));
  }
  // Per-position win rates: every rank table covers exactly the roster.
  if (present.has('role-stats.json')) {
    const roleStats = await readOptional('role-stats.json');
    if (!roleStats || typeof roleStats !== 'object' || !roleStats.ALL) throw new Error('staged role-stats.json has no ALL table');
    for (const [bracket, table] of Object.entries(roleStats)) {
      const tableIds = Object.keys(table ?? {}).map(Number);
      if (tableIds.length !== heroes.length || tableIds.some((id) => !ids.has(id))) {
        throw new Error(`staged role-stats.json ${bracket} does not cover exactly the ${heroes.length} heroes`);
      }
    }
  }
  // Optional external expectation (the caller's in-memory count), when given.
  if (heroCount !== undefined && meta.heroCount !== heroCount) {
    throw new Error(`staged meta.heroCount=${meta.heroCount} does not match the expected ${heroCount}`);
  }
  return { heroes, matchups, meta };
}

/**
 * Write the full dataset to a staging directory, verify it, then swap it in.
 *
 * On any failure the previous `dataDir` is left exactly as it was — byte for
 * byte — and both temporary directories are cleaned up.
 *
 * @param {string} dataDir  live dataset directory, e.g. `<root>/public/data`
 * @param {Record<string, unknown>} files  filename -> JSON-serialisable payload
 * @param {{requireCompleteTables?: boolean}} [opts]  enforce an N-1 matrix per table
 */
export async function publishDatasetAtomically(dataDir, files, { requireCompleteTables = false } = {}) {
  const parent = path.dirname(dataDir);
  const staged = path.join(parent, NEXT_SUFFIX);
  const backup = path.join(parent, PREV_SUFFIX);

  for (const name of DATASET_FILES) {
    if (!(name in files)) throw new Error(`publishDatasetAtomically: missing payload for ${name}`);
  }
  // Only the Counterpick dataset files may be published — a stray layer (e.g. a
  // retired item file) is a caller bug, not something to ship.
  const extra = Object.keys(files).filter((name) => !ALLOWED_FILES.includes(name)).sort();
  if (extra.length > 0) throw new Error(`publishDatasetAtomically: unexpected payload ${extra.join(', ')}`);

  // Start from a clean slate. `data.__next` is only ever a half-written staging
  // area, so discarding it is always safe.
  await rm(staged, { recursive: true, force: true });

  // `data.__prev` is NOT scratch space. It is the only surviving copy of the
  // last good dataset when a previous swap failed mid-way (see the CRITICAL
  // branch below). Silently deleting it here — as this function used to do —
  // meant the *next* run destroyed the recovery copy that the previous run had
  // just failed to put back, turning a recoverable incident into total data
  // loss. So: refuse to run, and let a human decide.
  if (existsSync(backup)) {
    throw new Error(
      `Recovery snapshot already exists at:\n  ${backup}\n\n` +
        `Refusing to delete or overwrite it automatically.\n` +
        `It is the last good dataset, and the publisher cannot know whether it is the\n` +
        `right thing to restore. Restore it first, then re-run:\n\n  mv ${backup} ${dataDir}`,
    );
  }

  const sizes = {};
  try {
    await mkdir(staged, { recursive: true });
    for (const [name, data] of Object.entries(files)) {
      const body = JSON.stringify(data);
      await writeFile(path.join(staged, name), body);
      sizes[name] = Buffer.byteLength(body);
    }

    // Verify what is actually on disk before it becomes the live dataset.
    await verifyStagedDataset(staged, {
      heroCount: files['meta.json']?.heroCount,
      requireCompleteTables,
    });

    await mkdir(parent, { recursive: true });
    let movedAside = false;
    try {
      await rename(dataDir, backup);
      movedAside = true;
    } catch (e) {
      // No previous dataset (first ever run) — nothing to preserve.
      if (e.code !== 'ENOENT') throw e;
    }

    try {
      await rename(staged, dataDir);
    } catch (e) {
      if (movedAside) {
        // Put the old dataset back; the new one never becomes visible.
        await rename(backup, dataDir).catch((restoreErr) => {
          // The live tree is gone AND moving it back failed. `backup` now holds
          // the only surviving copy of the last good dataset, so it must be left
          // on disk and named in the error — never swept up by the outer catch.
          throw new Error(
            `CRITICAL: dataset swap failed (${e.message}) and the previous dataset could not be ` +
              `restored (${restoreErr.message}). The last good snapshot is preserved at ${backup}. ` +
              `Move it back manually: mv ${backup} ${dataDir}`,
            { cause: e },
          );
        });
      }
      throw new Error(`dataset swap failed, previous dataset restored: ${e.message}`, { cause: e });
    }
  } catch (e) {
    // Only the staging directory is swept. `backup` is deliberately left alone:
    // if the restore above failed it is the only surviving copy of the dataset,
    // and the error message tells the operator exactly where it is.
    await rm(staged, { recursive: true, force: true }).catch(() => {});
    throw e;
  }

  // Success: the outgoing snapshot is no longer needed.
  await rm(backup, { recursive: true, force: true }).catch(() => {});
  return sizes;
}
