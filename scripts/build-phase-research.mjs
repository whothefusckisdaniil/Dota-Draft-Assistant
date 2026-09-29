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
// Single source of truth (ТЗ §19.1 §2): the canonical production modules.
// The removed `buildPhase.ts` duplicate no longer exists.
const { getBuildPhasePrior, buildValveItemMap, mapHeroItems } =
  await import('../src/scoring/buildPhasePrior.ts');
const { AGREEMENT_BOUNDARIES, VALVE_PHASE_ORDER } = await import('../src/scoring/buildPhaseAgreement.ts');

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

/** The minimal {id, key} view `getBuildPhasePrior` needs, built once. */
const heroKeys = heroes.map(({ id, key }) => ({ id, key }));

/**
 * §1 (ТЗ §19.2) — the permitted join, expressed ONLY through the canonical API.
 *
 *   getItemPrior(hero, position)  ->  for each prior
 *      getBuildPhasePrior({ heroId, position, itemId, heroes, … })
 *
 * The batch `priors:` / `valveHeroKey:` shape of the removed buildPhase.ts is
 * gone for good; nothing in production accepts it, and this script must not
 * pretend otherwise.
 *
 * The row returned below is a READABILITY VIEW over the evidence bundle, not a
 * second model: every field is projected out of the canonical result, and the
 * projection never invents a value. Where canonical says "unavailable", the view
 * says so too — it is not quietly turned into a negative.
 */
function rowsFor(heroName, position) {
  const h = heroById.get(heroes.find((x) => x.name === heroName).id);
  const rows = getItemPrior({ items, itemStats }, h.id, String(position)).map((prior) => {
    const b = getBuildPhasePrior({
      heroId: h.id,
      position,
      itemId: prior.itemId,
      heroes: heroKeys,
      catalogue: items,
      itemStats,
      valve,
    });

    // Valve opinion, as the printers consume it. `undefined` only when the hero
    // is unknown to Valve or the item cannot be resolved — a KNOWN hero with an
    // absent item keeps an object with empty phases (a real negative).
    const valveView = b.valveItem.status === 'available'
      ? {
          phases: b.valveItem.value.phases,
          phaseFamilies: b.valveItem.value.phaseFamilies,
          present: b.valveItem.value.present,
          source: b.valveItem.source,
        }
      : undefined;

    // agreement decision -> the two words the research tables print. Mapping is
    // lossless: canonical `undecided` and `unavailable` both mean "no verdict".
    const decision = b.phase.status === 'available' ? b.phase.value.agreement.decision : 'unavailable';
    const phaseAgreement = {
      type: decision === 'supported' ? 'agreement'
        : decision === 'conflicting' ? 'conflict'
          : 'undecided',
      decision,
      detail: b.phase.status === 'available' ? b.phase.value.agreement.detail : b.phase.reason,
    };

    return {
      itemId: prior.itemId,
      itemName: prior.itemName,
      itemPrior: prior,
      timing: b.timing.status === 'available'
        ? {
            p25: b.timing.value.p25Minute,
            median: b.timing.value.medianMinute,
            p75: b.timing.value.p75Minute,
          }
        : { p25: null, median: null, p75: null, reason: b.timing.reason },
      valve: valveView,
      phaseAgreement,
      // The canonical bundle, kept intact for anything that wants the detail.
      evidence: b,
    };
  });

  return { h, rows, valveSource: valve.source.sourceCommit };
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

/**
 * One timing bucket label, derived from the canonical boundaries (ТЗ §19.2).
 * Used as BOTH the matrix key and the column header, so a boundary change can
 * never relabel columns without moving the data.
 */
const bucketOf = (median) =>
  median < AGREEMENT_BOUNDARIES.earlyMedianBelow ? `med<${AGREEMENT_BOUNDARIES.earlyMedianBelow}`
    : median >= AGREEMENT_BOUNDARIES.lateMedianAtOrAbove ? `med>=${AGREEMENT_BOUNDARIES.lateMedianAtOrAbove}`
      : `med-${AGREEMENT_BOUNDARIES.earlyMedianBelow}..${AGREEMENT_BOUNDARIES.lateMedianAtOrAbove}`;

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
      const bucket = bucketOf(r.timing.median);
      matrix.set(`${fam}|${bucket}`, (matrix.get(`${fam}|${bucket}`) ?? 0) + 1);
      total += 1;
      if (r.phaseAgreement.type === 'agreement') agree += 1;
      else if (r.phaseAgreement.type === 'conflict') conflict += 1;
      else unknown += 1;
    }
  }
  const fams = ['starting', 'early', 'mid', 'late', 'other'];
  // Bucket labels mirror AGREEMENT_BOUNDARIES above, so a boundary change is
  // visible here instead of silently mislabelling the columns.
  // Column headers come from the same helper as the matrix keys.
  const buckets = [bucketOf(0), bucketOf(20), bucketOf(99)];
  // Rows the table above actually prints: single families only. Items Valve put
  // in several families land in a combined key such as `mid+other`.
  const shown = fams.reduce(
    (s, f) => s + buckets.reduce((x, b) => x + (matrix.get(`${f}|${b}`) ?? 0), 0), 0);
  const combined = total - shown;
  console.log('  family     ' + buckets.map((b) => b.padStart(10)).join(''));
  for (const f of fams) {
    console.log(`  ${f.padEnd(11)}` + buckets.map((b) => String(matrix.get(`${f}|${b}`) ?? 0).padStart(10)).join(''));
  }
  console.log(`\n  compared rows: ${total}`);
  if (combined > 0) {
    // Items Valve authored in SEVERAL families land in a combined key such as
    // `mid+other`, which the single-family rows above do not list. Say so,
    // rather than letting the column sums look short.
    console.log(`  (${combined} rows sit in multi-family buckets, e.g. "mid+other", and are`);
    console.log('   not shown in the single-family rows above)');
  }
  console.log(`  agreement ${agree} (${(100 * agree / total).toFixed(0)}%)  conflict ${conflict} (${(100 * conflict / total).toFixed(0)}%)  undecided ${unknown} (${(100 * unknown / total).toFixed(0)}%)`);
  console.log(`  Boundaries (early<${AGREEMENT_BOUNDARIES.earlyMedianBelow}m, late>=${AGREEMENT_BOUNDARIES.lateMedianAtOrAbove}m) are RESEARCH constants, not`);
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

