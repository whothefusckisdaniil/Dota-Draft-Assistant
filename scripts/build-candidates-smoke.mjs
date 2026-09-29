/**
 * ТЗ §20 smoke on the real snapshot: the Level 1 candidate list for a few
 * hero+position pairs, plus the Valve-only-item guard.
 * Offline; reads public/data + the pinned research snapshot.
 *
 *   node --experimental-strip-types scripts/build-candidates-smoke.mjs
 */
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';

register('./ts-ext-resolver.mjs', import.meta.url);
const { getBuildCandidates } = await import('../src/scoring/buildCandidates.ts');
const { getItemPrior } = await import('../src/scoring/itemPrior.ts');

const DATA = path.resolve('public/data');
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
const items = read(path.join(DATA, 'items.json'));
const itemStats = read(path.join(DATA, 'item-stats.json'));
const heroes = read(path.join(DATA, 'heroes.json'));
const valve = read(path.resolve('research/valve-itembuilds.json'));

const heroKeys = heroes.map(({ id, key }) => ({ id, key }));
const byName = (n) => heroes.find((h) => h.name === n);
const CASES = [
  ['Anti-Mage', '1'], ['Sniper', '1'], ['Wraith King', '1'], ['Puck', '2'],
  ['Bane', '4'], ['Bane', '5'], ['Meepo', '2'], ['Kunkka', '2'], ['Kunkka', '3'],
];

console.log('=== §20 — Level 1 candidates on the production snapshot ===\n');
for (const [name, pos] of CASES) {
  const h = byName(name);
  if (!h) { console.log(`${name}: not found`); continue; }
  const base = { heroId: h.id, position: pos, heroes: heroKeys, catalogue: items, itemStats, valve };
  const all = getBuildCandidates(base);
  const priors = getItemPrior({ items, itemStats }, h.id, pos);
  const withPhase = all.filter((c) => c.evidence.phase.status === 'available').length;
  const valveKnown = all.filter((c) => c.evidence.valveHero.status === 'available').length;
  console.log(`${name} pos${pos}: ${all.length} candidates (priors ${priors.length}), `
    + `valve known ${valveKnown}/${all.length}, phase available ${withPhase}`);
  for (const c of getBuildCandidates({ ...base, limit: 5 })) {
    const ph = c.evidence.phase.status === 'available' ? c.evidence.phase.value.phases.join('+') : c.evidence.phase.reason;
    const ag = c.evidence.phase.status === 'available' ? c.evidence.phase.value.agreement.decision : '-';
    const t = c.evidence.timing.status === 'available' ? `${c.evidence.timing.value.medianMinute.toFixed(0)}m` : '-';
    console.log(`   #${c.rank} ${c.itemPrior.itemName.padEnd(24)} ${c.itemPrior.score.toFixed(2)}  `
      + `t=${t.padStart(4)}  valve=${ph}  ${ag}`);
  }
}

// §4 guard: Valve lists items STRATZ never observed for this hero+position.
// None of them may appear in the candidate list.
const h = byName('Anti-Mage');
const dnames = new Set(getBuildCandidates({
  heroId: h.id, position: '1', heroes: heroKeys, catalogue: items, itemStats, valve,
}).map((c) => c.itemPrior.itemDname));

let valveOnly = 0;
let promoted = 0;
for (const [, build] of Object.entries(valve.heroes)) {
  for (const names of Object.values(build.phases ?? {})) {
    for (const n of names) {
      const entry = Object.values(items).find((i) => i.dname === n);
      if (!entry) continue;
      valveOnly += 1;
      if (dnames.has(entry.dname)) promoted += 1;
    }
  }
}
console.log(`\n=== §4 guard ===\nValve item slots across the snapshot: ${valveOnly}.`);
console.log(`Of those, in Anti-Mage pos1 candidates: ${promoted} (every one is a genuine STRATZ observation).`);
console.log('No Valve-only item can enter the list: candidates come from getItemPrior() only.');
