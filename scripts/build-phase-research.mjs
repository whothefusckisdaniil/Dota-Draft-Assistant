#!/usr/bin/env node
/**
 * ТЗ §18 — Build Phase Prior research. FULLY OFFLINE (§24, §30).
 *
 * Reads only committed local data:
 *   public/data/{items,item-stats,heroes}.json   (STRATZ/OpenDota snapshot)
 *   research/valve-itembuilds.json                (Valve builds, pinned commit)
 *
 * No network, no STRATZ token. The TypeScript imports need Node's type
 * stripping, hence --experimental-strip-types.
 *
 *   node --experimental-strip-types scripts/build-phase-research.mjs source
 *   node --experimental-strip-types scripts/build-phase-research.mjs mapping
 *   node --experimental-strip-types scripts/build-phase-research.mjs coverage
 *   node --experimental-strip-types scripts/build-phase-research.mjs timing
 *   node --experimental-strip-types scripts/build-phase-research.mjs agreement
 *   node --experimental-strip-types scripts/build-phase-research.mjs benchmarks
 *   node --experimental-strip-types scripts/build-phase-research.mjs all
 */
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';

// `register()` only affects modules resolved AFTER it runs, and static imports
// are evaluated first — so the TypeScript modules are pulled in dynamically.
register('./ts-ext-resolver.mjs', import.meta.url);
const { getItemPrior } = await import('../src/scoring/itemPrior.ts');
const { buildValveItemMap, getBuildPhasePrior, mapHeroItems, VALVE_PHASE_ORDER } =
  await import('../src/scoring/buildPhase.ts');

const DATA = path.resolve('public/data');
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));

const items = read(path.join(DATA, 'items.json'));
const itemStats = read(path.join(DATA, 'item-stats.json'));
const heroes = read(path.join(DATA, 'heroes.json'));
const valve = read(path.resolve('research/valve-itembuilds.json'));

const heroById = new Map(heroes.map((h) => [h.id, h]));
const itemMap = buildValveItemMap(items);
const BF = 145;
const BENCH = [['Sniper', 1], ['Anti-Mage', 1], ['Wraith King', 1], ['Puck', 2],
  ['Bane', 4], ['Bane', 5], ['Meepo', 2], ['Kunkka', 2], ['Kunkka', 3]];

/**
 * The join key is the authoritative `npc_dota_hero_*` stored in heroes.json by
 * the generator (ТЗ §18.1). It is used verbatim — no slugification, no alias
 * table. Slugifying the display name is what broke 20 of the 127 joins.
 */
const heroKey = (h) => h.key;

/** The permitted join: hero + item. Never enemy, never a Valve position. */
function rowsFor(heroName, position) {
  const h = heroById.get(heroes.find((x) => x.name === heroName).id);
  const out = getBuildPhasePrior({
    heroId: h.id,
    position,
    priors: getItemPrior({ items, itemStats }, h.id, String(position)),
    catalogue: items,
    valve,
    valveHeroKey: heroKey(h),
  });
  return { h, ...out };
}

// ------------------------------------------------------------------- §1 source
function source() {
  console.log('=== §1/§2 — pinned Valve source ===\n');
  console.log(`repository   : ${valve.source.repository}`);
  console.log(`path         : ${valve.source.path}`);
  console.log(`sourceCommit : ${valve.source.sourceCommit}`);
  console.log(`commitDate   : ${valve.source.sourceCommitDate}`);
  console.log(`official API : ${valve.source.isOfficialValveApi}`);
  console.log(`\nheroes in snapshot        : ${valve.heroCount}`);
  console.log(`distinct Valve item names : ${valve.distinctValveItems}`);
  console.log(`hero-less template files  : ${(valve.herolessTemplateFiles ?? []).join(', ') || 'none'}`);
  console.log(`phase order               : ${VALVE_PHASE_ORDER.join(' > ')}`);
  console.log(`phase semantics           : ${valve.phaseSemantics}`);
}

