/**
 * TZ No.37 — Item x Enemy uplift research (offline, existing corpus only).
 *
 * Pipeline (fixed BEFORE the run):
 *
 *   grain: Match x PlayerSlot x Item x EnemyHero, ownership-at-end 0/1
 *     -> exposed composition per (item x enemy)
 *     -> composition-weighted baseline E[Item | MyHero, Position]
 *     -> raw delta/lift -> EB shrinkage -> Clopper-Pearson interval
 *     -> Hero x Position-stratified permutation (seed 20261006, N=2000)
 *     -> BH FDR q=0.05, ONE pool -> split-half stability -> verdict
 *
 * Corpus: /tmp/opendota-level2-pilot/bridge.json (400 rank-filtered public
 * matches bridged to STRATZ; TZ No.28). NO network calls. Reads
 * public/data/items.json + positions.json as catalogue/gate only.
 * Writes nothing outside stdout/stderr. Production untouched.
 *
 *   node scripts/item-enemy-uplift-research.mjs [all|sparsity|uplift|probes|stability|determinism]
 */
import { readFileSync } from 'node:fs';
import {
  N_PERMUTATIONS, RESEARCH_SEED, FDR_Q, SUPPORT, GRAIN_DECISION,
  UPLIFT_VERDICTS,
  mulberry32, benjaminiHochberg,
  slotObservations, weightedBaseline, rawUplift, hpPriorStrength,
  shrinkRate, clopperPearson, upliftPermutationTest, supportTier,
  splitHalf, decideUpliftVerdict,
  eligibleHpSet, positionGateDropReason,
} from './item-enemy-uplift-lib.mjs';

const BRIDGE = '/tmp/opendota-level2-pilot/bridge.json';
const ITEMS = 'public/data/items.json';
const POSITIONS = 'public/data/positions.json';
const HEROES = 'public/data/heroes.json';

const POSITIONS_1TO5 = ['1', '2', '3', '4', '5'];
const STRATZ_POS = { POSITION_1: '1', POSITION_2: '2', POSITION_3: '3', POSITION_4: '4', POSITION_5: '5' };

const CANONICAL_PROBES = [
  { itemDname: 'item_black_king_bar', enemy: 'Phantom Assassin', why: 'canonical magic-immunity answer to PA burst' },
  { itemDname: 'item_monkey_king_bar', enemy: 'Phantom Assassin', why: 'canonical anti-evasion answer to PA blur' },
  { itemDname: 'item_silver_edge', enemy: 'Bristleback', why: 'canonical break answer to Bristle passives' },
  { itemDname: 'item_nullifier', enemy: 'Windranger', why: 'canonical mute/dispel probe vs mobile core' },
  { itemDname: 'item_blink', enemy: 'Sniper', why: 'canonical gap-close probe vs backline' },
];

/* ── corpus ─────────────────────────────────────────────────────────── */

function loadCorpus() {
  const bridge = JSON.parse(readFileSync(BRIDGE, 'utf8'));
  const items = JSON.parse(readFileSync(ITEMS, 'utf8'));
  const positions = JSON.parse(readFileSync(POSITIONS, 'utf8'));
  const heroes = JSON.parse(readFileSync(HEROES, 'utf8'));
  return { bridge, items, positions, heroes };
}

/** Catalogue gate for the PRIMARY analysis (TZ Sec.2, grain verbatim). */
function primaryItemSet(items) {
  const set = new Set();
  for (const [rawId, e] of Object.entries(items ?? {})) {
    const id = Number(rawId);
    if (!Number.isFinite(id)) continue;
    if (e?.isPurchasable === false) continue;
    if (e?.isStackable === true) continue;
    if ((e?.cost ?? 1) <= 0) continue;
    set.add(id);
  }
  return set;
}

function heroName(items, id) {
  return items?.[String(id)]?.dname ?? items?.[String(id)]?.name ?? `item:${id}`;
}

/**
 * Build usable slots from bridged matches. Fail-closed at every step:
 * match not ok / position not full / roster not exact / non-5v5 /
 * Hero x Position not production-eligible / incomplete slot -> dropped
 * with a counted reason, never imputed. The position gate runs BEFORE the
 * slot can enter exposure, background rates, baseline or permutation
 * strata (No.37 audit blocker fix).
 */
