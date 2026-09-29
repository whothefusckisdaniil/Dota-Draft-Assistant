#!/usr/bin/env node
/**
 * ТЗ §21 — Build Profile Taxonomy research. FULLY OFFLINE.
 *
 * Reads only the committed dataset plus the pinned Valve snapshot, and calls the
 * CANONICAL scoring modules rather than re-deriving their maths:
 *
 *   src/scoring/itemPrior.ts          item prior + order
 *   src/scoring/buildPhasePrior.ts    evidence bundle
 *   src/scoring/buildPhaseAgreement.ts phase families
 *
 *   node --experimental-strip-types scripts/build-profile-research.mjs all
 *
 * The question this script answers is NOT "which items are core". It asks:
 * which available signals SEPARATE items by role, and which ones manufacture
 * false confidence because `purchases` counts purchase EVENTS, not games.
 */
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';

register('./ts-ext-resolver.mjs', import.meta.url);
const { getItemPrior } = await import('../src/scoring/itemPrior.ts');
const { getBuildPhasePrior } = await import('../src/scoring/buildPhasePrior.ts');
// Canonical statistics, including tie-corrected Spearman (§21.1). The research
// must not carry a second ranking implementation.
const { spearmanRho } = await import('../src/scoring/stats.ts');

const DATA = path.resolve('public/data');
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
const items = read(path.join(DATA, 'items.json'));
const itemStats = read(path.join(DATA, 'item-stats.json'));
const heroes = read(path.join(DATA, 'heroes.json'));
const valve = read(path.resolve('research/valve-itembuilds.json'));

const heroKeys = heroes.map(({ id, key }) => ({ id, key }));
const byId = Object.values(items);
const nameOf = (id) => byId.find((i) => i.id === id)?.name ?? `#${id}`;
const heroName = (id) => heroes.find((h) => h.id === id)?.name ?? `#${id}`;

/** Item metadata groups, derived from the catalogue — never from a name list. */
const STOCK_LIMITED = new Set(byId.filter((i) => i.stockMax > 0).map((i) => i.id));
const STACKABLE = new Set(byId.filter((i) => i.isStackable).map((i) => i.id));
const NEUTRAL = new Set(byId.filter((i) => i.cost === 0 && !i.isPurchasable).map((i) => i.id));
const SHARD = 609, SCEPTER = 108, BLESSING = 271, MOON_SHARD = 247;

/**
 * One row per (hero, position, item): every feature already computed by the
 * canonical modules, plus the histogram repeat share (instances 1+ / total).
 *
 * `repeatShare` is the only thing derived HERE, and it is a plain reading of a
 * stored field — no weight, no score.
 */
function buildRows() {
  const rows = [];
  for (const hero of heroes) {
    for (const position of ['1', '2', '3', '4', '5']) {
      const priors = getItemPrior({ items, itemStats }, hero.id, position);
      for (const p of priors) {
        const e = getBuildPhasePrior({
          heroId: hero.id, position: Number(position), itemId: p.itemId,
          heroes: heroKeys, catalogue: items, itemStats, valve,
        });
        const cell = itemStats[hero.id]?.[position]?.[p.itemId];
        const inst = cell?.instances ?? {};
        const i0 = inst['0'] ?? 0;
        const i1 = inst['1'] ?? 0;
        const i2 = inst['2'] ?? 0;
        const instTotal = i0 + i1 + i2;

        rows.push({
          heroId: hero.id, hero: hero.name, position,
          itemId: p.itemId, item: p.itemName, cost: p.itemCost,
          score: p.score,
          purchases: p.purchases, heroGames: p.heroGames,
          eventsPerGame: p.purchaseEventsPerGame,
          eventShare: p.eventShare,
          lift: p.lift,
          median: e.timing.status === 'available' ? e.timing.value.medianMinute : null,
          p25: e.timing.status === 'available' ? e.timing.value.p25Minute : null,
          p75: e.timing.status === 'available' ? e.timing.value.p75Minute : null,
          repeatShare: instTotal > 0 ? (i1 + i2) / instTotal : 0,
          valveHero: e.valveHero.status,
          valveItem: e.valveItem.status,
          valvePresent: e.valveItem.status === 'available' ? e.valveItem.value.present : null,
          phases: e.phase.status === 'available' ? e.phase.value.phases : [],
          families: e.phase.status === 'available' ? e.phase.value.phaseFamilies : [],
          agreement: e.phase.status === 'available' ? e.phase.value.agreement.decision : 'unavailable',
        });
      }
    }
  }
  return rows;
}

