#!/usr/bin/env node
/**
 * ТЗ №39 — Build Assembly research. FULLY OFFLINE, production untouched.
 *
 * Pipeline (the ONLY permitted one):
 *   getItemPrior -> getBuildCandidates -> assembleBuild (research lib)
 *
 * Reads only committed local data:
 *   public/data/{items,item-stats,heroes,positions}.json
 *   research/valve-itembuilds.json
 *
 * No network, no STRATZ token. Assembles builds for 127 heroes x eligible
 * positions and reports coverage + invariants + sanity + determinism.
 *
 *   node --experimental-strip-types scripts/build-assembly-research.mjs [all|coverage|sanity|determinism]
 */
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';

register('./ts-ext-resolver.mjs', import.meta.url);
const { getBuildCandidates } = await import('../src/scoring/buildCandidates.ts');
const { eligibleLanes } = await import('../src/scoring/positionEligibility.ts');
const {
  ASSEMBLY_STATUS, DISPLAY_PHASES, canonicalDisplayPhase,
  assembleBuild, validateAssembledBuild,
} = await import('./build-assembly-lib.mjs');
const { classifyItem, collectObservedItemIds } = await import('./item-taxonomy.mjs');

const DATA = path.resolve('public/data');
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
const catalogue = read(path.join(DATA, 'items.json'));
const itemStats = read(path.join(DATA, 'item-stats.json'));
const heroes = read(path.join(DATA, 'heroes.json'));
const positions = read(path.join(DATA, 'positions.json'));
const valve = read(path.resolve('research/valve-itembuilds.json'));
const heroKeys = heroes.map(({ id, key }) => ({ id, key }));
const heroByName = new Map(heroes.map((h) => [h.name, h]));
const observedItemIds = collectObservedItemIds(itemStats);

/** All eligible (hero, lane) cells under the production gate. */
function eligibleCells() {
  const cells = [];
  for (const h of heroes) {
    for (const lane of eligibleLanes(positions, h.id)) cells.push({ hero: h, lane });
  }
  return cells;
}

function assembleCell(hero, lane) {
  const candidates = getBuildCandidates({
    heroId: hero.id, position: lane, heroes: heroKeys,
    catalogue, itemStats, valve,
  });
  return { candidates, build: assembleBuild(hero.id, lane, candidates) };
}
function sectionCoverage(p) {
  const cells = eligibleCells();
  let okCells = 0, noDataCells = 0, emptyPhaseCells = 0, violations = 0;
  let candidates = 0, assembled = 0, droppedDedupe = 0, droppedCapacity = 0, overflow = 0;
  const heroesWithBuild = new Set();
  let candidatesWithPhase = 0;
  let taxonomyRecords = 0;
  const emptyByPhase = Object.fromEntries(DISPLAY_PHASES.map((phase) => [phase, 0]));
  const itemsByPhase = Object.fromEntries(DISPLAY_PHASES.map((phase) => [phase, 0]));
  for (const { hero, lane } of cells) {
    const { candidates: cands, build } = assembleCell(hero, lane);
    if (build.status === ASSEMBLY_STATUS.OK) { okCells += 1; heroesWithBuild.add(hero.id); }
    else noDataCells += 1;
    if (build.stats.emptyPhases.length > 0 && build.status === ASSEMBLY_STATUS.OK) emptyPhaseCells += 1;
    violations += validateAssembledBuild(build, cands.map((c) => c.itemId)).length;
    candidatesWithPhase += cands.filter((candidate) =>
      canonicalDisplayPhase(candidate).phase !== 'NO_PHASE').length;
    candidates += cands.length;
    for (const phase of DISPLAY_PHASES) {
      const items = build.phases[phase];
      itemsByPhase[phase] += items.length;
      if (items.length === 0) emptyByPhase[phase] += 1;
      for (const item of items) {
        const entry = catalogue[item.itemId];
        if (!entry) {
          violations += 1;
          continue;
        }
        classifyItem(entry, { observedPurchases: observedItemIds.has(item.itemId) });
        taxonomyRecords += 1;
      }
    }
    assembled += DISPLAY_PHASES.reduce((sum, phase) => sum + build.phases[phase].length, 0);
    droppedDedupe += build.stats.droppedByDedupe;
    droppedCapacity += build.stats.droppedByCapacity;
    overflow += build.stats.overflowCount;
  }
  p('# TZ No.39 -- Build Assembly research (offline, production untouched)');
  p('');
  p(`=== Sec.1 Coverage (${heroes.length} heroes x eligible positions) ===`);
  p('');
  p(`  heroes in dataset                   ${heroes.length}`);
  p(`  heroes with >=1 build              ${heroesWithBuild.size} / ${heroes.length}`);
  p(`  eligible Hero x Position cells     ${cells.length}`);
  p(`  cells with build (OK)              ${okCells}`);
  p(`  cells with NO_BUILD_DATA           ${noDataCells}`);
  p(`  OK cells with >=1 empty phase      ${emptyPhaseCells} (valid, never backfilled)`);
  p(`  candidates -> assembled            ${candidates} -> ${assembled}`);
  p(`  candidates with mappable phase     ${candidatesWithPhase}`);
  p(`  dropped by dedupe                  ${droppedDedupe}`);
  p(`  dropped by capacity cap            ${droppedCapacity} (presentation cap)`);
  p(`  overflow (NO_PHASE evidence)       ${overflow} (counted, never force-fitted)`);
  p(`  taxonomy metadata checks           ${taxonomyRecords} (diagnostic only; no item filtering)`);
  for (const phase of DISPLAY_PHASES) {
    p(`  ${phase.padEnd(10)} items ${itemsByPhase[phase]}, empty cells ${emptyByPhase[phase]}`);
  }
  p(`  invariant violations               ${violations}`);
  p(`  BuildCandidates superset Assembled ${violations === 0 ? 'HOLDS on all cells' : 'VIOLATED'}`);
  p('');
  return { heroesWithBuild: heroesWithBuild.size, violations };
}

