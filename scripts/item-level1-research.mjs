#!/usr/bin/env node
/**
 * ТЗ №13 — Level 1 item model research. FULLY OFFLINE (§16, §28).
 *
 * Reads only the already-generated public/data/{item-stats,items,heroes}.json.
 * Makes no network calls and never uses the STRATZ token.
 *
 * The formulas are NOT defined here — they come from the production-safe
 * `src/scoring/itemStats.ts`, the same module the ItemPrior engine ships on.
 * Because that import is TypeScript, Node needs `--experimental-strip-types`
 * (Node >= 22.6); without it this script fails with ERR_UNKNOWN_FILE_EXTENSION.
 *
 *   node --experimental-strip-types scripts/item-level1-research.mjs semantics   # §2
 *   node --experimental-strip-types scripts/item-level1-research.mjs baseline    # §5
 *   node --experimental-strip-types scripts/item-level1-research.mjs timing      # §7
 *   node --experimental-strip-types scripts/item-level1-research.mjs classes     # §8/§11-14
 *   node --experimental-strip-types scripts/item-level1-research.mjs sanity      # §10
 *   node --experimental-strip-types scripts/item-level1-research.mjs sensitivity# §18
 *   node --experimental-strip-types scripts/item-level1-research.mjs all
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  eventShare, histogramStats, positionLift, purchaseEventsPerGame, purchaseWinRate,
  scoreEventShare, scoreLift, scoreRawIntensity, smoothedIntensity, supportWeight,
} from '../src/scoring/itemStats.ts';

const DATA = path.resolve('public/data');
const read = (f) => JSON.parse(readFileSync(path.join(DATA, f), 'utf8'));

const itemStats = read('item-stats.json');
const items = read('items.json');
const heroes = read('heroes.json');
const nameOf = (id) => heroes.find((h) => String(h.id) === String(id))?.name ?? `#${id}`;
const itemName = (id) => items[id]?.name ?? `item${id}`;

const cell = (heroId, pos, itemId) => itemStats[String(heroId)]?.[pos]?.[itemId] ?? null;
const cellsFor = (heroId, pos) => Object.entries(itemStats[String(heroId)]?.[pos] ?? {});

/** Total purchase events for one hero+position — the eventShare denominator. */
const heroPositionTotal = (heroId, pos) =>
  cellsFor(heroId, pos).reduce((s, [, c]) => s + c.purchases, 0);

/**
 * Global intensity for an item on a position: total events across all heroes on
 * that lane, divided by the total hero-games on that lane. This is the baseline
 * a hero is compared against in Model C.
 */
const globalPositionIntensity = (pos, itemId) => {
  let events = 0;
  let games = 0;
  for (const [hid, byPos] of Object.entries(itemStats)) {
    const c = byPos[pos]?.[itemId];
    if (c) events += c.purchases;
    const any = byPos[pos] && Object.values(byPos[pos])[0];
    if (any) games += any.heroGames;
  }
  return games > 0 ? events / games : 0;
};

/** All features for one cell (§17). */
function features(heroId, pos, itemId, alpha = 100) {
  const c = cell(heroId, pos, itemId);
  if (!c) return null;
  const total = heroPositionTotal(heroId, pos);
  const eventsPerGame = purchaseEventsPerGame(c.purchases, c.heroGames);
  const share = eventShare(c.purchases, total);
  const baseline = globalPositionIntensity(pos, itemId);
  const smoothed = smoothedIntensity(c.purchases, c.heroGames, baseline, alpha);
  const lift = positionLift(smoothed, baseline);
  const timing = histogramStats(c.byMinute);
  return {
    heroId, position: pos, itemId,
    purchases: c.purchases,
    heroGames: c.heroGames,
    purchaseEventsPerGame: eventsPerGame,
    eventShare: share,
    purchaseWinRate: purchaseWinRate(c.wins, c.purchases),
    ...timing,
    baselineIntensity: baseline,
    smoothedIntensity: smoothed,
    globalPositionIntensity: baseline,
    lift,
    support: supportWeight(c.purchases),
    instances: c.instances,
    scoreA: scoreRawIntensity(eventsPerGame),
    scoreB: scoreEventShare(share),
    scoreC: scoreLift(lift),
  };
}

const pct = (x) => `${(x * 100).toFixed(2)}%`;
const top = (rows, n) => rows.slice(0, n);