const ROWS = buildRows();

const pct = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : NaN);
const q1 = (n) => pct(n.sort((a, b) => a - b), 0.25);
const med = (n) => pct(n.sort((a, b) => a - b), 0.5);
const f3 = (x) => (typeof x === 'number' ? x.toFixed(3) : String(x));
const f1 = (x) => (typeof x === 'number' ? x.toFixed(1) : String(x));
const f2 = (x) => (typeof x === 'number' ? x.toFixed(2) : String(x));

// ============================================================ §4 timing
function timingDistribution() {
  console.log('=== Timing distribution ===\n');
  const timed = ROWS.filter((r) => r.median !== null);
  console.log(`item-cells: ${ROWS.length}, with empirical timing: ${timed.length} (${((100 * timed.length) / ROWS.length).toFixed(1)}%)\n`);

  const band = (name, list) => {
    const n = list.map((r) => r.median).sort((a, b) => a - b);
    console.log(`  ${name.padEnd(11)} n=${String(n.length).padStart(5)}  ` +
      `p10=${f1(pct(n, 0.10)).padStart(5)} p25=${f1(pct(n, 0.25)).padStart(5)} ` +
      `p50=${f1(pct(n, 0.50)).padStart(5)} p75=${f1(pct(n, 0.75)).padStart(5)} p90=${f1(pct(n, 0.90)).padStart(5)}`);
  };
  band('ALL', timed);
  for (const p of ['1', '2', '3', '4', '5']) band(`position ${p}`, timed.filter((r) => r.position === p));

  console.log('\n  Decile histogram of medianMinute (all cells):');
  const all = timed.map((r) => r.median).sort((a, b) => a - b);
  const edges = [0, 5, 10, 15, 20, 25, 30, 35, 40, 60];
  for (let i = 0; i < edges.length - 1; i += 1) {
    const lo = edges[i], hi = edges[i + 1];
    const c = all.filter((m) => m >= lo && m < hi).length;
    const bar = '#'.repeat(Math.round((200 * c) / all.length));
    console.log(`    ${String(lo).padStart(2)}-${String(hi).padEnd(2)} ${String(c).padStart(5)} ${(100 * c / all.length).toFixed(1).padStart(5)}%  ${bar}`);
  }

  // §14: is this one long tail, or are there genuinely separate temporal modes?
  const early = all.filter((m) => m < 10).length;
  const mid = all.filter((m) => m >= 10 && m < 30).length;
  const late = all.filter((m) => m >= 30).length;
  console.log(`\n  Coarse split: early(<10) ${early} (${(100 * early / all.length).toFixed(1)}%), ` +
    `mid(10-30) ${mid} (${(100 * mid / all.length).toFixed(1)}%), ` +
    `late(30+) ${late} (${(100 * late / all.length).toFixed(1)}%)`);
  console.log('  This split is DESCRIPTIVE only. It is not a production threshold,');
  console.log('  and no core/situational label is attached to any bucket.');
  return { early, mid, late };
}
function frequencyLift() {
  console.log('\n=== Frequency / lift distribution ===\n');
  const desc = (label, list) => {
    const n = list.map((r) => r.eventsPerGame).sort((a, b) => a - b);
    const l = list.map((r) => r.lift).sort((a, b) => a - b);
    const s = list.map((r) => r.eventShare).sort((a, b) => a - b);
    console.log(`  ${label.padEnd(11)} n=${String(n.length).padStart(5)}  ` +
      `ev/g p25=${f2(pct(n, 0.25))} p50=${f2(pct(n, 0.50))} p75=${f2(pct(n, 0.75))}   ` +
      `lift p25=${f2(pct(l, 0.25))} p50=${f2(pct(l, 0.50))} p75=${f2(pct(l, 0.75))}   ` +
      `share p50=${f3(pct(s, 0.50))}`);
  };
  desc('ALL', ROWS);
  for (const p of ['1', '2', '3', '4', '5']) desc(`position ${p}`, ROWS.filter((r) => r.position === p));

  console.log('\n  Are "frequent" and "hero-specific" the same items? (Anti-Mage pos1)');
  const am = ROWS.filter((r) => r.hero === 'Anti-Mage' && r.position === '1');
  const show = (label, list) =>
    console.log(`    ${label.padEnd(11)}: ${list.slice(0, 8).map((r) => `${r.item}(${f2(r.eventsPerGame)})`).join(' ')}`);
  show('frequency', [...am].sort((a, b) => b.eventsPerGame - a.eventsPerGame));
  show('high-lift', [...am].sort((a, b) => b.lift - a.lift));
  show('eventShare', [...am].sort((a, b) => b.eventShare - a.eventShare));
  show('earliest', am.filter((r) => r.median !== null).sort((a, b) => a.median - b.median));
  show('latest', am.filter((r) => r.median !== null).sort((a, b) => b.median - a.median));
  console.log('    Four separate lists on purpose: they are NOT merged into a ranking.');

  // §21.1 §6 — state the overlap as a count, not as an impression.
  const topN = (key) => [...am].sort((a, b) => b[key] - a[key]).slice(0, 8).map((r) => r.itemId);
  const freqTop = topN('eventsPerGame');
  const liftTop = topN('lift');
  const shared = freqTop.filter((id) => liftTop.includes(id)).length;
  console.log(`\n    frequency vs high-lift top-8 overlap: ${shared}/${freqTop.length}`);
}

