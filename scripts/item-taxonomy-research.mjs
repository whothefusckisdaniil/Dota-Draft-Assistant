#!/usr/bin/env node
/**
 * ТЗ №15 — Item classification & slot model RESEARCH. Fully offline (ТЗ §26).
 *
 * Reads only the shipped public/data/{items,item-stats,heroes,positions}.json.
 * Makes no request and never uses the STRATZ token.
 *
 *   node --experimental-strip-types scripts/item-taxonomy-research.mjs metadata
 *   node --experimental-strip-types scripts/item-taxonomy-research.mjs timing
 *   node --experimental-strip-types scripts/item-taxonomy-research.mjs bimodality
 *   node --experimental-strip-types scripts/item-taxonomy-research.mjs spread
 *   node --experimental-strip-types scripts/item-taxonomy-research.mjs sanity
 *   node --experimental-strip-types scripts/item-taxonomy-research.mjs all
 *
 * The maths comes from src/scoring/itemStats.ts — the same module the
 * production ItemPrior engine ships on, so the numbers here describe the real
 * engine. That import is TypeScript, hence --experimental-strip-types.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { histogramStats, purchaseEventsPerGame, eventShare, positionLift, smoothedIntensity } from '../src/scoring/itemStats.ts';
import { classifyCatalogue, collectObservedItemIds, ITEM_CLASS, SLOT_BEHAVIOR, STACK_BEHAVIOR, PURCHASE_CONSTRAINT, BUILD_CANDIDATE } from './item-taxonomy.mjs';

const DATA = path.resolve('public/data');
const read = (f) => JSON.parse(readFileSync(path.join(DATA, f), 'utf8'));

const items = read('items.json');
const itemStats = read('item-stats.json');
const heroes = read('heroes.json');
const observed = collectObservedItemIds(itemStats);
const nameOf = (id) => heroes.find((h) => h.id === id)?.name ?? `#${id}`;
const cell = (h, p, i) => itemStats[h]?.[p]?.[String(i)] ?? null;
const pct = (x) => `${(x * 100).toFixed(1)}%`;

/** Population baseline for one item on one lane (same maths as getItemPrior). */
function baseline(pos, itemId) {
  let events = 0;
  let games = 0;
  for (const byPos of Object.values(itemStats)) {
    const byItem = byPos[pos];
    if (!byItem) continue;
    const c = byItem[String(itemId)];
    if (c) events += c.purchases;
    games += Object.values(byItem)[0]?.heroGames ?? 0;
  }
  return games > 0 ? events / games : 0;
}

/** All features for one cell, matching the production engine. */
function features(heroId, pos, itemId, alpha = 100) {
  const c = cell(heroId, pos, itemId);
  if (!c || !c.heroGames) return null;
  const total = Object.values(itemStats[heroId][pos]).reduce((s, x) => s + x.purchases, 0);
  const base = baseline(pos, itemId);
  const ev = purchaseEventsPerGame(c.purchases, c.heroGames);
  const share = eventShare(c.purchases, total);
  const lift = positionLift(smoothedIntensity(c.purchases, c.heroGames, base, alpha), base);
  const t = histogramStats(c.byMinute);
  return { itemId, purchases: c.purchases, heroGames: c.heroGames, ev, share, lift, base, ...t, instances: c.instances, byMinute: c.byMinute };
}

const BENCH = [['Sniper', '1'], ['Anti-Mage', '1'], ['Wraith King', '1'], ['Puck', '2'],
  ['Bane', '4'], ['Bane', '5'], ['Meepo', '2'], ['Kunkka', '2'], ['Kunkka', '3']];