function sectionSanity(p) {
  p('=== Sec.2 Sanity (structural, never subjective quality) ===');
  p('');
  let inventedCount = 0;
  let violations = 0;
  for (const [name, lane] of [['Puck', '2'], ['Juggernaut', '1'], ['Crystal Maiden', '5']]) {
    const hero = heroByName.get(name);
    if (!hero) {
      p(`  ${name}: not in heroes.json`);
      violations += 1;
      continue;
    }
    if (!eligibleLanes(positions, hero.id).includes(lane)) {
      p(`  ${name} pos ${lane}: ineligible, skipped`);
      violations += 1;
      continue;
    }
    const { candidates, build } = assembleCell(hero, lane);
    const candIds = new Set(candidates.map((c) => c.itemId));
    const outIds = [...DISPLAY_PHASES.flatMap((q) => build.phases[q]), ...build.overflow].map((i) => i.itemId);
    const invented = outIds.filter((id) => !candIds.has(id));
    inventedCount += invented.length;
    violations += validateAssembledBuild(build, candIds).length;
    p(`  ${name} pos ${lane}: candidates ${candidates.length}, assembled ${outIds.length}, invented ${invented.length}`);
    for (const q of DISPLAY_PHASES) {
      if (build.phases[q].length > 0) p(`    ${q}: ${build.phases[q].map((i) => i.itemId).join(', ')}`);
    }
    if (invented.length > 0) p(`    INVENTED: ${invented.join(', ')}`);
  }
  p('  Reading: assembler only selects + organises; zero invented items expected.');
  p('');
  return { inventedCount, violations };
}

function sectionDeterminism(p) {
  const cells = eligibleCells();
  let identical = 0;
  for (const { hero, lane } of cells) {
    const { candidates } = assembleCell(hero, lane);
    const a = JSON.stringify(assembleBuild(hero.id, lane, candidates));
    const b = JSON.stringify(assembleBuild(hero.id, lane, [...candidates].reverse()));
    if (a === b) identical += 1;
  }
  p('=== Sec.3 Determinism ===');
  p('');
  p(`  re-assembled identical builds      ${identical} / ${cells.length}`);
  p('  Reversed BuildCandidates input is included in the comparison.');
  p('  Rule: same dataset -> byte-identical build (full comparator to itemId).');
  p('');
  return { identical, total: cells.length };
}

function main() {
  const mode = process.argv[2] ?? 'all';
  const allowed = new Set(['all', 'coverage', 'sanity', 'determinism']);
  if (!allowed.has(mode)) {
    process.stderr.write(`unknown mode ${mode}; want one of ${[...allowed].join('|')}\n`);
    process.exitCode = 1;
    return;
  }
  const out = [];
  const p = (s = '') => out.push(s);
  const results = {};
  if (mode === 'all' || mode === 'coverage') results.coverage = sectionCoverage(p);
  if (mode === 'all' || mode === 'sanity') results.sanity = sectionSanity(p);
  if (mode === 'all' || mode === 'determinism') results.determinism = sectionDeterminism(p);
  const structuralFailure =
    (results.coverage && results.coverage.violations > 0) ||
    (results.sanity && (results.sanity.inventedCount > 0 || results.sanity.violations > 0)) ||
    (results.determinism && results.determinism.identical !== results.determinism.total) ||
    heroes.length !== 127;
  p('=== Taxonomy boundary ===');
  p('');
  p('  Existing metadata does not distinguish consumables from re-buyable permanent items.');
  p('  Taxonomy is diagnostic only; it does not filter, move or relabel candidates.');
  p('');
  p('=== Sec.4 Verdict ===');
  p('');
  if (structuralFailure) {
    p('  BUILD_ASSEMBLY_BLOCKED (structural invariant failed)');
  } else {
    p('  BUILD_ASSEMBLY_BLOCKED (consumables cannot be safely separated using existing taxonomy)');
  }
  p('  Phase labels are Valve categories; within-phase order is ItemPrior presentation rank.');
  p('  Neither phase labels nor presentation order imply minute timing or exact purchase order.');
  console.log(out.join('\n'));
  if (structuralFailure) process.exitCode = 1;
}

main();
