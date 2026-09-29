#!/usr/bin/env node
/**
 * ТЗ №12 §24 — live sanity check over the generated production dataset, and
 * §25 payload measurement. Read-only: reads public/data, writes nothing.
 *
 *   node scripts/verify-items.mjs
 */
import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const DATA = path.resolve('public/data');
const read = (f) => JSON.parse(readFileSync(path.join(DATA, f), 'utf8'));

const items = read('items.json');
const stats = read('item-stats.json');
const heroes = read('heroes.json');
const positions = read('positions.json');
const meta = read('meta.json');
const nameOf = (id) => items[id]?.name ?? `item${id}`;

console.log('=== §25 payload ===');
for (const f of ['items.json', 'item-stats.json']) {
  const raw = readFileSync(path.join(DATA, f));
  const t0 = performance.now();
  JSON.parse(raw.toString());
  const parseMs = performance.now() - t0;
  console.log(
    `  ${f.padEnd(18)} raw ${(raw.length / 1024).toFixed(0).padStart(6)} KB` +
    `  gzip ${(gzipSync(raw).length / 1024).toFixed(0).padStart(5)} KB` +
    `  parse ${parseMs.toFixed(1)} ms`,
  );
}
const totalRaw = ['heroes.json', 'matchups.json', 'positions.json', 'items.json', 'item-stats.json', 'meta.json']
  .reduce((s, f) => s + statSync(path.join(DATA, f)).size, 0);
console.log(`  whole dataset      raw ${(totalRaw / 1024 / 1024).toFixed(2)} MB`);

console.log('\n=== §24 required cases ===');
const CASES = [
  ['Sniper', '1'], ['Anti-Mage', '1'], ['Wraith King', '1'],
  ['Puck', '2'], ['Bane', '4'], ['Bane', '5'],
];
for (const [heroName, pos] of CASES) {
  const h = heroes.find((x) => x.name === heroName);
  const byPos = stats[String(h.id)] ?? {};
  const byItem = byPos[pos];
  console.log(`\n--- ${heroName} (id ${h.id}) pos${pos} ---`);
  if (!byItem || Object.keys(byItem).length === 0) {
    console.log('  NO ITEM DATA (empty cell — absence is recorded, not faked)');
    continue;
  }
  const rows = Object.entries(byItem)
    .map(([iid, c]) => ({
      id: iid, name: nameOf(iid), ...c,
      // §5: winrate AMONG PURCHASES. Never call this "item winrate", never use
      // it causally.
      purchaseWinRate: c.purchases ? (c.wins / c.purchases) * 100 : 0,
      // §4: this may exceed 100 and is NOT a "percentage of games".
      purchasesPerGame: c.heroGames ? c.purchases / c.heroGames : 0,
    }))
    .sort((a, b) => b.purchases - a.purchases);
  console.log(`  items=${rows.length}  heroGames=${rows[0].heroGames}`);
  console.log('  top 10:');
  for (const r of rows.slice(0, 10)) {
    const mins = Object.entries(r.byMinute).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([m, n]) => `${m}m:${n}`).join(' ');
    const inst = Object.entries(r.instances).map(([i, n]) => `${i}x${n}`).join('+');
    console.log(
      `    ${r.name.padEnd(24)} pur=${String(r.purchases).padStart(7)} wins=${String(r.wins).padStart(7)}` +
      ` pWinRate=${r.purchaseWinRate.toFixed(1).padStart(5)}% pur/game=${r.purchasesPerGame.toFixed(2).padStart(5)}` +
      ` inst[${inst}] top[${mins}]`,
    );
  }
}

console.log('\n=== §24 specific expectations ===');
const bfury = items['145']?.name ?? 'Battle Fury';
const am = heroes.find((x) => x.name === 'Anti-Mage');
const amItems = Object.entries(stats[String(am.id)]?.['1'] ?? {}).sort((a, b) => b[1].purchases - a[1].purchases);
const amRank = amItems.findIndex(([id]) => id === '145');
console.log(`  Anti-Mage pos1: Battle Fury is #${amRank + 1} of ${amItems.length} (must be dominant)`);
const bane = heroes.find((x) => x.name === 'Bane');
const b4 = stats[String(bane.id)]?.['4'] ?? {};
const b5 = stats[String(bane.id)]?.['5'] ?? {};
const top4 = Object.entries(b4).sort((a, b) => b[1].purchases - a[1].purchases).slice(0, 5);
const top5 = Object.entries(b5).sort((a, b) => b[1].purchases - a[1].purchases).slice(0, 5);
console.log(`  Bane pos4 (${Object.keys(b4).length} items) top5: ${top4.map(([i, c]) => `${nameOf(i)}(${c.purchases})`).join(', ')}`);
console.log(`  Bane pos5 (${Object.keys(b5).length} items) top5: ${top5.map(([i, c]) => `${nameOf(i)}(${c.purchases})`).join(', ')}`);
// Compare the item SETS and the volumes, not the top-5 ordering: a shared
// ordering across two lanes is a real property of this population, and forcing
// it to differ would be tuning the check to a hoped-for answer.
const set4 = new Set(Object.keys(b4));
const set5 = new Set(Object.keys(b5));
const only4 = [...set4].filter((i) => !set5.has(i)).map(nameOf);
const only5 = [...set5].filter((i) => !set4.has(i)).map(nameOf);
const orderSame = top4.every(([i], n) => top5[n]?.[0] === i);
const vol4 = top4.reduce((s, [, c]) => s + c.purchases, 0);
const vol5 = top5.reduce((s, [, c]) => s + c.purchases, 0);
console.log(`  item sets differ: ${only4.length + only5.length > 0}` +
  `  (only pos4: ${only4.join(', ') || 'none'} | only pos5: ${only5.join(', ') || 'none'})`);
console.log(`  top-5 volumes: pos4 ${vol4} vs pos5 ${vol5} (${(vol5 / vol4).toFixed(2)}x)`);
console.log(`  top-5 ORDER is identical across pos4/pos5: ${orderSame} — measured, not assumed`);

console.log('\n=== §4/§16: purchases may exceed heroGames ===');
let over = 0;
let maxRatio = 0;
for (const byPos of Object.values(stats)) {
  for (const byItem of Object.values(byPos)) {
    for (const c of Object.values(byItem)) {
      if (c.heroGames > 0 && c.purchases > c.heroGames) {
        over += 1;
        maxRatio = Math.max(maxRatio, c.purchases / c.heroGames);
      }
    }
  }
}
console.log(`  cells where purchases > heroGames: ${over} (max ratio ${maxRatio.toFixed(2)}) — expected, not a defect`);

console.log('\n=== §9 missing-data cells ===');
let empty = 0;
for (const h of heroes) {
  for (const p of ['1', '2', '3', '4', '5']) {
    const c = stats[String(h.id)]?.[p];
    if (!c || Object.keys(c).length === 0) empty += 1;
  }
}
console.log(`  empty hero-position cells: ${empty} of ${heroes.length * 5} (recorded as absent, never back-filled)`);

console.log('\n=== §19 meta.itemData ===');
console.log(JSON.stringify(meta.itemData, null, 2).split('\n').map((l) => '  ' + l).join('\n'));
console.log(`\n  items.json has Aghanim's Scepter: ${Boolean(items['108'])}  Shard: ${Boolean(items['609'])}`);
console.log(`  catalogue is all non-recipes: ${!Object.values(items).some((i) => i.isRecipe)}`);
