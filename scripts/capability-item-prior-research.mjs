#!/usr/bin/env node
/**
 * TZ No.36 — Capability x ItemPrior research. FULLY OFFLINE.
 *
 * Controlled experiment: do the coarse hero capability profiles (TZ No.35 v2)
 * separate the EXISTING ItemPrior distributions once position is stratified?
 *
 * Unit of analysis: Hero x Position, eligible cells only (share>=8%,
 * games>=500). For each of the 6 capabilities x 5 positions, TRUE vs FALSE
 * groups (UNKNOWN excluded per-comparison) are compared on:
 *   (a) top-5  membership rates — permutation p, one BH pool (FDR 0.05);
 *   (b) top-10 membership rates — permutation p, one BH pool (FDR 0.05);
 *   (c) mean ItemPrior.score among observed cells — permutation p, one BH pool.
 * Permutations are shuffled WITHIN one position (N=2000, seed=20261006).
 * Full 6-feature signatures are descriptive only (Sec.11).
 *
 * Reads only committed local data + the /tmp STRATZ caches used by TZ No.35.
 * Production ranking comes from the canonical getItemPrior() — no new ranking
 * is invented. No enemy draft, no wins-as-cause, no network, no weights,
 * nothing written outside scripts/ and docs/.
 *
 *   node --experimental-strip-types scripts/capability-item-prior-research.mjs all
 */
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';

register('./ts-ext-resolver.mjs', import.meta.url);
const { getItemPrior } = await import('../src/scoring/itemPrior.ts');
const v2 = await import('./stratz-hero-capability-v2-lib.mjs');
const {
  eligibleCells, topKSet, groupItemRates, meanObservedItemScore,
  permutationTest, benjaminiHochberg,
  mulberry32, N_PERMUTATIONS, RESEARCH_SEED, MIN_GROUP_SUPPORT, FDR_Q,
} = await import('./capability-item-prior-lib.mjs');

const STRATZ_CACHE = '/tmp/stratz-ability-properties-research';
const MAPPINGS = '/tmp/stratz-ability-semantic-bridge/confirmed-mappings.json';
const DATA = path.resolve('public/data');
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));

const IDS = [
  'HAS_PHYSICAL_DAMAGE', 'HAS_MAGICAL_DAMAGE', 'HAS_PURE_DAMAGE',
  'HAS_ENEMY_TARGETED', 'HAS_FRIENDLY_TARGETED', 'HAS_BOTH_TARGETED',
];
const POSITIONS = ['1', '2', '3', '4', '5'];

/* ── load ─────────────────────────────────────────────────────────── */

function load() {
  const stratz = read(path.join(STRATZ_CACHE, 'heroes.json'));
  const mappings = read(MAPPINGS);
  const positions = read(path.join(DATA, 'positions.json'));
  const itemStats = read(path.join(DATA, 'item-stats.json'));
  const items = read(path.join(DATA, 'items.json'));
  const heroes = read(path.join(DATA, 'heroes.json'));
  const meta = read(path.join(DATA, 'meta.json'));
  return { stratz, mappings, positions, itemStats, items, heroes, meta };
}

/* ── join: Hero x Position -> { capability profile, ItemPrior order } ── */

function buildCells(data) {
  // TZ No.35 v2 profiles, one per hero (merged in memory; artifact untouched).
  const maps = v2.mergeConfirmedMappings(data.mappings);
  const heroes35 = data.stratz.heroes ?? [];
  const profileById = new Map();
  for (const h of heroes35) {
    profileById.set(h.id, v2.heroCapabilityProfileV2(h.id, h.abilities, maps));
  }
  // Deterministic hero-name lookup from the shipped catalogue.
  const nameById = new Map(data.heroes.map((h) => [h.id, h.name]));

  const dataset = { items: data.items, itemStats: data.itemStats };
  const eligible = eligibleCells(data.positions);
  const cells = [];
  for (const { heroId, position } of eligible) {
    const priors = getItemPrior(dataset, heroId, position);
    cells.push({
      heroId,
      position,
      name: nameById.get(heroId) ?? `#${heroId}`,
      profile: profileById.get(heroId) ?? null,
      order: priors.map((p) => p.itemId),
      scores: new Map(priors.map((p) => [p.itemId, p.score])),
      purchases: new Map(priors.map((p) => [p.itemId, p.purchases])),
    });
  }
  return { maps, cells, profileById };
}