function buildSlots(bridge, eligibleHp) {
  if (!(eligibleHp instanceof Set)) throw new Error('POSITION_GATE_MISSING');
  const slots = [];
  const dropReasons = {};
  const drop = (reason) => { dropReasons[reason] = (dropReasons[reason] ?? 0) + 1; };
  let matchesUsed = 0;
  for (const m of bridge ?? []) {
    if (!m?.ok) { drop('MATCH_NOT_OK'); continue; }
    if (m.positionClass !== 'POSITION_FULL') { drop('POSITION_NOT_FULL'); continue; }
    if (!m.rosterExact) { drop('ROSTER_NOT_EXACT'); continue; }
    const players = m.players ?? [];
    const rad = players.filter((p) => p.isRadiant);
    const dire = players.filter((p) => !p.isRadiant);
    if (rad.length !== 5 || dire.length !== 5) { drop('NON_5V5'); continue; }
    const foeOf = (p) => (p.isRadiant ? dire : rad).map((q) => q.heroId);
    let used = false;
    for (const p of players) {
      const pos = STRATZ_POS[p.position] ?? null;
      if (!pos) { drop('UNKNOWN_POSITION_LABEL'); continue; }
      // Production position gate: an ineligible Hero x Position never
      // reaches exposure / hpRate / baseline / permutation strata.
      const gate = positionGateDropReason(eligibleHp, p.heroId, pos);
      if (gate) { drop(gate); continue; }
      const inv = [];
      for (const k of ['item0Id', 'item1Id', 'item2Id', 'item3Id', 'item4Id', 'item5Id', 'backpack0Id', 'backpack1Id', 'backpack2Id']) {
        const v = p[k];
        if (Number.isFinite(v)) inv.push(v);
      }
      const { observations, dropped } = slotObservations({
        matchId: m.matchId, heroId: p.heroId, position: pos,
        isRadiant: p.isRadiant, inventory: inv, foes: foeOf(p),
      });
      if (dropped) { drop(dropped.reason); continue; }
      used = true;
      slots.push({
        matchId: m.matchId, heroId: p.heroId, position: pos, foes: foeOf(p),
        half: splitHalf(m.matchId), owned: new Set(inv), observations,
      });
    }
    if (used) matchesUsed += 1;
  }
  return { slots, dropReasons, matchesUsed };
}

/* position gate (eligibleHpSet) lives in item-enemy-uplift-lib.mjs */

/* ── analysis core (shared by all report commands) ──────────────────── */

/**
 * Per-item background: Hero x Position ownership rates over the SAME slots
 * (same grain, same corpus). The background is the pool against which each
 * enemy cell is compared, composition-weighted.
 */
function buildBackground(slots, primarySet) {
  const hpSlots = new Map(); // hp -> slot indices
  const itemHp = new Map();  // itemId -> Map(hp -> owners)
  const exposure = new Map(); // enemyId -> slot indices
  slots.forEach((s, i) => {
    const hp = `${s.heroId}|${s.position}`;
    if (!hpSlots.has(hp)) hpSlots.set(hp, []);
    hpSlots.get(hp).push(i);
    for (const f of new Set(s.foes ?? [])) {
      if (!exposure.has(f)) exposure.set(f, []);
      exposure.get(f).push(i);
    }
    for (const id of s.owned) {
      if (!primarySet.has(id)) continue;
      if (!itemHp.has(id)) itemHp.set(id, new Map());
      const m = itemHp.get(id);
      m.set(hp, (m.get(hp) ?? 0) + 1);
    }
  });
  const hpRate = new Map(); // itemId -> Map(hp -> rate)
  for (const [id, m] of itemHp) {
    const rm = new Map();
    for (const [hp, idx] of hpSlots) rm.set(hp, (m.get(hp) ?? 0) / idx.length);
    hpRate.set(id, rm);
  }
  return { hpSlots, hpRate, exposure };
}

/** Exposed slot indices per enemy hero (delegates to the background map). */
function buildExposure(slots) {
  return buildBackground(slots, new Set()).exposure;
}