// ============================================================ §2 semantics
function semantics() {
  console.log('=== §2 what does `instances` actually mean? ===\n');

  let cells = 0;
  let sumInst = 0;
  let sumPur = 0;
  let mismatched = 0;
  const instKeys = new Map();
  let inst0OverGames = 0;
  let maxRatio = 0;
  let worst = null;
  const multiCopy = [];

  for (const [hid, byPos] of Object.entries(itemStats)) {
    for (const [pos, byItem] of Object.entries(byPos)) {
      for (const [iid, c] of Object.entries(byItem)) {
        cells += 1;
        const si = Object.values(c.instances).reduce((a, b) => a + b, 0);
        sumInst += si;
        sumPur += c.purchases;
        if (si !== c.purchases) mismatched += 1;
        for (const k of Object.keys(c.instances)) instKeys.set(k, (instKeys.get(k) ?? 0) + 1);
        const i0 = c.instances['0'] ?? 0;
        if (i0 > c.heroGames) inst0OverGames += 1;
        if (c.heroGames > 0) {
          const r = i0 / c.heroGames;
          if (r > maxRatio) { maxRatio = r; worst = { name: nameOf(hid), pos, item: itemName(iid), i0, games: c.heroGames }; }
        }
        const keys = Object.keys(c.instances);
        if (keys.length > 1) multiCopy.push({ name: nameOf(hid), pos, item: itemName(iid), instances: c.instances, purchases: c.purchases, heroGames: c.heroGames });
      }
    }
  }

  console.log(`cells analysed: ${cells}`);
  console.log(`sum(instances) = ${sumInst},  sum(purchases) = ${sumPur},  equal: ${sumInst === sumPur}`);
  console.log(`cells where sum(instances) != purchases: ${mismatched}  -> instances is a PARTITION of purchases`);
  console.log(`distinct instance keys seen: ${[...instKeys.keys()].sort((a, b) => a - b).join(', ')}`);
  console.log(`  key -> cell count: ${[...instKeys.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join('  ')}`);
  console.log(`\ncells where instances[0] > heroGames: ${inst0OverGames}`);
  console.log(`  max instances[0]/heroGames = ${maxRatio.toFixed(3)}  (${worst ? `${worst.name} pos${worst.pos} ${worst.item}: ${worst.i0} / ${worst.games}` : 'n/a'})`);

  console.log(`\n--- multi-copy items (instance 1+ exists): ${multiCopy.length} of ${cells} ---`);
  const byKind = new Map();
  for (const m of multiCopy) {
    const k = m.item;
    byKind.set(k, (byKind.get(k) ?? 0) + 1);
  }
  console.log('  most common:', [...byKind.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)
    .map(([k, v]) => `${itemName(k)}(${v})`).join(', '));
  console.log('\n  examples:');
  for (const m of multiCopy.slice(0, 6)) {
    console.log(`    ${m.name} pos${m.pos} ${m.item}: instances=${JSON.stringify(m.instances)} purchases=${m.purchases} heroGames=${m.heroGames}`);
  }

  // §2's real question: can instances recover "games in which the item was owned"?
  // Only if instances[0] <= heroGames, i.e. the first copy is bounded by games.
  const bounded = inst0OverGames === 0;
  console.log(`\nVERDICT: instances[0] <= heroGames in every cell: ${bounded}`);
  if (bounded) {
    console.log('  -> instances[0] is bounded by games, so it is consistent with');
    console.log('     "purchase events for the FIRST copy". It still does NOT prove');
    console.log('     unique-game ownership: a game that buys, sells and re-buys the');
    console.log('     same item would land in instance[0] twice. Uniqueness is');
    console.log('     unrecoverable from this aggregate, so nothing may claim it.');
  } else {
    console.log('  -> instances[0] can exceed heroGames, so it is NOT a per-game count.');
  }
}

// ============================================================== §5 baseline
const BENCHMARKS = [
  ['Sniper', 1], ['Anti-Mage', 1], ['Wraith King', 1], ['Puck', 2],
  ['Bane', 4], ['Bane', 5], ['Meepo', 2], ['Kunkka', 2], ['Kunkka', 3],
];