const capState = (profile, capId) => profile?.capabilities?.[capId]?.state ?? 'UNKNOWN';

const shortCap = (id) => id.replace('HAS_', '').replace('_DAMAGE', '(dmg)').replace('_TARGETED', '(tgt)');


/* ── per-stratum analysis ─────────────────────────────────────────── */

/** Small deterministic string hash -> uint32 for per-test RNG streams. */
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * One (capability x position) stratum. UNKNOWN heroes are excluded from THIS
 * comparison only (Sec.3-4) — never coerced to FALSE.
 */
function analyzeStratum(stratumCells, capId, universe) {
  const labels = new Map();
  for (const c of stratumCells) {
    const s = capState(c.profile, capId);
    if (s === 'TRUE' || s === 'FALSE') labels.set(`${c.heroId}@${c.position}`, s);
  }
  const nT = [...labels.values()].filter((s) => s === 'TRUE').length;
  const nF = labels.size - nT;
  if (nT < MIN_GROUP_SUPPORT || nF < MIN_GROUP_SUPPORT) {
    return { supported: false, nT, nF, nU: stratumCells.length - labels.size, top5: [], top10: [], score: [] };
  }
  const keyed = [...stratumCells]
    .filter((c) => labels.has(`${c.heroId}@${c.position}`))
    .sort((a, b) => a.heroId - b.heroId)
    .map((c) => ({ key: `${c.heroId}@${c.position}`, heroId: c.heroId }));
  const stratumTag = `${capId}|pos${stratumCells[0]?.position ?? '?'}`;
  const isTrue = keyed.map((k) => labels.get(k.key) === 'TRUE');
  const byHero = new Map(stratumCells.map((c) => [c.heroId, c]));

  const rateRows = (k) => {
    const cells = keyed.map((kk) => ({ key: kk.key, top: topKSet(byHero.get(kk.heroId).order, k) }));
    const topByKey = new Map(cells.map((cc) => [cc.key, cc.top]));
    const rates = groupItemRates(cells, labels, universe);
    return rates.map((r) => {
      // No group gap: every permutation reproduces stat=0, so p=1 exactly
      // without spending RNG draws (same short-circuit as constant vectors).
      if (!(Math.abs(r.delta) > 0)) return { ...r, p: 1 };
      const vals = keyed.map((kk) => (topByKey.get(kk.key).has(r.itemId) ? 1 : 0));
      const t = permutationTest(vals, isTrue, N_PERMUTATIONS, mulberry32((RESEARCH_SEED + hashStr(`${stratumTag}|top${k}|${r.itemId}`)) >>> 0));
      return { ...r, p: t.p };
    });
  };
  const scoreRows = () => {
    const cells = keyed.map((kk) => ({ key: kk.key, scores: byHero.get(kk.heroId).scores }));
    return meanObservedItemScore(cells, labels, universe).map((r) => {
      if (!Number.isFinite(r.meanT)) return { ...r, p: NaN };
      if (!(Math.abs(r.delta) > 0)) return { ...r, p: 1 };
      const vals = [];
      const lab = [];
      for (const kk of keyed) {
        const s = byHero.get(kk.heroId).scores.get(r.itemId);
        if (Number.isFinite(s)) {
          vals.push(s);
          lab.push(labels.get(kk.key) === 'TRUE');
        }
      }
      const t = permutationTest(vals, lab, N_PERMUTATIONS, mulberry32((RESEARCH_SEED + hashStr(`${stratumTag}|score|${r.itemId}`)) >>> 0));
      return { ...r, p: t.p };
    });
  };
  return {
    supported: true, nT, nF, nU: stratumCells.length - labels.size,
    top5: rateRows(5), top10: rateRows(10), score: scoreRows(),
  };
}