/** §25 — print the full evidence chain for one cell. */
function show(label, heroName, position, itemName) {
  const h = heroes.find((x) => x.name === heroName);
  if (!h) { console.log(`${label}: hero not found`); return; }
  const it = Object.values(items).find((x) => x.name === itemName);
  if (!it) { console.log(`${label}: item not in catalogue`); return; }
  const b = getBuildPhasePrior({
    heroId: h.id, position, itemId: it.id,
    heroes: heroes.map((x) => ({ id: x.id, key: x.key })),
    catalogue: items, itemStats, valve,
  });
  const p = b.itemPrior.status === 'available' ? b.itemPrior.value : null;
  const t = b.timing.status === 'available' ? b.timing.value : null;
  const vh = b.valveHero.status === 'available' ? 'available' : b.valveHero.reason;
  const vi = b.valveItem.status === 'available'
    ? (b.valveItem.value.present ? b.valveItem.value.phases.join('+') : 'present:false')
    : b.valveItem.reason;
  const ph = b.phase.status === 'available'
    ? `${b.phase.value.phases.join('+')} -> ${b.phase.value.agreement.decision}`
    : b.phase.reason;
  console.log(
    `${label.padEnd(22)} prior=${p ? p.score.toFixed(2) : 'unavailable'} ` +
    `timing=${t ? `med ${t.medianMinute.toFixed(0)}m` : 'unavailable'} ` +
    `valveHero=${vh} valveItem=${vi} phase=${ph}`,
  );
}

function evidenceBenchmarks() {
  console.log('\n=== §25 — evidence chain per benchmark cell ===\n');
  show('AntiMage p1 BF', 'Anti-Mage', 1, 'Battle Fury');
  show('Sniper p1 BF', 'Sniper', 1, 'Battle Fury');
  show('Puck p2 WitchBlade', 'Puck', 2, 'Witch Blade');
  show('Bane p4 AetherLens', 'Bane', 4, 'Aether Lens');
  show('Bane p5 AetherLens', 'Bane', 5, 'Aether Lens');
  show('WraithKing p1 Radiance', 'Wraith King', 1, 'Radiance');
  show('Kunkka p2 (his #1)', 'Kunkka', 2, 'Aghanim\'s Scepter');
  show('Kunkka p3 (his #1)', 'Kunkka', 3, 'Black King Bar');
  show('Kez p1 (no Valve)', 'Kez', 1, 'Wraith Band');
}

if (cmd === 'source') source();
else if (cmd === 'mapping') mapping();
else if (cmd === 'coverage') coverage();
else if (cmd === 'timing') timing();
else if (cmd === 'agreement') agreement();
else if (cmd === 'benchmarks') { evidenceBenchmarks(); benchmarks(); }
else if (cmd === 'all') { source(); mapping(); coverage(); timing(); agreement(); evidenceBenchmarks(); benchmarks(); }
console.log(`
[research ${cmd} — ${Date.now() - t0} ms]`);