function ranked(heroId, pos, model, alpha = 100, n = 20) {
  return cellsFor(heroId, pos)
    .map(([iid]) => features(heroId, pos, iid, alpha))
    .filter(Boolean)
    .sort((a, b) => b[model] - a[model] || b.purchases - a.purchases)
    .slice(0, n);
}

function baseline() {
  for (const [name, pos] of BENCHMARKS) {
    const id = heroes.find((h) => h.name === name)?.id;
    const rows = cellsFor(id, pos);
    if (rows.length === 0) { console.log(`\n### ${name} pos${pos}: NO DATA`); continue; }
    console.log(`\n### ${name} pos${pos} — ${rows.length} items, heroGames=${rows[0][1].heroGames}`);

    for (const [label, model] of [['A raw intensity', 'scoreA'], ['B event share', 'scoreB'], ['C position lift', 'scoreC']]) {
      const r = ranked(id, pos, model, 100, 8);
      console.log(`  ${label.padEnd(18)}: ${r.map((f) => `${itemName(f.itemId)}(${f[model].toFixed(2)})`).join(' ')}`);
    }
    const combo = rows.map(([iid]) => features(id, pos, iid, 100))
      .map((f) => ({ ...f, scoreD: 0.6 * f.scoreA + 0.2 * f.scoreB + 0.2 * f.scoreC }))
      .sort((a, b) => b.scoreD - a.scoreD);
    console.log(`  ${'D combined'.padEnd(18)}: ${combo.slice(0, 8).map((f) => `${itemName(f.itemId)}(${f.scoreD.toFixed(2)})`).join(' ')}`);
  }
}

// ================================================================= §7 timing
function timing() {
  console.log('=== §7 timing profile from the byMinute histogram ===\n');
  for (const [name, pos] of BENCHMARKS) {
    const id = heroes.find((h) => h.name === name)?.id;
    const rows = cellsFor(id, pos);
    if (rows.length === 0) { console.log(`\n### ${name} pos${pos}: NO DATA\n`); continue; }
    console.log(`\n### ${name} pos${pos}`);
    const feats = rows.map(([iid]) => features(id, pos, iid, 100)).filter((f) => f.total > 0);
    feats.sort((a, b) => b.purchases - a.purchases);
    console.log('  item                        p25    med    p75   mean  early   mid   late  vLate');
    for (const f of feats.slice(0, 10)) {
      console.log(
        `  ${itemName(f.itemId).padEnd(26)} ` +
        `${f.p25Minute.toFixed(0).padStart(4)} ${f.medianMinute.toFixed(0).padStart(5)} ` +
        `${f.p75Minute.toFixed(0).padStart(6)} ${f.meanMinute.toFixed(1).padStart(6)}  ` +
        `${pct(f.earlyShare).padStart(5)} ${pct(f.midShare).padStart(5)} ` +
        `${pct(f.lateShare).padStart(5)} ${pct(f.veryLateShare).padStart(5)}`,
      );
    }
  }
}