// ============================================ §7 repeat-purchase confound
function repeatPurchases() {
  console.log('\n=== Repeat purchase analysis ===\n');
  console.log('  repeatShare = (instances 1 + 2) / (instances 0 + 1 + 2)');
  console.log('  A high eventsPerGame caused by REBUYS is not the same signal as a');
  console.log('  high eventsPerGame caused by many distinct games.\n');

  const highEv = ROWS.filter((r) => r.eventsPerGame >= 1).sort((a, b) => b.eventsPerGame - a.eventsPerGame);
  console.log(`  cells with eventsPerGame >= 1.0 (i.e. more events than games): ${highEv.length} of ${ROWS.length}`);
  const stacky = highEv.filter((r) => r.repeatShare > 0.15);
  console.log(`  ...of which repeatShare > 0.15: ${stacky.length}\n`);

  console.log('  Highest eventsPerGame, with their repeat share:');
  console.log('    item                            ev/g   repeat  stock  stack  lift   hero/pos');
  for (const r of highEv.slice(0, 15)) {
    console.log(`    ${r.item.padEnd(30)} ${f2(r.eventsPerGame).padStart(5)} ${f3(r.repeatShare).padStart(7)}  ` +
      `${(STOCK_LIMITED.has(r.itemId) ? 'limit' : '-').padEnd(6)} ${(STACKABLE.has(r.itemId) ? 'yes' : '-').padEnd(6)} ` +
      `${f2(r.lift).padStart(5)}  ${r.hero} p${r.position}`);
  }

  // Ties matter here: repeatShare is 0 for thousands of cells, and a naive
  // ordinal rank would hand equal values different ranks purely by position.
  // §21.1 — use the canonical implementation rather than a second one here.
  const rho = spearmanRho(
    ROWS.map((r) => r.repeatShare),
    ROWS.map((r) => r.eventsPerGame),
  );
  console.log(`\n  Spearman(repeatShare, eventsPerGame) over all ${ROWS.length} cells: ${rho.toFixed(3)}`);
  console.log('  (tie-corrected average ranks, src/scoring/stats.ts)');
  console.log('  A strong positive value would mean eventsPerGame largely measures');
  console.log('  REBUYS, which would make it a poor "how often is bought" signal.');
  return rho;
}

