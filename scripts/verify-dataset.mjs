#!/usr/bin/env node
/**
 * Standalone check that `public/data` is a single self-consistent snapshot.
 *
 * Used as a CI gate after the generator runs, and usable by hand at any time.
 * It re-reads the files from disk and applies the same cross-file invariants the
 * publisher checks, so a mixed snapshot (new heroes + old matchups) is caught
 * even if it somehow reached the working tree.
 *
 * Usage:  node scripts/verify-dataset.mjs [dir]     (default: public/data)
 * Exit:   0 = consistent, 1 = inconsistent
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyStagedDataset, DATASET_FILES } from './dataset-publish.mjs';
import { validateProductionContract } from './update-data-stratz.mjs';

const target = path.resolve(process.argv[2] ?? path.join(process.cwd(), 'public', 'data'));

async function main() {
  const { heroes, matchups, meta } = await verifyStagedDataset(target);
  console.log(`✓ ${DATASET_FILES.join(', ')} present and mutually consistent`);
  console.log(`  source=${meta.source}  heroMetadataSource=${meta.heroMetadataSource}  patch=${meta.latestPatch}`);
  console.log(`  heroes=${heroes.length}  tables=${Object.keys(matchups).length}`);

  // The full 13-gate STRATZ contract, applied to what is actually on disk.
  if (meta.source === 'STRATZ') {
    const res = validateProductionContract(heroes, matchups);
    console.log(`✓ STRATZ data contract passed (${res.totalPairs} pair rows)`);
  } else {
    console.log(`  (source=${meta.source}: STRATZ contract not applicable)`);
  }
}

main().catch((e) => {
  console.error(`✗ dataset verification failed: ${e.message}`);
  process.exit(1);
});