// ============================================================ PART A: metadata
function metadata() {
  console.log('=== Part A.1 — what the persisted metadata can and cannot say ===\n');
  const fields = new Set();
  for (const i of Object.values(items)) Object.keys(i).forEach((k) => fields.add(k));
  console.log('fields in items.json:', [...fields].join(', '));
  console.log('\nAbsent, and needed for a real slot model: isRecipe, consumedBy,');
  console.log('charges/initial charges, departsFrom, "held" behaviour, attribute bonuses.');
  console.log('`components` is present but EMPTY for all', Object.keys(items).length, 'entries,');
  console.log('so recipe ingredients cannot be detected from metadata either.');

  const cls = classifyCatalogue(items, observed);
  const count = (key, val) => cls.filter((c) => c[key] === val).length;
  console.log('\n=== Part A.2 — item class (metadata only) ===');
  for (const v of Object.values(ITEM_CLASS)) {
    const n = count('itemClass', v);
    if (n) console.log(`  ${v.padEnd(16)} ${String(n).padStart(3)}`);
  }
  console.log('\n=== Part A.3 — stack behaviour / purchase constraint / slot behaviour ===');
  for (const v of Object.values(STACK_BEHAVIOR)) {
    console.log(`  stackBehavior       ${v.padEnd(16)} ${String(count('stackBehavior', v)).padStart(3)}`);
  }
  for (const v of Object.values(PURCHASE_CONSTRAINT)) {
    console.log(`  purchaseConstraint  ${v.padEnd(16)} ${String(count('purchaseConstraint', v)).padStart(3)}`);
  }
  for (const v of Object.values(SLOT_BEHAVIOR)) {
    console.log(`  slotBehavior        ${v.padEnd(16)} ${String(count('slotBehavior', v)).padStart(3)}`);
  }
  const limited = cls.filter((c) => c.purchaseConstraint === PURCHASE_CONSTRAINT.LIMITED);
  console.log(`\n  purchase-limited items (${limited.length}):`);
  for (const c of limited.slice(0, 8)) {
    console.log(`      ${String(c.itemId).padStart(4)} ${c.name.padEnd(24)} stockMax=${c.stockMax} stack=${c.stackBehavior} slot=${c.slotBehavior}`);
  }
  console.log('\n  slotBehavior is `unknown` for EVERY item, and that is the honest');
  console.log('  result: the metadata has no field describing inventory slots.');
  console.log('  stockMax bounds how many times an item can be bought. It says');
  console.log('  nothing about where the item lives — the two are different axes');
  console.log('\n=== Part A.4 — build candidacy (observed purchase events) ===');
  for (const v of Object.values(BUILD_CANDIDATE)) {
    console.log(`  ${v.padEnd(8)} ${String(count('buildCandidate', v)).padStart(3)}`);
  }

  const no = cls.filter((c) => c.buildCandidate === BUILD_CANDIDATE.NO);
  console.log(`\n--- ${no.length} catalogue entries are NEVER purchased ---`);
  const pricey = no.filter((c) => c.cost >= 1000);
  const cheap = no.filter((c) => c.cost < 1000);
  console.log(`  cost < 1000 : ${cheap.length}  (wards, potions, boots-of components)`);
  console.log(`  cost >= 1000: ${pricey.length}  -> these LOOK like real items:`);
  for (const c of pricey.slice(0, 12)) console.log(`      ${String(c.itemId).padStart(4)} ${c.name.padEnd(24)} cost=${c.cost}`);
  console.log(`      ... and ${pricey.length - 12} more`);
  console.log('\n  Reading: mostly recipe INGREDIENTS (Broadsword, Ultimate Orb, Sacred');
  console.log('  Relic...) plus items REMOVED from the game (Boots of Travel, Phase');
  console.log('  Boots, Power Treads, Arcane Boots, Guardian Greaves). STRATZ records');
  console.log('  the completed item, never its components. Metadata cannot separate');
  console.log('  these two groups — only "never purchased" separates them from real nodes.');
}


// ===================================================== PART B: timing & spread
/** Research buckets 0-10 / 10-20 / 20-30 / 30-40 / 40+ (ТЗ §12). */
const BUCKETS = [[0, 10], [10, 20], [20, 30], [30, 40], [40, Infinity]];

function bucketShares(byMinute) {
  const total = Object.values(byMinute).reduce((a, b) => a + b, 0);
  if (!total) return BUCKETS.map(() => 0);
  const out = BUCKETS.map(() => 0);
  for (const [m, n] of Object.entries(byMinute)) {
    const t = Number(m);
    const idx = BUCKETS.findIndex(([from, to]) => t >= from && t < to);
    if (idx >= 0) out[idx] += n;
  }
  return out.map((x) => x / total);
}