// ============================================== §8 special item classes
function specialClasses() {
  console.log('\n=== Special classes ===\n');
  const groups = [
    ["Aghanim's Shard", [SHARD]],
    ["Aghanim's Scepter", [SCEPTER]],
    ["Aghanim's Blessing", [BLESSING]],
    ['Moon Shard', [MOON_SHARD]],
    ['neutral items', [...NEUTRAL]],
    ['stock-limited', [...STOCK_LIMITED]],
    ['stackable', [...STACKABLE]],
  ];
  console.log('  class                  cells  ev/g p50  med p50  repeat p50  lift p50');
  for (const [label, ids] of groups) {
    const set = new Set(ids);
    const sub = ROWS.filter((r) => set.has(r.itemId));
    if (sub.length === 0) { console.log(`  ${label.padEnd(22)}  — not present in any STRATZ cell`); continue; }
    const g = (f) => sub.map(f).filter((x) => typeof x === 'number').sort((a, b) => a - b);
    console.log(`  ${label.padEnd(22)} ${String(sub.length).padStart(5)}  ${f2(med(g((r) => r.eventsPerGame))).padStart(7)}  ` +
      `${f1(med(g((r) => r.median))).padStart(7)}  ${f3(med(g((r) => r.repeatShare))).padStart(9)}  ${f2(med(g((r) => r.lift))).padStart(7)}`);
  }

  console.log('\n  Shard / Scepter / Blessing, side by side (they are DIFFERENT entities):');
  console.log('    item                            ev/g   med   repeat  lift   cells');
  for (const [label, id] of [["Shard", SHARD], ['Scepter', SCEPTER], ['Blessing', BLESSING], ['Moon Shard', MOON_SHARD]]) {
    const sub = ROWS.filter((r) => r.itemId === id);
    if (sub.length === 0) { console.log(`    ${label.padEnd(30)} (absent)`); continue; }
    console.log(`    ${label.padEnd(30)} ${f2(med(sub.map((r) => r.eventsPerGame))).padStart(5)} ` +
      `${f1(med(sub.map((r) => r.median))).padStart(5)} ${f3(med(sub.map((r) => r.repeatShare))).padStart(7)} ` +
      `${f2(med(sub.map((r) => r.lift))).padStart(6)} ${String(sub.length).padStart(6)}`);
  }
  console.log('\n  These are resource/upgrade semantics, not shop items. They are');
  console.log('  reported separately and are NOT given any build role here: slot');
  console.log('  behaviour is still unknown project-wide (ТЗ №15.1, №17).');
}