function rateOf(slots, idx, itemId) {
  let k = 0;
  for (const i of idx) if (slots[i].owned.has(itemId)) k += 1;
  return { k, n: idx.length };
}

/**
 * Full inference for one (item, enemy) cell. Returns a row with a tier tag;
 * EXCLUDED / UNCOVERED_BASELINE rows carry no inference numbers and never
 * enter BH or the verdict numerator.
 *
 * No.37 core-audit fixes:
 *  - FAIL-CLOSED partial baseline: covered !== nExposed also returns
 *    UNCOVERED_BASELINE (observed and expected must be ONE population).
 *  - Hero x Position-STRATIFIED permutation: labels shuffle only inside each
 *    stratum with that stratum's exposed count fixed; statistic is the
 *    composition-weighted gap (== raw delta).
 *  - Background cap PER stratum: 4 x that stratum's exposed count — never a
 *    global slice, so no stratum can crowd another out of the null pool.
 *  - No background at all -> p = NaN (never a fabricated statistic).
 */
function inferCell(itemId, enemyId, slots, bg, m0ByItem, rng) {
  const expIdx = bg.exposure.get(enemyId) ?? [];
  const tier = supportTier(expIdx.length);
  if (tier === 'EXCLUDED') return { tier, nExposed: expIdx.length };
  const { k, n } = rateOf(slots, expIdx, itemId);
  const pObs = k / n;
  const comp = expIdx.map((i) => ({ hp: `${slots[i].heroId}|${slots[i].position}` }));
  const hpRate = bg.hpRate.get(itemId) ?? new Map();
  const wb = weightedBaseline(comp, hpRate);
  // Fail-closed: full AND partial baseline misses are the same population error.
  if (!Number.isFinite(wb.expected) || wb.covered !== wb.n) {
    return { tier: 'UNCOVERED_BASELINE', nExposed: n, covered: wb.covered };
  }
  const raw = rawUplift(k, n, wb.expected);
  const m0 = m0ByItem.get(itemId) ?? 60;
  const sh = shrinkRate(k, n, wb.expected, m0);
  const ci = clopperPearson(k, n);

  // One permutation stratum per Hero x Position composition (sorted keys);
  // background candidates capped at 4 x THIS stratum's exposed count.
  const expByHp = new Map();
  for (const i of expIdx) {
    const hp = `${slots[i].heroId}|${slots[i].position}`;
    if (!expByHp.has(hp)) expByHp.set(hp, []);
    expByHp.get(hp).push(i);
  }
  const strata = [];
  let nBackground = 0;
  for (const hp of [...expByHp.keys()].sort()) {
    const expList = expByHp.get(hp);
    const expSet = new Set(expList);
    const bgList = [];
    for (const i of (bg.hpSlots.get(hp) ?? [])) {
      if (expSet.has(i)) continue;
      if (bgList.length >= 4 * expList.length) break;
      bgList.push(i);
    }
    nBackground += bgList.length;
    const values = [];
    const isExposed = [];
    for (const i of expList) {
      values.push(slots[i].owned.has(itemId) ? 1 : 0);
      isExposed.push(true);
    }
    for (const i of bgList) {
      values.push(slots[i].owned.has(itemId) ? 1 : 0);
      isExposed.push(false);
    }
    strata.push({ values, isExposed, baseline: hpRate.get(hp) });
  }

  // Split-half stability on the shrunk delta sign.
  const halves = { A: { k: 0, n: 0 }, B: { k: 0, n: 0 } };
  for (const i of expIdx) {
    const h = slots[i].half;
    halves[h].n += 1;
    if (slots[i].owned.has(itemId)) halves[h].k += 1;
  }
  const halfDelta = {};
  for (const h of ['A', 'B']) {
    if (halves[h].n === 0) { halfDelta[h] = NaN; continue; }
    halfDelta[h] = shrinkRate(halves[h].k, halves[h].n, wb.expected, m0).shrunkDelta;
  }

  const p = nBackground > 0
    ? upliftPermutationTest(strata, N_PERMUTATIONS, rng).p
    : NaN;
  return {
    tier, nExposed: n, kExposed: k, pObs, expected: wb.expected,
    covered: wb.covered, rawDelta: raw.delta, rawLift: raw.lift,
    m0, shrunk: sh.shrunk, shrunkDelta: sh.shrunkDelta, ciLo: ci.lo, ciHi: ci.hi,
    p, halfDeltaA: halfDelta.A, halfDeltaB: halfDelta.B,
  };
}