/* ── full run ─────────────────────────────────────────────────────── */

function runAll(built) {
  const byPos = new Map(POSITIONS.map((p) => [p, []]));
  for (const c of built.cells) byPos.get(c.position)?.push(c);
  // Per-position item universe: items present in ANY eligible cell of the lane,
  // sorted ascending — deterministic, no cross-position leakage.
  const universeByPos = new Map();
  for (const p of POSITIONS) {
    const u = new Set();
    for (const c of byPos.get(p)) for (const id of c.order) u.add(id);
    universeByPos.set(p, [...u].sort((a, b) => a - b));
  }
  const strata = [];
  for (const capId of IDS) {
    for (const p of POSITIONS) {
      strata.push({ capId, position: p, ...analyzeStratum(byPos.get(p), capId, universeByPos.get(p)) });
    }
  }
  // Sec.9 — one BH pool per analysis TYPE (positions pooled inside the type).
  const pools = { top5: [], top10: [], score: [] };
  for (const s of strata) {
    if (!s.supported) continue;
    for (const kind of ['top5', 'top10', 'score']) {
      for (const row of s[kind]) {
        if (Number.isFinite(row.p)) pools[kind].push({ key: `${s.capId}|${s.position}|${row.itemId}`, p: row.p });
      }
    }
  }
  const qmap = {};
  for (const kind of ['top5', 'top10', 'score']) {
    for (const e of benjaminiHochberg(pools[kind])) qmap[`${kind}|${e.key}`] = e.q;
  }
  for (const s of strata) {
    for (const kind of ['top5', 'top10', 'score']) {
      for (const row of s[kind]) row.q = qmap[`${kind}|${s.capId}|${s.position}|${row.itemId}`] ?? NaN;
    }
  }
  return { byPos, universeByPos, strata, pools };
}

/* ── report ───────────────────────────────────────────────────────── */

const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : 'n/a');
const fP = (x) => (Number.isFinite(x) ? (x < 0.0005 ? '<0.001' : x.toFixed(3)) : 'n/a');

function sigTable(run, kind, limit, itemName) {
  const rows = [];
  for (const s of run.strata) {
    if (!s.supported) continue;
    for (const r of s[kind]) {
      if (!Number.isFinite(r.q) || r.q >= FDR_Q) continue;
      rows.push({ capId: s.capId, position: s.position, ...r });
    }
  }
  rows.sort((a, b) => a.q - b.q || Math.abs(b.delta) - Math.abs(a.delta));
  return rows.slice(0, limit).map((r) => {
    if (kind === 'score') {
      return `  q=${fP(r.q)} p=${fP(r.p)} ${shortCap(r.capId)} pos${r.position} ${itemName(r.itemId)} T=${f3(r.meanT)} F=${f3(r.meanF)} d=${r.delta >= 0 ? '+' : ''}${f3(r.delta)} n=${r.nT}/${r.nF}`;
    }
    return `  q=${fP(r.q)} p=${fP(r.p)} ${shortCap(r.capId)} pos${r.position} ${itemName(r.itemId)} T=${f3(r.trueRate)} F=${f3(r.falseRate)} d=${r.delta >= 0 ? '+' : ''}${f3(r.delta)} n=${r.nT}/${r.nF}`;
  });
}