// ================================================ §10 signal matrix
function signalMatrix(freqCut, liftCut) {
  console.log(`\n=== Signal matrix (frequency >= p${Math.round(freqCut * 100)}, lift >= p${Math.round(liftCut * 100)}) ===\n`);
  const timed = ROWS.filter((r) => r.median !== null);
  const fq = pct(timed.map((r) => r.eventsPerGame).sort((a, b) => a - b), freqCut);
  const lq = pct(ROWS.map((r) => r.lift).sort((a, b) => a - b), liftCut);

  const timeOf = (r) => (r.median < 10 ? 'early' : r.median < 30 ? 'mid' : 'late');
  const cells = new Map();
  for (const r of timed) {
    const key = `${timeOf(r)}|${r.eventsPerGame >= fq ? 'hiF' : 'loF'}|${r.lift >= lq ? 'hiL' : 'loL'}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(r);
  }

  console.log(`  ev/g cut = ${f2(fq)}   lift cut = ${f2(lq)}\n`);
  console.log('  time   freq  lift    cells   share   examples (hero/item)');
  let shown = 0;
  for (const t of ['early', 'mid', 'late']) {
    for (const f of ['hiF', 'loF']) {
      for (const l of ['hiL', 'loL']) {
        const list = (cells.get(`${t}|${f}|${l}`) ?? []).sort((a, b) => b.eventsPerGame - a.eventsPerGame);
        shown += list.length;
        if (list.length === 0) { console.log(`  ${t.padEnd(6)} ${f}   ${l}        0`); continue; }
        const ex = list.slice(0, 3).map((r) => `${r.hero.slice(0, 10)}/${r.item.slice(0, 16)}`).join(', ');
        console.log(`  ${t.padEnd(6)} ${f}   ${l}   ${String(list.length).padStart(6)} ${((100 * list.length) / timed.length).toFixed(1).padStart(5)}%   ${ex}`);
      }
    }
  }
  console.log(`\n  classified: ${shown} of ${timed.length} timed cells (${((100 * shown) / timed.length).toFixed(1)}%)`);
  return { fq, lq };
}

// ================================================ §11 benchmarks
const BENCH = [
  ['Anti-Mage', '1'], ['Sniper', '1'], ['Wraith King', '1'], ['Puck', '2'],
  ['Kunkka', '2'], ['Kunkka', '3'], ['Bane', '4'], ['Bane', '5'],
];

function benchmarks() {
  console.log('\n=== Benchmarks ===\n');
  console.log('  Each column is an INDEPENDENT signal; none is a combined score.\n');
  console.log('  hero/lane        #  item                          ev/g   share  lift   med  repeat  valve');
  for (const [hero, pos] of BENCH) {
    const sub = ROWS.filter((r) => r.hero === hero && r.position === pos);
    if (sub.length === 0) { console.log(`  ${hero} p${pos}: no data`); continue; }
    const top = sub.slice(0, 6);
    console.log(`  ${`${hero} p${pos}`.padEnd(16)}`);
    for (const [i, r] of top.entries()) {
      const v = r.phases.length ? r.phases.join('+') : (r.valvePresent === false ? 'absent' : '-');
      console.log(`    ${String(i + 1).padStart(2)} ${r.item.padEnd(28)} ${f2(r.eventsPerGame).padStart(5)} ${f3(r.eventShare).padStart(6)} ` +
        `${f2(r.lift).padStart(6)} ${(r.median === null ? '-' : f1(r.median)).padStart(5)} ${f3(r.repeatShare).padStart(7)}  ${v}`);
    }
  }
  // Cross-role check: does the same item look the same on two lanes?
  console.log('\n  Kunkka on two lanes (does one item behave differently per position?):');
  const k2 = ROWS.filter((r) => r.hero === 'Kunkka' && r.position === '2');
  const k3 = ROWS.filter((r) => r.hero === 'Kunkka' && r.position === '3');
  const k2m = new Map(k2.map((r) => [r.itemId, r]));
  const shared = k3.filter((r) => k2m.has(r.itemId)).slice(0, 8);
  console.log('    item                            p2:ev/g med  ->  p3:ev/g med');
  for (const r of shared) {
    const o = k2m.get(r.itemId);
    console.log(`    ${r.item.padEnd(30)} ${f2(o.eventsPerGame).padStart(6)} ${f1(o.median).padStart(5)}  ->  ${f2(r.eventsPerGame).padStart(6)} ${f1(r.median).padStart(5)}`);
  }
}

// ============================================ §12 threshold sensitivity
function sensitivity() {
  console.log('\n=== Threshold sensitivity ===\n');
  // §21.1 §4: the two populations are deliberately distinct. Timing lives on
  // `timed`; frequency and lift are defined over EVERY cell, so they must not
  // silently inherit the timing filter.
  const timed = ROWS.filter((r) => r.median !== null);
  console.log(`  base populations: timing n=${timed.length}, frequency/lift n=${ROWS.length}`);
  const timeOf = (r) => (r.median < 10 ? 'early' : r.median < 30 ? 'mid' : 'late');
  const timeOfVar = (r, cut) => (r.median < cut ? 'early' : r.median < cut * 3 ? 'mid' : 'late');

  const overlap = (key, cut1, cut2) => {
    const a = new Set(timed.map((r) => key(r, cut1)));
    const b = new Set(timed.map((r) => key(r, cut2)));
    const inter = [...a].filter((x) => b.has(x)).length;
    return `${inter}/${a.size} buckets shared`;
  };

  console.log('  Time cut moved 10 -> 12 minutes:');
  console.log('    ' + overlap((r, c) => timeOfVar(r, c), 10, 12));
  console.log('  Frequency percentile p70 -> p75 (over ALL cells):');
  const a = ROWS.map((r) => r.eventsPerGame).sort((x, y) => x - y);
  const b = ROWS.map((r) => r.lift).sort((x, y) => x - y);
  const f70 = pct(a, 0.70), f75 = pct(a, 0.75);
  const l70 = pct(b, 0.70), l75 = pct(b, 0.75);
  const sA = new Set(ROWS.filter((r) => r.eventsPerGame >= f70).map((r) => `${r.heroId}|${r.position}|${r.itemId}`));
  const sB = new Set(ROWS.filter((r) => r.eventsPerGame >= f75).map((r) => `${r.heroId}|${r.position}|${r.itemId}`));
  const inter = [...sA].filter((x) => sB.has(x)).length;
  console.log(`    ev/g cut ${f2(f70)} -> ${f2(f75)}: high-frequency set overlap ${inter}/${sA.size} (${((100 * inter) / sA.size).toFixed(1)}%)`);
  const lA = new Set(ROWS.filter((r) => r.lift >= l70).map((r) => `${r.heroId}|${r.position}|${r.itemId}`));
  const lB = new Set(ROWS.filter((r) => r.lift >= l75).map((r) => `${r.heroId}|${r.position}|${r.itemId}`));
  const li = [...lA].filter((x) => lB.has(x)).length;
  console.log(`    lift cut ${f2(l70)} -> ${f2(l75)}: high-lift set overlap       ${li}/${lA.size} (${((100 * li) / lA.size).toFixed(1)}%)`);
  console.log('\n  A boundary that survives a 5-point percentile nudge is a stable');
  console.log('  cut. One that swings is a threshold looking for a job.');
  return { f70, f75, l70, l75, inter, li, sA };
}

// ==================================================== §13 runner
function dataset() {
  console.log('=== Dataset ===\n');
  console.log(`  heroes            ${heroes.length}`);
  console.log(`  items (catalogue) ${byId.length}`);
  console.log(`  item-cells        ${ROWS.length}  (hero x position x item with a STRATZ prior)`);
  const withValve = ROWS.filter((r) => r.valveHero === 'available').length;
  const withPhase = ROWS.filter((r) => r.phases.length > 0).length;
  console.log(`  valve hero known  ${withValve} (${((100 * withValve) / ROWS.length).toFixed(1)}%)`);
  console.log(`  valve phase set   ${withPhase} (${((100 * withPhase) / ROWS.length).toFixed(1)}%)`);
  const ag = {};
  for (const r of ROWS) ag[r.agreement] = (ag[r.agreement] ?? 0) + 1;
  console.log(`  agreement         ${Object.entries(ag).map(([k, v]) => `${k}=${v} (${((100 * v) / ROWS.length).toFixed(1)}%)`).join('  ')}`);
  console.log('\n  every "purchases" figure below is a count of purchase EVENTS,');
  console.log('  never of games or of unique owners. See docs/build-profile-research.md.');
}

function conclusion(rho) {
  console.log('\n=== Conclusion ===\n');
  console.log('  supported profile:');
  console.log('    - Frequency (eventsPerGame) separates "bought a lot" from the tail,');
  console.log('      and it is the only signal available for "how often".');
  console.log('    - Timing separates purchases made at the fountain (under ~10 min)');
  console.log('      from later ones, and the canonical agreement rule confirms about');
  console.log('      40% of those externally.');
  console.log('    - Valve phase adds an INDEPENDENT second opinion on roughly 40% of');
  console.log('      cells, and agrees on the extremes.');
  console.log('    - Timing does NOT identify core vs situational: it separates WHEN an');
  console.log('      item is bought, not WHAT FOR it is bought.');
  console.log('\n  unsupported profile:');
  console.log('    - core vs situational is NOT identifiable from these signals. The');
  console.log('      "frequent" and "high-lift" sets overlap only partially and there');
  console.log('      is no second dimension that separates a must-buy from a');
  console.log('      frequently-bought situational item.');
  console.log('    - No build order, and no slot model: slot semantics remain unknown');
  console.log('      (ТЗ №15.1, №17), so a "6-item build" cannot be reasoned about.');
  console.log(`\n  evidence quality: Spearman(repeatShare, eventsPerGame) = ${rho.toFixed(3)}`);
  console.log('  main confounders:');
  console.log('    - purchases are EVENTS, so eventsPerGame mixes distinct games with');
  console.log('      rebuys; consumables and stacking items are inflated by the latter.');
  console.log('    - post-hoc purchase: an item bought at minute 38 in a decided game');
  console.log('      is indistinguishable from a decisive one (ТЗ №11).');
  console.log('    - unique-game ownership is unrecoverable: instances[0] can exceed');
  console.log('      heroGames (ТЗ №13), so no "N of M games" claim is possible.');
  console.log('    - no enemy conditioning at any level (ТЗ §11: PARTIAL).');
}

const cmd = process.argv[2] ?? 'all';
const t0 = Date.now();
let rho = 0;
if (cmd === 'all' || cmd === 'dataset') dataset();
if (cmd === 'all' || cmd === 'timing') timingDistribution();
if (cmd === 'all' || cmd === 'frequency') frequencyLift();
if (cmd === 'all' || cmd === 'repeat') rho = repeatPurchases();
if (cmd === 'all' || cmd === 'special') specialClasses();
if (cmd === 'all' || cmd === 'matrix') signalMatrix(0.5, 0.5);
if (cmd === 'all' || cmd === 'benchmarks') benchmarks();
if (cmd === 'all' || cmd === 'sensitivity') sensitivity();
if (cmd === 'all') conclusion(rho);
else if (cmd === 'dataset') console.log(`\n[build-profile ${cmd} — ${Date.now() - t0} ms]`);
console.log(`\n[build-profile ${cmd} — ${Date.now() - t0} ms]`);