// ============================================== §8/§10/§11/§12/§13/§14 classes
function classes() {
  console.log('=== §11 universal vs hero-specific (popularity vs lift) ===\n');
  console.log('High popularity + low lift  = universal item every hero buys');
  console.log('Medium popularity + high lift = this hero buys it unusually much\n');
  const rows = [];
  for (const [name, pos] of BENCHMARKS) {
    const id = heroes.find((h) => h.name === name)?.id;
    for (const [iid] of cellsFor(id, pos)) {
      const f = features(id, pos, iid, 100);
      if (f) rows.push({ ...f, hero: name });
    }
  }
  const universal = rows.filter((f) => f.lift < 1.3 && f.purchaseEventsPerGame > 0.3);
  const specific = rows.filter((f) => f.lift > 2);
  const byId = (arr) => {
    const m = new Map();
    for (const f of arr) if (!m.has(f.itemId)) m.set(f.itemId, f);
    return [...m.values()];
  };
  console.log('--- universal (lift < 1.3, ev/game > 0.3), most purchased ---');
  console.log('  ' + byId(universal).sort((a, b) => b.purchases - a.purchases).slice(0, 12)
    .map((f) => `${itemName(f.itemId)}(lift ${f.lift.toFixed(2)})`).join(', '));
  console.log('\n--- hero-specific (lift > 2), strongest ---');
  console.log('  ' + byId(specific).sort((a, b) => b.lift - a.lift).slice(0, 12)
    .map((f) => `${itemName(f.itemId)}(lift ${f.lift.toFixed(2)})`).join(', '));

  console.log('\n=== §12 duplicate-purchase bias: items with instance 1+ ===\n');
  console.log('  item                        ev/game  repeatShare  median');
  for (const f of byId(rows.filter((x) => Object.keys(x.instances).length > 1))
    .sort((a, b) => (b.instances['1'] ?? 0) - (a.instances['1'] ?? 0)).slice(0, 12)) {
    const i0 = f.instances['0'] ?? 0;
    const i1 = f.instances['1'] ?? 0;
    console.log(`  ${itemName(f.itemId).padEnd(26)} ${f.purchaseEventsPerGame.toFixed(2).padStart(7)}  ` +
      `${pct(i0 > 0 ? i1 / (i0 + i1) : 0).padStart(11)}  ${f.medianMinute.toFixed(0).padStart(6)}`);
  }
  console.log('  repeatShare = instances[1] / (instances[0] + instances[1])');
  console.log('  -> consumables and cheap stacking items are inflated by events;');
  console.log('     eventShare and lift are more robust than raw eventsPerGame.');

  console.log('\n=== §13 neutral items + §14 shard/scepter ===\n');
  for (const [label, ids] of [['neutral', [4205, 4206]], ['shard/scepter', [108, 609]], ['aghs variants', [271, 127]]]) {
    const sub = rows.filter((f) => ids.includes(Number(f.itemId)));
    if (sub.length === 0) { console.log(`  ${label}: not present in the benchmarks`); continue; }
    for (const iid of ids) {
      const fs = sub.filter((f) => Number(f.itemId) === iid);
      if (fs.length === 0) continue;
      const ev = fs.reduce((s, f) => s + f.purchaseEventsPerGame, 0) / fs.length;
      const lf = fs.reduce((s, f) => s + f.lift, 0) / fs.length;
      const sup = fs.reduce((s, f) => s + f.purchases, 0);
      const med = fs.filter((f) => f.medianMinute != null).map((f) => f.medianMinute);
      const meanMed = med.length ? med.reduce((a, b) => a + b, 0) / med.length : null;
      console.log(`  ${label.padEnd(14)} ${itemName(iid).padEnd(24)} ev/game=${ev.toFixed(3)}  lift=${lf.toFixed(2)}  purchases=${sup}  medMin=${meanMed ? meanMed.toFixed(0) : 'n/a'}`);
    }
  }
}

// ================================================================ §10 sanity
function sanity() {
  console.log('=== §10 Battle Fury sanity — statistics only, no hero/item rules ===\n');
  const amId = heroes.find((h) => h.name === 'Anti-Mage')?.id;
  const snId = heroes.find((h) => h.name === 'Sniper')?.id;
  const BF = 145;
  for (const [label, id, wantHigh] of [['Anti-Mage pos1', amId, true], ['Sniper pos1', snId, false]]) {
    const total = cellsFor(id, 1).length;
    for (const model of ['scoreA', 'scoreC', 'scoreD']) {
      let rows;
      if (model === 'scoreD') {
        rows = cellsFor(id, 1).map(([iid]) => features(id, 1, iid, 100))
          .map((f) => ({ ...f, s: 0.6 * f.scoreA + 0.2 * f.scoreB + 0.2 * f.scoreC }))
          .sort((a, b) => b.s - a.s);
      } else {
        rows = ranked(id, 1, model, 100, 1000);
      }
      // cellsFor() yields string keys from JSON, so compare on Number, not ===.
      const rank = rows.findIndex((f) => Number(f.itemId) === BF) + 1;
      const ok = wantHigh ? rank > 0 && rank <= 15 : rank === 0 || rank > 15;
      console.log(`  ${label.padEnd(15)} ${model.padEnd(6)} Battle Fury rank = ${rank || 'ABSENT'}/${total}  ${ok ? 'PASS' : 'FAIL'}`);
    }
    const f = features(id, 1, BF, 100);
    if (f) {
      console.log(`    purchases=${f.purchases} heroGames=${f.heroGames} ev/game=${f.purchaseEventsPerGame.toFixed(2)} ` +
        `eventShare=${pct(f.eventShare)} lift=${f.lift.toFixed(2)} medMin=${f.medianMinute.toFixed(0)}`);
    }
  }
  console.log('\n  No heroId or itemId branch exists in the model:');
}