function consistency(run, pick) {
  // For each (capability, item) significant anywhere: direction per position
  // + q-values. Same direction across positions >> one big hit.
  const out = [];
  for (const { capId, itemId } of pick) {
    const cells = [];
    for (const p of POSITIONS) {
      const s = run.strata.find((x) => x.capId === capId && x.position === p);
      if (!s?.supported) {
        cells.push(`pos${p}:insuf`);
        continue;
      }
      const parts = [];
      for (const kind of ['top5', 'top10', 'score']) {
        const r = s[kind].find((x) => x.itemId === itemId);
        if (!r || !Number.isFinite(r.q)) parts.push(`${kind}:n/a`);
        else parts.push(`${kind}:${r.delta > 0 ? 'T>F' : r.delta < 0 ? 'T<F' : 'eq'}(q=${fP(r.q)})`);
      }
      cells.push(`pos${p}(n=${s.nT}/${s.nF}):${parts.join(' ')}`);
    }
    out.push(`  ${shortCap(capId)} item:${itemId}\n    ${cells.join('\n    ')}`);
  }
  return out;
}

/* ── signatures (Sec.11, descriptive only) ────────────────────────── */

function signatures(run) {
  const lines = [];
  for (const p of POSITIONS) {
    const groups = new Map();
    for (const c of run.byPos.get(p)) {
      if (!c.profile) continue;
      const sig = v2.capabilitySignatureV2(c.profile);
      if (!groups.has(sig)) groups.set(sig, []);
      groups.get(sig).push(c);
    }
    const big = [...groups.entries()].filter(([, g]) => g.length >= 5)
      .sort((a, b) => b[1].length - a[1].length);
    lines.push(`  pos${p}: ${groups.size} signatures, ${big.length} with >=5 heroes`);
    for (const [sig, g] of big.slice(0, 4)) {
      const freq = new Map();
      for (const c of g) {
        for (const id of c.order.slice(0, 10)) freq.set(id, (freq.get(id) ?? 0) + 1);
      }
      const top = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 5)
        .map(([id, n]) => `${id}:${n}/${g.length}`).join(' ');
      lines.push(`    n=${g.length} top10:{${top}}`);
      lines.push(`    sig=${sig.slice(0, 150)}`);
    }
  }
  return lines;
}

/* ── main report + entry ──────────────────────────────────────────── */