/** Run inference over the full (primary item x observed enemy) grid. */
function runGrid(slots, bg, primaryIds, enemies) {
  const m0ByItem = new Map();
  for (const id of primaryIds) {
    m0ByItem.set(id, hpPriorStrength([...(bg.hpRate.get(id) ?? new Map()).values()]).m0);
  }
  const rng = mulberry32(RESEARCH_SEED);
  const rows = [];
  let uncovered = 0;
  for (const enemyId of enemies) {
    for (const itemId of primaryIds) {
      const r = inferCell(itemId, enemyId, slots, bg, m0ByItem, rng);
      if (!r || r.tier === 'EXCLUDED' || r.tier === 'UNCOVERED_BASELINE') {
        if (r?.tier === 'UNCOVERED_BASELINE') uncovered += 1;
        continue;
      }
      rows.push({ itemId, enemyId, ...r });
    }
  }
  return { rows, m0ByItem, uncovered };
}
/* ── report helpers ───────────────────────────────────────────────── */

function fmtPct(x, digits = 1) {
  return Number.isFinite(x) ? `${(100 * x).toFixed(digits)}%` : 'n/a';
}
function fmtP(x) {
  if (!Number.isFinite(x)) return 'n/a';
  return x < 0.001 ? '<0.001' : x.toFixed(3);
}
function enemyName(heroes, id) {
  const h = (heroes ?? []).find((x) => x.id === id);
  return h?.name ?? `hero:${id}`;
}

function sectionCorpus(p, ctx) {
  const { bridge, slots, dropReasons, matchesUsed, primaryIds, enemies } = ctx;
  p('=== Sec.1 Corpus & grain ===');
  p('');
  p(`  matches in bridge file          ${bridge.length}`);
  p(`  matches used (all gates pass)   ${matchesUsed}`);
  p(`  usable slots                    ${slots.length}`);
  p(`  primary items                   ${primaryIds.length}`);
  p(`  distinct enemies faced          ${enemies.length}`);
  const halves = { A: 0, B: 0 };
  for (const s of slots) halves[s.half] += 1;
  p(`  split-half slots                A=${halves.A} B=${halves.B}`);
  p('  drop reasons (fail-closed, never imputed):');
  for (const [k, v] of Object.entries(dropReasons).sort((a, b) => b[1] - a[1])) {
    p(`    ${k}: ${v}`);
  }
  p('');
  p('  GRAIN (verbatim, fixed BEFORE numbers):');
  for (const [k, v] of Object.entries(GRAIN_DECISION)) p(`    ${k}: ${v}`);
  p('');
}

function sectionSparsityCounted(p, total, tested, primary, explor, ns) {
  p('=== Sec.2 Sparsity audit ===');
  p('');
  p(`  (item x enemy) cells total       ${total}`);
  p(`  cells reaching inference        ${tested} (${fmtPct(tested / total)})`);
  p(`  PRIMARY (N>=${SUPPORT.PRIMARY})              ${primary}`);
  p(`  EXPLORATORY (N=${SUPPORT.EXPLORATORY}..${SUPPORT.PRIMARY - 1})    ${explor}`);
  p(`  EXCLUDED (N<${SUPPORT.EXPLORATORY})              ${total - tested}`);
  if (ns.length) {
    const q = (f) => ns[Math.min(ns.length - 1, Math.floor(f * ns.length))];
    p(`  N_exposed over tested cells     min=${ns[0]} p50=${q(0.5)} p90=${q(0.9)} max=${ns[ns.length - 1]}`);
  }
  p('');
  if (primary > 0) {
    p('  Reading: PRIMARY cells are the only tier allowed to carry a verdict;');
    p('  the marginal grain supports inference and Sec.4 decides feasibility.');
  } else {
    p('  Verdict-relevant reading: with zero PRIMARY cells the Item x Enemy');
    p('  marginal grain cannot support a production adjustment.');
  }
  p('');
}