// ------------------------------------------------------------------ §4 mapping
function mapping() {
  console.log('\n=== §4/§5 — Valve name -> canonical itemId ===\n');
  const all = new Set();
  for (const h of Object.values(valve.heroes)) {
    for (const list of Object.values(h.phases)) for (const i of list) all.add(i);
  }
  const recipes = [...all].filter((n) => /^item_recipe_/.test(n));
  const unresolved = [...all].filter((n) => itemMap.resolve(n) === null && !/^item_recipe_/.test(n));
  const resolved = [...all].filter((n) => itemMap.resolve(n) !== null);
  console.log(`distinct Valve names        : ${all.size}`);
  console.log(`resolved to canonical itemId: ${resolved.length}`);
  console.log(`recipe-like, excluded (§5)  : ${recipes.length}  e.g. ${recipes.slice(0, 4).join(', ')}`);
  console.log(`unresolved                  : ${unresolved.length}`);
  for (const u of unresolved.slice(0, 12)) console.log(`    ${u}`);
  console.log('\nThe join is exact on `dname`; no fuzzy matching, no fallback.');
}

// ----------------------------------------------------------------- §6 coverage
function coverage() {
  console.log('\n=== §6 — coverage ===\n');
  const projectKeys = new Set(heroes.map(heroKey));
  const valveKeys = Object.keys(valve.heroes);
  console.log(`Valve hero files         : ${valveKeys.length}`);
  console.log(`canonical heroes         : ${projectKeys.size}`);
  console.log(`join on heroes.json key  : ${valveKeys.filter((k) => projectKeys.has(k)).length}`);
  console.log(`Valve-only hero keys     : ${valveKeys.filter((k) => !projectKeys.has(k)).join(', ') || 'none'}`);
  console.log(`project-only hero keys   : ${[...projectKeys].filter((k) => !valve.heroes[k]).join(', ') || 'none'}`);

  let cells = 0, withValve = 0, priors = 0, itemSlots = 0;
  const unresolved = new Set();
  const recipes = new Set();
  for (const h of heroes) {
    const { byItem, report } = mapHeroItems(valve.heroes[heroKey(h)], itemMap);
    itemSlots += byItem.size;
    for (const u of report.unresolved) unresolved.add(u);
    for (const r of report.recipeLike) recipes.add(r);
    for (const pos of ['1', '2', '3', '4', '5']) {
      const p = getItemPrior({ items, itemStats }, h.id, pos);
      if (p.length === 0) continue;
      cells += 1;
      priors += p.length;
      if (p.some((x) => byItem.has(x.itemId))) withValve += 1;
    }
  }
  console.log(`\nhero-position cells with STRATZ priors          : ${cells}`);
  console.log(`STRATZ priors total                          : ${priors}`);
  console.log(`(hero, item) pairs carrying a Valve phase    : ${itemSlots}`);
  console.log(`cells with >=1 item carrying a Valve phase   : ${withValve} (${(100 * withValve / cells).toFixed(0)}%)`);
  console.log(`distinct unresolved Valve item names         : ${unresolved.size}`);
  console.log(`distinct recipe-like Valve names (excluded) : ${recipes.size}`);
  console.log('\n  unresolved names (Valve references items the catalogue no longer has):');
  for (const u of [...unresolved].sort()) console.log(`    ${u}`);
}

// ---------------------------------------------------------- §6/§8 timing
function timing() {
  console.log('\n=== §6/§8 — STRATZ empirical timing by Valve phase family ===\n');
  const byFamily = new Map();
  for (const [name, pos] of BENCH) {
    const { rows } = rowsFor(name, pos);
    for (const r of rows) {
      if (!r.valve) continue;
      for (const fam of r.valve.phaseFamilies) {
        if (!byFamily.has(fam)) byFamily.set(fam, []);
        byFamily.get(fam).push(r.timing.median);
      }
    }
  }
  for (const fam of ['starting', 'early', 'mid', 'late', 'other']) {
    const med = (byFamily.get(fam) ?? []).filter((x) => x !== null).sort((a, b) => a - b);
    if (med.length === 0) { console.log(`  ${fam.padEnd(9)} n=0`); continue; }
    const q = (p) => med[Math.min(med.length - 1, Math.floor(med.length * p))];
    console.log(`  ${fam.padEnd(9)} n=${String(med.length).padStart(3)}  p25=${q(0.25).toFixed(0).padStart(3)}  median=${q(0.5).toFixed(0).padStart(3)}  p75=${q(0.75).toFixed(0).padStart(3)}`);
  }
  console.log('\n  A Valve phase is a LABEL. These minutes come from STRATZ purchase');
  console.log('  histograms; no phase was converted into a minute range.');
}