function timing() {
  console.log('=== Part B.1 — timing profiles, Top-20 by intensity (ТЗ §12) ===\n');
  for (const [name, pos] of BENCH) {
    const id = heroes.find((h) => h.name === name)?.id;
    const rows = Object.keys(itemStats[id]?.[pos] ?? {});
    if (rows.length === 0) { console.log(`\n### ${name} pos${pos}: no data`); continue; }
    const feats = rows.map((k) => features(id, pos, Number(k))).filter(Boolean)
      .sort((a, b) => b.ev - a.ev).slice(0, 20);
    console.log(`\n### ${name} pos${pos} — ${rows.length} items, showing top ${feats.length}`);
    console.log('  item                          pur      ev/g  share   lift    p25 med  p75  |  0-10 10-20 20-30 30-40  40+');
    for (const f of feats) {
      const [a, b, c, d, e] = bucketShares(f.byMinute);
      console.log(
        `  ${items[String(f.itemId)].name.padEnd(26)} ${String(f.purchases).padStart(7)} ` +
        `${f.ev.toFixed(2).padStart(7)} ${pct(f.share).padStart(6)} ${f.lift.toFixed(2).padStart(6)} ` +
        `${f.p25Minute.toFixed(0).padStart(4)}${f.medianMinute.toFixed(0).padStart(4)}${f.p75Minute.toFixed(0).padStart(4)}  | ` +
        `${pct(a).padStart(5)}${pct(b).padStart(6)}${pct(c).padStart(6)}${pct(d).padStart(6)}${pct(e).padStart(6)}`,
      );
    }
  }
}

/** Otsu-style 1-D threshold: the split maximising between-class variance. */
function otsu(values) {
  const xs = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (xs.length < 2) return { threshold: NaN, between: 0, total: 0, ratio: 0 };
  const sum = xs.reduce((a, b) => a + b, 0);
  const mean = sum / xs.length;
  let total = 0;
  for (const x of xs) total += (x - mean) ** 2;
  let w0 = 0, sum0 = 0;
  const best = { threshold: xs[0], between: 0 };
  for (let i = 0; i < xs.length - 1; i += 1) {
    w0 += 1; sum0 += xs[i];
    const w1 = xs.length - w0;
    if (w1 === 0) break;
    const m0 = sum0 / w0, m1 = (sum - sum0) / w1;
    const between = w0 * w1 * (m0 - m1) ** 2;
    if (between > best.between) best.threshold = xs[i], best.between = between;
  }
  return { ...best, total, ratio: xs.length > 0 && total > 0 ? best.between / total / xs.length : 0 };
}