function bestOf(rows) {
  let best = null;
  for (const r of rows) {
    if (!Number.isFinite(r.q)) continue;
    const key = [r.q, r.p, r.enemyId, r.itemId];
    const bkey = best ? [best.q, best.p, best.enemyId, best.itemId] : null;
    let less = !best;
    if (best) {
      less = key[0] < bkey[0] || (key[0] === bkey[0] && (key[1] < bkey[1]
        || (key[1] === bkey[1] && (key[2] < bkey[2] || (key[2] === bkey[2] && key[3] < bkey[3])))));
    }
    if (less) best = r;
  }
  return best;
}

function sectionMethod(p) {
  p('=== Sec.3 Method ===');
  p('');
  p('  baseline: composition-weighted E[Item | MyHero, Position] over the');
  p('    exposed Hero x Position mix (same grain, same corpus, same filters).');
  p('  shrinkage: empirical-Bayes Beta-Binomial posterior mean toward the');
  p('    weighted baseline; prior strength m0 in [8, 200] via method of moments');
  p("    on this item's Hero x Position rate dispersion.");
  p('  interval: 95% Clopper-Pearson CI for the OBSERVED ownership rate');
  p('    — NOT a CI for the uplift itself.');
  p('  test: Hero x Position-stratified permutation — labels shuffle only');
  p('    inside each Hero x Position stratum with its exposed count fixed;');
  p(`    statistic = composition-weighted gap; N=${N_PERMUTATIONS}, seed=${RESEARCH_SEED}.`);
  p(`  correction: Benjamini-Hochberg FDR q=${FDR_Q}, ONE pool over all`);
  p('    tested (item x enemy) cells. Stability: deterministic split-half');
  p('    (even/odd matchId) on the shrunk-delta sign.');
  p('');
}

function rowLine(r, ctx, withQ) {
  const item = heroName(ctx.catalogue, r.itemId);
  const foe = enemyName(ctx.heroes, r.enemyId);
  return `${item} vs ${foe}: N=${r.nExposed} K=${r.kExposed} pObs=${fmtPct(r.pObs)}`
    + ` pExp=${fmtPct(r.expected)} raw=${r.rawDelta >= 0 ? '+' : ''}${(100 * r.rawDelta).toFixed(1)}pp`
    + ` shrunk=${r.shrunkDelta >= 0 ? '+' : ''}${(100 * r.shrunkDelta).toFixed(1)}pp`
    + ` CI=[${fmtPct(r.ciLo)}, ${fmtPct(r.ciHi)}]`
    + ` p=${fmtP(r.p)}${withQ ? ` q=${fmtP(r.q)}` : ''}`;
}

function sectionUplift(p, ctx) {
  const { rows } = ctx;
  const withQ = rows.filter((r) => Number.isFinite(r.q));
  const sig = withQ.filter((r) => r.q < FDR_Q);
  p('=== Sec.4 Uplift (tested cells only) ===');
  p('');
  p(`  hypotheses in BH pool          ${withQ.length}`);
  p(`  fail-closed UNCOVERED_BASELINE ${ctx.uncovered ?? 'n/a'} (excluded before BH, never imputed)`);
  p(`  raw-p<0.05                     ${withQ.filter((r) => r.p < 0.05).length}`);
  p(`  q<${FDR_Q} (FDR-significant)           ${sig.length}`);
  const best = bestOf(rows);
  p(best ? `  best: ${rowLine(best, ctx, true)}` : '  best: none (no finite q in pool)');
  const top = [...withQ].sort((a, b) => a.q - b.q || a.p - b.p).slice(0, 10);
  if (top.length) {
    p('  top-10 by q (raw+shrunk+interval+p/q, as-is):');
    for (const r of top) p(`    ${rowLine(r, ctx, true)}`);
  }
  p('');
}