// -------------------------------------------------------- §8/§10 agreement
function agreement() {
  console.log('\n=== §8/§10 — phase vs timing agreement matrix ===\n');
  const matrix = new Map();
  let total = 0, agree = 0, conflict = 0, unknown = 0;
  for (const [name, pos] of BENCH) {
    const { rows } = rowsFor(name, pos);
    for (const r of rows) {
      if (!r.valve || r.timing.median === null) continue;
      const fam = r.valve.phaseFamilies.join('+') || 'none';
      const bucket = r.timing.median < 15 ? 'med<15' : r.timing.median >= 30 ? 'med>=30' : 'med15-30';
      matrix.set(`${fam}|${bucket}`, (matrix.get(`${fam}|${bucket}`) ?? 0) + 1);
      total += 1;
      if (r.phaseAgreement.type === 'agreement') agree += 1;
      else if (r.phaseAgreement.type === 'conflict') conflict += 1;
      else unknown += 1;
    }
  }
  const fams = ['starting', 'early', 'mid', 'late', 'other'];
  const buckets = ['med<15', 'med15-30', 'med>=30'];
  console.log('  family     ' + buckets.map((b) => b.padStart(10)).join(''));
  for (const f of fams) {
    console.log(`  ${f.padEnd(11)}` + buckets.map((b) => String(matrix.get(`${f}|${b}`) ?? 0).padStart(10)).join(''));
  }
  console.log(`\n  compared rows: ${total}`);
  console.log(`  agreement ${agree} (${(100 * agree / total).toFixed(0)}%)  conflict ${conflict} (${(100 * conflict / total).toFixed(0)}%)  undecided ${unknown} (${(100 * unknown / total).toFixed(0)}%)`);
  console.log('  Boundaries (early<15m, late>=30m) are RESEARCH constants, not');
  console.log('  production thresholds. Conflicts are reported, never corrected.');
}

// ------------------------------------------------------------- §9 benchmarks
function benchmarks() {
  console.log('\n=== §9/§11-§15 — benchmark heroes, STRATZ top-15 ===\n');
  for (const [name, pos] of BENCH) {
    const { rows, valveSource } = rowsFor(name, pos);
    console.log(`\n### ${name} pos${pos} — ${rows.length} priors | valve ${valveSource}`);
    console.log('  item                          score  ev/g  med  valve phase(s)          agree');
    for (const r of rows.slice(0, 15)) {
      const ph = r.valve ? r.valve.phases.join('+') : '-';
      console.log(
        `  ${r.itemName.padEnd(26)} ${r.itemPrior.score.toFixed(2).padStart(5)} ` +
        `${r.itemPrior.purchaseEventsPerGame.toFixed(2).padStart(5)} ` +
        `${(r.timing.median === null ? '-' : r.timing.median.toFixed(0)).padStart(4)}  ${ph.padEnd(22)} ${r.phaseAgreement.type}`,
      );
    }
    const bf = rows.find((r) => r.itemId === BF);
    if (name === 'Anti-Mage') {
      console.log(`  >> Battle Fury: ${bf ? `rank ${rows.indexOf(bf) + 1}, valve [${bf.valve?.phases.join('+') ?? 'none'}], ev/g ${bf.itemPrior.purchaseEventsPerGame.toFixed(2)}` : 'ABSENT from STRATZ'}`);
    }
    if (name === 'Sniper') {
      console.log(`  >> Battle Fury: ${bf ? `present rank ${rows.indexOf(bf) + 1}` : 'ABSENT from STRATZ and from Valve — no fallback applied'}`);
    }
  }
}

const cmd = process.argv[2] ?? 'all';
const t0 = Date.now();
if (cmd === 'source') source();
else if (cmd === 'mapping') mapping();
else if (cmd === 'coverage') coverage();
else if (cmd === 'timing') timing();
else if (cmd === 'agreement') agreement();
else if (cmd === 'benchmarks') benchmarks();
else if (cmd === 'all') { source(); mapping(); coverage(); timing(); agreement(); benchmarks(); }
console.log(`
[research ${cmd} — ${Date.now() - t0} ms]`);