function bimodality() {
  console.log('=== Part B.2 — is there a CORE vs SITUATIONAL split? (ТЗ §13-14) ===\n');
  const all = [];
  for (const [name, pos] of BENCH) {
    const id = heroes.find((h) => h.name === name)?.id;
    for (const k of Object.keys(itemStats[id]?.[pos] ?? {})) {
      const f = features(id, pos, Number(k));
      if (f && f.medianMinute != null) all.push({ ...f, hero: name, pos, itemName: items[String(f.itemId)].name });
    }
  }
  console.log(`cells analysed: ${all.length} (benchmark lanes only)\n`);

  for (const [label, key] of [
    ['eventShare', (f) => f.share],
    ['eventsPerGame', (f) => f.ev],
    ['medianMinute', (f) => f.medianMinute],
    ['p25Minute', (f) => f.p25Minute],
    ['p75Minute', (f) => f.p75Minute],
    ['lift', (f) => f.lift],
  ]) {
    const o = otsu(all.map(key));
    console.log(`  ${label.padEnd(14)} best split at ${o.threshold.toFixed(3).padStart(9)}   between/total = ${(o.ratio * 100).toFixed(1)}%`);
  }
  console.log('\n  eta = between/total is the share of variance explained by the best');
  console.log('  single 1-D split. 100% = a perfectly clean two-cluster split exists.');
  console.log('  Low = the feature is continuous with no natural two-cluster boundary.');

  const meds = all.map((f) => f.medianMinute).sort((a, b) => a - b);
  console.log('\n  median-purchase-minute distribution (5-minute bins):');
  const hist = new Map();
  for (const m of meds) {
    const b = Math.floor(m / 5) * 5;
    hist.set(b, (hist.get(b) ?? 0) + 1);
  }
  const maxV = Math.max(...hist.values());
  for (const b of [...hist.keys()].sort((a, b) => a - b)) {
    const n = hist.get(b);
    console.log(`    ${String(b).padStart(2)}-${String(b + 4).padStart(2)} min ${String(n).padStart(3)} ${'#'.repeat(Math.round((n / maxV) * 40))}`);
  }
  console.log('\n  A genuinely bimodal distribution shows two clear peaks with a valley');
  console.log('  between them. Read the shape above before believing either hypothesis.');

  // --- the honest test -------------------------------------------------
  // A single threshold ALWAYS explains a large share of the variance, even in a
  // perfectly unimodal sample: split any skew in half and you "explain" most of
  // it. So eta on its own is NOT evidence. The real control is a unimodal null
  // matched to the same shape — if the real data scores no higher than a
  // deliberately single-peaked distribution, there is no cluster to find.
  const ref = meds[Math.floor(meds.length / 2)];
  const iqr = meds[Math.floor(meds.length * 0.75)] - meds[Math.floor(meds.length * 0.25)];
  const sigma = Math.log1p(iqr / 1.349 / Math.max(ref, 1));
  const mu = Math.log(Math.max(ref, 1));

  // Deterministic quantile sampling instead of Math.random, so the control is
  // reproducible and the comparison is not noise.
  const nulls = [];
  for (let i = 1; i <= meds.length; i += 1) {
    const p = i / (meds.length + 1);
    const z = Math.sqrt(2) * erfInv(2 * p - 1);
    nulls.push(Math.exp(mu + sigma * z));
  }
  const oReal = otsu(meds);
  const oNull = otsu(nulls);
  console.log('\n  --- control: unimodal lognormal matched to median and IQR ---');
  console.log(`  real data   eta = ${(oReal.ratio * 100).toFixed(1)}%  (split at ${oReal.threshold.toFixed(1)} min)`);
  console.log(`  unimodal    eta = ${(oNull.ratio * 100).toFixed(1)}%  (split at ${oNull.threshold.toFixed(1)} min)`);
  const excess = oReal.ratio - oNull.ratio;
  console.log(`  excess = ${(excess * 100).toFixed(1)} percentage points`);
  console.log(excess < 0.05
    ? '  VERDICT: NOT SUPPORTED. The real distribution is no more splittable'
    : '  VERDICT: some excess — see the histogram above before believing it.');
  if (excess < 0.05) {
    console.log('  than a deliberately single-peaked one. A CORE/SITUATIONAL split is');
    console.log('  NOT identifiable from these aggregate features.');
  }

  // Local maxima of the 5-min histogram. The FIRST and LAST bins count as
  // maxima when they beat their single neighbour: without that, the biggest
  // spike (starting items at 0-4 min) is invisible and the shape is misread.
  const bins = [...hist.keys()].sort((a, b) => a - b);
  const smoothed = bins.map((b) => hist.get(b));
  const peaks = [];
  for (let i = 0; i < smoothed.length; i += 1) {
    const left = i === 0 ? -Infinity : smoothed[i - 1];
    const right = i === smoothed.length - 1 ? -Infinity : smoothed[i + 1];
    if (smoothed[i] > left && smoothed[i] >= right) peaks.push(i);
  }
  console.log(`\n  histogram counts: ${bins.map((b, i) => `${bins[i]}:${smoothed[i]}`).join(' ')}`);
  console.log(`  local maxima: ${peaks.length} (bins ${peaks.map((i) => bins[i]).join(', ')})`);
  if (peaks.length === 2) {
    const [a, b] = peaks;
    const between = smoothed.slice(a, b + 1);
    const lo = Math.min(...between);
    const hi = Math.max(smoothed[a], smoothed[b]);
    const depth = (hi - lo) / hi;
    console.log(`  valley between the two modes: min=${lo} between peaks=${hi} -> depth ${(depth * 100).toFixed(0)}%`);
    console.log(depth > 0.5
      ? '  A deep valley. Two populations are genuinely separable.'
      : '  A SHALLOW valley. The modes are bumps on one broad continuum, not two');
    if (depth <= 0.5) {
      console.log('  separate populations. Any threshold placed between them would be an');
      console.log('  artefact of the sample, not a property of how heroes buy items.');
    }
  } else {
    console.log('  More than two peaks: the spread is multi-modal or jagged, not two');
    console.log('  populations. The bimodal hypothesis does not hold.');
  }
}