function reportAll(data, built, run) {
  const out = [];
  const p = (s = '') => out.push(s);
  const itemName = (id) => data.items[id]?.dname ?? data.items[id]?.name ?? `item${id}`;

  p('# TZ No.36 — Capability x ItemPrior research');
  p();
  p(`  dataset generatedAt ${data.meta.generatedAt} heroes ${data.meta.heroCount}`);
  p(`  eligible Hero x Position cells ${built.cells.length}`);
  p(`  cells per position ${POSITIONS.map((x) => `pos${x}:${run.byPos.get(x).length}`).join(' ')}`);
  p('  method: TRUE vs FALSE within each position; UNKNOWN excluded per comparison;');
  p(`  top-5/top-10 rates + mean observed score; ${N_PERMUTATIONS} perms seed ${RESEARCH_SEED}; BH FDR ${FDR_Q} per type; support >= ${MIN_GROUP_SUPPORT}.`);
  p();
  p('=== Sec.1 data ===');
  for (const capId of IDS) {
    const counts = { TRUE: 0, FALSE: 0, UNKNOWN: 0 };
    for (const c of built.cells) counts[capState(c.profile, capId)] += 1;
    p(`  ${shortCap(capId).padEnd(16)} TRUE ${counts.TRUE} FALSE ${counts.FALSE} UNKNOWN ${counts.UNKNOWN}`);
  }
  const insuf = run.strata.filter((s) => !s.supported).map((s) => `${shortCap(s.capId)}/pos${s.position}(${s.nT}/${s.nF})`).join(' ');
  p(`  testable strata ${run.strata.filter((s) => s.supported).length}/${run.strata.length}; insufficient: ${insuf || 'none'}`);
  p();
  p('=== Sec.2 method diagnostics ===');
  for (const kind of ['top5', 'top10', 'score']) {
    const pool = run.pools[kind];
    const raw = pool.filter((e) => e.p < 0.05).length;
    // Best row = min q, tie-break by p, then deterministic key order, so the
    // acceptance item "report contains raw + corrected p/q" is satisfied even
    // when nothing reaches q<0.05: the closest hypothesis is named with both.
    let best = null;
    const qs = [];
    for (const s of run.strata) {
      if (!s.supported) continue;
      for (const r of s[kind]) {
        if (!Number.isFinite(r.q) || !Number.isFinite(r.p)) continue;
        qs.push(r.q);
        const key = `${s.capId}|${s.position}|${r.itemId}`;
        if (!best || r.q < best.q - 1e-12 || (Math.abs(r.q - best.q) <= 1e-12 && (r.p < best.p - 1e-12 || (Math.abs(r.p - best.p) <= 1e-12 && key < best.key)))) {
          best = { key, capId: s.capId, position: s.position, itemId: r.itemId, p: r.p, q: r.q };
        }
      }
    }
    qs.sort((a, b) => a - b);
    p(`  ${kind.padEnd(6)} hypotheses ${pool.length} raw-p<0.05 ${raw} min-q ${qs.length ? fP(qs[0]) : 'n/a'}`);
    p(`           best ${best ? `${shortCap(best.capId)}/pos${best.position}/${itemName(best.itemId)} p=${fP(best.p)} q=${fP(best.q)}` : 'n/a'}`);
  }
  p();
  p('=== Sec.3 top-5 significant (q<0.05) ===');
  const t5 = sigTable(run, 'top5', 15, itemName);
  p(t5.length ? t5.join('\n') : '  none');
  p();
  p('=== Sec.4 top-10 significant (q<0.05) ===');
  const t10 = sigTable(run, 'top10', 15, itemName);
  p(t10.length ? t10.join('\n') : '  none');
  p();
  p('=== Sec.5 score significant (q<0.05) ===');
  const sc = sigTable(run, 'score', 15, itemName);
  p(sc.length ? sc.join('\n') : '  none');
  p();
  p('=== Sec.6 cross-position consistency ===');
  const pickKeys = new Map();
  for (const s of run.strata) {
    if (!s.supported) continue;
    for (const kind of ['top5', 'top10', 'score']) {
      for (const r of s[kind]) {
        if (Number.isFinite(r.q) && r.q < FDR_Q) {
          const k = `${s.capId}|${r.itemId}`;
          if (!pickKeys.has(k)) pickKeys.set(k, { capId: s.capId, itemId: r.itemId });
        }
      }
    }
  }
  const cons = consistency(run, [...pickKeys.values()].slice(0, 12));
  p(cons.length ? cons.join('\n') : '  no significant findings to cross-check');
  p();
  p('=== Sec.7 full signatures (descriptive, groups >= 5) ===');
  p(signatures(run).join('\n'));
  p();
  p('=== Sec.8 limitations ===');
  p('  ItemPrior is a statistical prior, not a causal build effect; top-K is');
  p('  ranking membership, not ownership probability; score only where the item');
  p('  row exists (never zero-filled); capability repeats per hero across that');
  p('  hero eligible positions (pseudoreplication — hence stratification as');
  p('  primary, no pooled primary); no enemy conditioning in this TZ.');
  p();
  p('=== Sec.9 verdict ===');
  let sigKinds = 0;
  for (const kind of ['top5', 'top10', 'score']) {
    if (run.strata.some((s) => s.supported && s[kind].some((r) => Number.isFinite(r.q) && r.q < FDR_Q))) sigKinds += 1;
  }
  p(`  ${sigKinds === 0 ? 'NO_ROBUST_CAPABILITY_ITEM_SIGNAL' : `hits in ${sigKinds}/3 types — see consistency above before any follow-up`}`);
  p('  (No production recommendation follows from this experiment by design.)');
  console.log(out.join('\n'));
}

function main() {
  const mode = process.argv[2] ?? 'all';
  if (mode !== 'all') {
    process.stderr.write(`unknown mode ${mode}; only 'all' is supported\n`);
    process.exit(1);
  }
  try {
    const data = load();
    const built = buildCells(data);
    reportAll(data, built, runAll(built));
  } catch (e) {
    process.stderr.write(`${e?.message ?? e}\n`);
    process.exit(1);
  }
}

main();