// ========================================================== §18 sensitivity
function sensitivity() {
  const ALPHAS = [10, 50, 100, 500];
  console.log('=== §18 alpha sensitivity — does the ranking jump on small samples? ===\n');
  const spearman = (a, b) => {
    const n = Math.min(a.length, b.length);
    if (n < 2) return 1;
    const rank = (arr) => {
      const idx = arr.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
      const r = new Array(arr.length);
      idx.forEach(([, i], k) => { r[i] = k + 1; });
      return r;
    };
    const ra = rank(a); const rb = rank(b);
    const d2 = ra.slice(0, n).reduce((s, v, i) => s + (v - rb[i]) ** 2, 0);
    return 1 - (6 * d2) / (n * (n * n - 1));
  };

  for (const [name, pos] of BENCHMARKS) {
    const id = heroes.find((h) => h.name === name)?.id;
    if (cellsFor(id, pos).length === 0) continue;
    const byAlpha = ALPHAS.map((a) => ranked(id, pos, 'scoreC', a, 1000).map((f) => f.itemId));
    const base = byAlpha[0];
    const parts = ALPHAS.map((a, i) => {
      const t5 = byAlpha[i].slice(0, 5).filter((x) => base.slice(0, 5).includes(x)).length;
      const t15 = byAlpha[i].slice(0, 15).filter((x) => base.slice(0, 15).includes(x)).length;
      return `a=${String(a).padStart(3)} t5 ${t5}/5 t15 ${t15}/15 rho ${spearman(base, byAlpha[i]).toFixed(3)}`;
    });
    console.log(`  ${(name + ' pos' + pos).padEnd(16)} ${parts.join('  |  ')}`);
  }
  console.log('\n  rho = Spearman of the full item ordering vs alpha=10 (a 50x range).');
  console.log('  A model that barely moves is not driven by small-sample noise.');

  // Where DOES alpha matter? Only where a cell is thin. Find the smallest
  // hero-position cells in the whole dataset and re-run the sweep on those.
  console.log('\n  --- where alpha actually matters: the thinnest cells ---');
  const thin = [];
  for (const [hid, byPos] of Object.entries(itemStats)) {
    for (const [pos, byItem] of Object.entries(byPos)) {
      const total = Object.values(byItem).reduce((s, c) => s + c.purchases, 0);
      thin.push({ hid, pos, total, n: Object.keys(byItem).length });
    }
  }
  thin.sort((a, b) => a.total - b.total);
  console.log('  thinnest hero-position cells by total purchase events:');
  for (const t of thin.slice(0, 6)) {
    const id = Number(t.hid);
    const byAlpha = [10, 50, 100, 500].map((a) => ranked(id, t.pos, 'scoreC', a, 1000).map((f) => f.itemId));
    const base = byAlpha[0];
    const deltas = [10, 50, 100, 500].map((a, i) =>
      `a=${a}:rho${spearman(base, byAlpha[i]).toFixed(3)}`).join(' ');
    const moves = byAlpha.map((r) => r.slice(0, 5).join('>'));
    const unstable = new Set(moves).size > 1;
    console.log(`    ${nameOf(id).padEnd(14)} pos${t.pos} items=${String(t.n).padStart(2)} events=${String(t.total).padStart(6)}  ${deltas}  top5 stable: ${unstable ? 'NO' : 'yes'}`);
  }
  console.log('\n  The benchmark heroes all have >18k games, so alpha is irrelevant');
  console.log('  for them. It is a guard for thin cells, not a tuning knob here.');
}

const cmd = process.argv[2] ?? 'all';
const t0 = Date.now();
if (cmd === 'semantics') semantics();
else if (cmd === 'baseline') baseline();
else if (cmd === 'timing') timing();
else if (cmd === 'classes') classes();
else if (cmd === 'sanity') sanity();
else if (cmd === 'sensitivity') sensitivity();
else if (cmd === 'all') { semantics(); baseline(); timing(); classes(); sanity(); sensitivity(); }
else console.log('commands: semantics | baseline | timing | classes | sanity | sensitivity | all');
console.log(`\n[research ${cmd} — ${Date.now() - t0} ms]`);