/** Abramowitz-Stegun 7.1.26 error function, for the inverse normal below. */
function erf(x) {
  const s = Math.sign(x);
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  return s * (1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x));
}

/** Inverse error function via one Newton refinement from the rational seed. */
function erfInv(y) {
  if (y <= -1) return -Infinity;
  if (y >= 1) return Infinity;
  const w = -Math.log((1 - y * y) / 2);
  let x = 0.5 * Math.sqrt(w) - 0.0833333333 * Math.pow(w, 1.5) + 0.0370370370 * Math.pow(w, 2.5);
  for (let i = 0; i < 3; i += 1) {
    const e = erf(x) - y;
    const d = 2 / Math.sqrt(Math.PI) * Math.exp(-x * x);
    x -= e / d;
  }
  return x;
}

/** Popularity (X) vs specificity (Y) — ТЗ §16. */
function spread() {
  console.log('=== Part B.3 — popularity vs specificity (ТЗ §16) ===\n');
  const rows = [];
  for (const [name, pos] of BENCH) {
    const id = heroes.find((h) => h.name === name)?.id;
    for (const k of Object.keys(itemStats[id]?.[pos] ?? {})) {
      const f = features(id, pos, Number(k));
      if (f) rows.push({ ...f, lane: `${name} pos${pos}`, itemName: items[String(f.itemId)].name });
    }
  }
  const seen = new Map();
  for (const r of rows) if (!seen.has(r.itemId)) seen.set(r.itemId, r);
  const uniq = [...seen.values()];

  console.log('HIGH POPULARITY, LOW LIFT (<=1.2) — universal, not hero-specific:');
  for (const r of uniq.filter((x) => x.lift <= 1.2).sort((a, b) => b.ev - a.ev).slice(0, 8)) {
    console.log(`  ${r.itemName.padEnd(24)} ev/g=${r.ev.toFixed(2)}  lift=${r.lift.toFixed(2)}  med=${r.medianMinute.toFixed(0)}min  (${r.lane})`);
  }
  console.log('\nLOW POPULARITY, HIGH LIFT (>=2.5) — hero-specific but rarer:');
  for (const r of uniq.filter((x) => x.lift >= 2.5).sort((a, b) => b.lift - a.lift).slice(0, 8)) {
    console.log(`  ${r.itemName.padEnd(24)} ev/g=${r.ev.toFixed(2)}  lift=${r.lift.toFixed(2)}  med=${r.medianMinute.toFixed(0)}min  (${r.lane})`);
  }
  console.log('\n  The two lists barely overlap. A single "popularity" ranking cannot');
  console.log('  express both: a build needs at least one of each kind.');

  console.log('\n=== Part B.4 — three qualitative regimes (ТЗ §17) ===');
  const regime = (r) => {
    if (r.medianMinute <= 15 && r.ev >= 0.4) return 'EARLY + high-frequency';
    if (r.medianMinute >= 30) return 'LATE (post-core / luxury-like)';
    if (r.lift >= 2.5) return 'MID + high-specificity';
    return 'MID + ordinary';
  };
  const groups = new Map();
  for (const r of rows) {
    const g = regime(r);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  for (const [g, list] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const ex = [...new Set(list.map((x) => x.itemName))].slice(0, 5).join(', ');
    console.log(`  ${g.padEnd(26)} n=${String(list.length).padStart(3)}  e.g. ${ex}`);
  }
  console.log('\n  These DESCRIBE the measured cells. They are not an enum, and nobody');
  console.log('  is forced to accept them as a classification.');
}


/** Sanity cases — ТЗ §15, §23, §24, §25. */
function sanity() {
  console.log('=== Part B.5 — sanity cases (ТЗ §15/23/24/25) ===\n');
  const id = (n) => heroes.find((h) => h.name === n).id;
  const byDname = (dn) => Object.values(items).find((i) => i.dname === dn);

  console.log('--- §15 the named items, wherever they appear ---');
  const probes = ['item_wraith_band', 'item_witch_blade', 'item_ultimate_scepter', 'item_ultimate_scepter_2',
    'item_moon_shard', 'item_aghanims_shard', 'item_magic_wand', 'item_bfury', 'item_monkey_king_bar',
    'item_black_king_bar', 'item_blink', 'item_satanic', 'item_butterfly'];
  for (const dn of probes) {
    const it = byDname(dn);
    if (!it) { console.log(`  ${dn.padEnd(28)} NOT IN CATALOGUE`); continue; }
    let evSum = 0, n = 0;
    const meds = [];
    for (const byPos of Object.values(itemStats)) {
      for (const byItem of Object.values(byPos)) {
        const c = byItem[String(it.id)];
        if (c && c.heroGames) {
          evSum += purchaseEventsPerGame(c.purchases, c.heroGames);
          meds.push(histogramStats(c.byMinute).medianMinute ?? 0);
          n += 1;
        }
      }
    }
    const avgMed = meds.length ? meds.reduce((a, b) => a + b, 0) / meds.length : NaN;
    console.log(`  ${it.name.padEnd(24)} id=${String(it.id).padStart(4)} cost=${String(it.cost).padStart(4)} cells=${String(n).padStart(4)} avg ev/g=${(evSum / Math.max(n, 1)).toFixed(2)} avg med=${Number.isFinite(avgMed) ? avgMed.toFixed(0) : 'n/a'}min`);
  }

  console.log('\n--- §23 Battle Fury (statistics only; the model has no id rules) ---');
  const bf = byDname('item_bfury').id;
  for (const [n, p] of [['Anti-Mage', '1'], ['Sniper', '1']]) {
    const f = features(id(n), p, bf);
    console.log(`  ${(n + ' pos' + p).padEnd(16)} ${f ? `ev/g=${f.ev.toFixed(2)} share=${pct(f.share)} lift=${f.lift.toFixed(2)}` : 'ABSENT from the dataset'}`);
  }

  console.log('\n--- §24 Bane pos4 vs pos5 ---');
  const p4 = Object.keys(itemStats[id('Bane')]['4']).map(Number);
  const p5 = Object.keys(itemStats[id('Bane')]['5']).map(Number);
  const set4 = new Set(p4), set5 = new Set(p5);
  const only4 = p4.filter((x) => !set5.has(x)).map((i) => items[String(i)].name);
  const only5 = p5.filter((x) => !set4.has(x)).map((i) => items[String(i)].name);
  console.log(`  pos4 items=${p4.length}  pos5 items=${p5.length}  shared=${p4.filter((x) => set5.has(x)).length}`);
  console.log(`  pos4-only: ${only4.join(', ') || 'none'}`);
  console.log(`  pos5-only: ${only5.join(', ') || 'none'}`);
  console.log(`  volume: pos4 heroGames=${Object.values(itemStats[id('Bane')]['4'])[0].heroGames}  pos5 heroGames=${Object.values(itemStats[id('Bane')]['5'])[0].heroGames}`);

  console.log('\n--- §25 build ORDER: what a byMinute histogram can actually say ---');
  const am = features(id('Anti-Mage'), '1', bf);
  console.log(`  Anti-Mage Battle Fury histogram: ${JSON.stringify(am.byMinute)}`);
  console.log('  It gives a distribution over minutes. It does NOT give a sequence:');
  console.log('  two items bought in the same minute are indistinguishable, and the');
  console.log('  same aggregate describes a game that bought X then Y and one that');
  console.log('  bought Y then X. Order is NOT recoverable from this data.');
}

const cmd = process.argv[2] ?? 'all';
const t0 = Date.now();
if (cmd === 'metadata') metadata();
else if (cmd === 'timing') timing();
else if (cmd === 'bimodality') bimodality();
else if (cmd === 'spread') spread();
else if (cmd === 'sanity') sanity();
else if (cmd === 'all') { metadata(); timing(); bimodality(); spread(); sanity(); }
else console.log('commands: metadata | timing | bimodality | spread | sanity | all');
console.log(`\n[research ${cmd} — ${Date.now() - t0} ms]`);
