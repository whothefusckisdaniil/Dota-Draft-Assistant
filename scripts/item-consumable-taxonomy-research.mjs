#!/usr/bin/env node
/**
 * ТЗ №40 — offline-capable research against pinned Valve item metadata.
 *
 *   node scripts/item-consumable-taxonomy-research.mjs [path/to/items.txt]
 *
 * If no path is supplied, downloads the public, pinned SteamDatabase mirror
 * snapshot. No API token, credentials, production data, or name-based rules.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditConsumableTaxonomy,
  parseValveItems,
} from './item-consumable-taxonomy-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_COMMIT = '3f630cc18bfa63f63b3ce259be52209d922558c3';
const SOURCE_URL =
  `https://raw.githubusercontent.com/SteamTracking/GameTracking-Dota2/${SOURCE_COMMIT}` +
  '/game/dota/pak01_dir/scripts/npc/items.txt';
const CATALOGUE_PATH = path.join(ROOT, 'public/data/items.json');

async function loadSource() {
  const inputPath = process.argv[2];
  if (inputPath) return readFile(path.resolve(inputPath), 'utf8');
  const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Valve item source request failed: HTTP ${response.status}`);
  }
  return response.text();
}

function sortedEntries(record) {
  return Object.entries(record).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

function main() {
  return Promise.all([
    loadSource(),
    readFile(CATALOGUE_PATH, 'utf8').then((text) => JSON.parse(text)),
  ]).then(([sourceText, catalogue]) => {
    const valveEntries = parseValveItems(sourceText);
    const report = auditConsumableTaxonomy(catalogue, valveEntries);
    const verdict = report.supportsExhaustiveBinaryTaxonomy
      ? 'ITEM_CONSUMABLE_TAXONOMY_FOUND'
      : 'ITEM_CONSUMABLE_TAXONOMY_NOT_IDENTIFIABLE';

    console.log('# TZ No.40 — Consumable / Permanent Item Taxonomy Research');
    console.log('');
    console.log(`Source: SteamDatabase/GameTracking-Dota2 @ ${SOURCE_COMMIT}`);
    console.log(`File: game/dota/pak01_dir/scripts/npc/items.txt`);
    console.log('Join: exact canonical item key only; no aliases or name-based classification.');
    console.log('');
    console.log('## Coverage');
    console.log('');
    console.log(`- Shipped catalogue items: ${report.totals.catalogueItems}`);
    console.log(`- Valve item records parsed: ${report.totals.sourceEntries}`);
    console.log(`- Exact source-key matches: ${report.totals.exactSourceMatches}`);
    console.log(`- No exact source match: ${report.totals.sourceMissing}`);
    console.log(`- ItemQuality present: ${report.totals.qualityKnown}`);
    console.log(`- ItemQuality absent: ${report.totals.qualityUnknown}`);
    console.log(`- ItemPermanent: true ${report.permanentCounts.true}, false ${report.permanentCounts.false}, unknown ${report.permanentCounts.unknown}`);
    console.log(`- ItemPurchasable known: ${report.fieldsCoverage.purchasableKnown}`);
    console.log(`- ItemInitialCharges known: ${report.fieldsCoverage.initialChargesKnown}`);
    console.log(`- ItemStackable known: ${report.fieldsCoverage.stackabilityKnown}`);
    console.log('');
    console.log('## Source field distributions');
    console.log('');
    for (const [quality, count] of sortedEntries(report.qualityCounts)) {
      console.log(`- ItemQuality ${quality}: ${count}`);
    }
    console.log('');
    console.log('## False-positive / ambiguity audit');
    console.log('');
    console.log(`- Exact ItemQuality consumable tag (including exact semicolon token): ${report.qualityConsumableCount}`);
    console.log(`- Tagged consumable and ItemPermanent=true conflict: ${report.qualityConsumablePermanentCrossTab.permanent}`);
    console.log(`- Tagged consumable and ItemPermanent=false: ${report.qualityConsumablePermanentCrossTab.nonPermanent}`);
    console.log(`- Tagged consumable and ItemPermanent absent: ${report.qualityConsumablePermanentCrossTab.unknown}`);
    console.log(`- Catalogue rows left unclassified by the two fields: ${report.classificationCounts.unknown}`);
    console.log(`- Contradictory source labels: ${report.classificationCounts.conflict}`);
    console.log('');
    console.log('Tagged rows (IDs/keys are diagnostic output only):');
    for (const row of report.consumableRows) {
      console.log(`- ${row.itemId} ${row.canonicalKey}: ItemQuality=${row.quality}; ItemPermanent=${row.permanent ?? 'unknown'}; ItemPurchasable=${row.purchasable ?? 'unknown'}; ItemInitialCharges=${row.initialCharges ?? 'unknown'}`);
    }
    if (report.unmatched.length > 0) {
      console.log('');
      console.log('Unmatched catalogue entries:');
      for (const row of report.unmatched) console.log(`- ${row.itemId} ${row.canonicalKey}`);
    }
    console.log('');
    console.log('## Verdict');
    console.log('');
    console.log(verdict);
    console.log('');
    console.log('A Valve category label is evidence for its own category, not automatically a complete consumable/permanent binary. Missing fields stay unknown; no fallback rule is applied.');
    return verdict;
  });
}

main().catch((error) => {
  console.error(`item-consumable-taxonomy-research: ${error.message}`);
  process.exitCode = 1;
});