function sectionProbes(p, ctx) {
  const { slots, bg, m0ByItem, catalogue, heroes } = ctx;
  p('=== Sec.5 Canonical probes (as-is, including zeros) ===');
  p('');
  const rng = mulberry32(RESEARCH_SEED);
  for (const probe of CANONICAL_PROBES) {
    const found = Object.entries(catalogue).find(([, e]) => e?.dname === probe.itemDname);
    const itemId = found ? Number(found[0]) : NaN;
    let enemyId = NaN;
    const foe = (heroes ?? []).find((x) => x.name === probe.enemy);
    if (foe) enemyId = foe.id;
    if (!Number.isFinite(itemId) || !Number.isFinite(enemyId)) {
      p(`  ${probe.itemDname} vs ${probe.enemy}: NOT FOUND (${probe.why})`);
      continue;
    }
    const r = inferCell(itemId, enemyId, slots, bg, m0ByItem, rng);
    if (!r || r.tier === 'EXCLUDED' || r.tier === 'UNCOVERED_BASELINE') {
      p(`  ${probe.itemDname} vs ${probe.enemy}: tier=${r?.tier ?? 'N/A'}`
        + ` N=${r?.nExposed ?? 0} -- no inference (${probe.why})`);
      continue;
    }
    p(`  ${rowLine({ itemId, enemyId, ...r }, ctx, false)}  [${probe.why}]`);
  }
  p('');
}

function sectionStability(p, ctx) {
  const { rows } = ctx;
  let agree = 0;
  let disagree = 0;
  let missing = 0;
  for (const r of rows) {
    if (!Number.isFinite(r.halfDeltaA) || !Number.isFinite(r.halfDeltaB)
      || r.halfDeltaA === 0 || r.halfDeltaB === 0) {
      missing += 1;
      continue;
    }
    if (Math.sign(r.halfDeltaA) === Math.sign(r.halfDeltaB)) agree += 1;
    else disagree += 1;
  }
  p('=== Sec.6 Stability (split-half sign agreement) ===');
  p('');
  p(`  tested cells                    ${rows.length}`);
  p(`  halves agree on shrunk sign     ${agree}`);
  p(`  halves disagree                 ${disagree}`);
  p(`  half empty/degenerate           ${missing}`);
  p('');
  p(`  primary cells in pool           ${rows.filter((r) => r.tier === 'PRIMARY').length}`);
  p('  Reading: half-agreement alone is diagnostic; it is only claimed in');
  p('  combination with FDR-significant primary cells (Sec.7 verdict).');
  p('');
}

function sectionVerdict(p, ctx) {
  const { rows } = ctx;
  const nPrimary = rows.filter((r) => r.tier === 'PRIMARY').length;
  const nSig = rows.filter((r) => Number.isFinite(r.q) && r.q < FDR_Q).length;
  const nExplorSig = rows.filter((r) => r.tier !== 'PRIMARY' && Number.isFinite(r.q) && r.q < FDR_Q).length;
  const nPrimarySig = rows.filter((r) => r.tier === 'PRIMARY' && Number.isFinite(r.q) && r.q < FDR_Q).length;
  let agree = 0;
  for (const r of rows) {
    if (r.tier !== 'PRIMARY' || !Number.isFinite(r.q) || r.q >= FDR_Q) continue;
    if (Number.isFinite(r.halfDeltaA) && Number.isFinite(r.halfDeltaB)
      && r.halfDeltaA !== 0 && r.halfDeltaB !== 0
      && Math.sign(r.halfDeltaA) === Math.sign(r.halfDeltaB)) agree += 1;
  }
  const v = decideUpliftVerdict({ primaryCells: nPrimary, stableHits: agree, exploratoryHits: nExplorSig });
  p('=== Sec.7 Limitations ===');
  p('');
  p('  corpus bias: 400 rank-filtered public matches (Herald-Archon heavy),');
  p('    Turbo over-represented; not the full ranked population.');
  p("  enemy position not conditioned: the foe's lane is ignored by design");
  p('    (marginal single-enemy analysis).');
  p('  mirror rule: a mirror match is a LEGAL exposed observation — the');
  p('    mirrored hero as enemy counts (GRAIN_DECISION, no exclusion).');
  p('  patch drift: single bridge snapshot; no cross-patch claim.');
  p('  ownership-at-end conflates planned buys with post-hoc pickup; the');
  p('    post-hoc confound (No.23: ~32% late entries) applies in full.');
  p('  baseline is corpus-internal: uplift is relative to THIS corpus, not to');
  p('    the shipped ItemPrior aggregates (different grain, Sec.3).');
  p('');
  p('=== Sec.8 Verdict ===');
  p('');
  p(`  ${v}`);
  p(`  primary / primary-significant / tested: ${nPrimary} / ${nPrimarySig} / ${rows.length}`);
  p('');
}

/* ── main ───────────────────────────────────────────────────────────── */

function reportAll(mode) {
  const out = [];
  const p = (s = '') => out.push(s);
  const { bridge, items, positions, heroes } = loadCorpus();
  const built = buildSlots(bridge, eligibleHpSet(positions));
  const slots = built.slots;
  const primarySet = primaryItemSet(items);
  const primaryIds = [...primarySet].sort((a, b) => a - b);
  const bg = buildBackground(slots, primarySet);
  const enemies = [...new Set(slots.flatMap((s) => [...s.foes]))].sort((a, b) => a - b);
  const ctx = {
    bridge, catalogue: items, positions, heroes, slots,
    dropReasons: built.dropReasons, matchesUsed: built.matchesUsed,
    bg, m0ByItem: new Map(), rows: [], enemies, primaryIds,
  };
  p('# TZ No.37 -- Item x Enemy uplift (pooled, Hero+Position-controlled)');
  p('');
  if (mode === 'all' || mode === 'sparsity') {
    sectionCorpus(p, ctx);
    const exposure = buildExposure(slots);
    let tested = 0;
    let nPrimary = 0;
    let nExplor = 0;
    const ns = [];
    for (const e of enemies) {
      const n = (exposure.get(e) ?? []).length;
      for (const _id of primaryIds) {
        const t = supportTier(n);
        if (t === 'EXCLUDED') continue;
        tested += 1;
        ns.push(n);
        if (t === 'PRIMARY') nPrimary += 1;
        else nExplor += 1;
      }
    }
    ns.sort((a, b) => a - b);
    sectionSparsityCounted(p, enemies.length * primaryIds.length, tested, nPrimary, nExplor, ns);
    if (mode === 'sparsity') {
      console.log(out.join('\n'));
      return;
    }
  }
  const grid = runGrid(slots, bg, primaryIds, enemies);
  ctx.rows = grid.rows;
  ctx.m0ByItem = grid.m0ByItem;
  ctx.uncovered = grid.uncovered;
  const pool = ctx.rows.filter((r) => Number.isFinite(r.p))
    .map((r) => ({ key: `${r.enemyId}:${r.itemId}`, p: r.p }));
  const corrected = benjaminiHochberg(pool);
  const qByKey = new Map(corrected.map((c) => [c.key, c.q]));
  for (const r of ctx.rows) r.q = qByKey.get(`${r.enemyId}:${r.itemId}`);
  if (mode === 'all' || mode === 'uplift') {
    if (mode === 'uplift') sectionCorpus(p, ctx);
    sectionMethod(p);
    sectionUplift(p, ctx);
  }
  if (mode === 'all' || mode === 'probes') sectionProbes(p, ctx);
  if (mode === 'all' || mode === 'stability') sectionStability(p, ctx);
  if (mode === 'all') sectionVerdict(p, ctx);
  if (mode === 'determinism') {
    sectionCorpus(p, ctx);
    p('determinism: same seed must give byte-identical output;');
    p('RNG streams are created per cell in (enemy, item) grid order.');
    p('');
  }
  console.log(out.join('\n'));
}

function main() {
  const mode = process.argv[2] ?? 'all';
  const allowed = new Set(['all', 'sparsity', 'uplift', 'probes', 'stability', 'determinism']);
  if (!allowed.has(mode)) {
    process.stderr.write(`unknown mode ${mode}; want one of ${[...allowed].join('|')}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    reportAll(mode);
  } catch (e) {
    process.stderr.write(`${e?.message ?? e}\n`);
    process.exitCode = 1;
  }
}

main();

