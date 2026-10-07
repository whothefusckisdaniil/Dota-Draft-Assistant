#!/usr/bin/env node
/**
 * ТЗ §35 — capability profile v2 after the confirmed `0 = NONE`.
 *
 * Question: does the §34-confirmed zero semantics materially change the
 * tri-state profiles — real FALSEs, more signatures, less redundancy — or does
 * it merely complete the domain without adding discrimination?
 *
 * This repeats the §33 measurement over the FULL confirmed domain and
 * compares the two directly. It never re-decides a mapping: §32 CONFIRMED
 * entries plus the §34 ZERO_SEMANTICS verdict are merged in memory by a pure
 * helper, and `confirmed-mappings.json` stays byte-identical.
 *
 * Research only — reads `public/data/positions.json` for §17 but writes
 * nothing; no src/, no engine.ts, no match results / itemStats / matchups
 * (§18), no weights (§19), no network I/O.
 *
 *   node scripts/stratz-hero-capability-v2-research.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  EXPECTED_RAW_DOMAIN,
  mergeConfirmedMappings, heroCapabilityProfileV2, capabilityDistributionV2,
  capabilityRedundancyV2,
  domainAudit, heroDimensionCoverage, falseAvailability,
  pairUniqueness, signatureGroups, largestSignatureShare, topKSignatureShare,
  positionIntersection, capabilityVerdictV2,
} from './stratz-hero-capability-v2-lib.mjs';

const STRATZ_CACHE = '/tmp/stratz-ability-properties-research';
const MAPPINGS = '/tmp/stratz-ability-semantic-bridge/confirmed-mappings.json';
const POSITIONS = 'public/data/positions.json';

const DAMAGE_CAPS = ['HAS_PHYSICAL_DAMAGE', 'HAS_MAGICAL_DAMAGE', 'HAS_PURE_DAMAGE'];
const TARGET_CAPS = ['HAS_ENEMY_TARGETED', 'HAS_FRIENDLY_TARGETED', 'HAS_BOTH_TARGETED'];
const IDS = [...DAMAGE_CAPS, ...TARGET_CAPS];

const REDUNDANCY_PAIRS = [
  ['HAS_MAGICAL_DAMAGE', 'HAS_ENEMY_TARGETED'],
  ['HAS_PHYSICAL_DAMAGE', 'HAS_MAGICAL_DAMAGE'],
  ['HAS_PHYSICAL_DAMAGE', 'HAS_PURE_DAMAGE'],
  ['HAS_ENEMY_TARGETED', 'HAS_FRIENDLY_TARGETED'],
  ['HAS_ENEMY_TARGETED', 'HAS_BOTH_TARGETED'],
  ['HAS_FRIENDLY_TARGETED', 'HAS_BOTH_TARGETED'],
];

const UNIQUENESS_PAIRS = [
  ['HAS_PHYSICAL_DAMAGE', 'HAS_MAGICAL_DAMAGE'],
  ['HAS_MAGICAL_DAMAGE', 'HAS_ENEMY_TARGETED'],
  ['HAS_ENEMY_TARGETED', 'HAS_FRIENDLY_TARGETED'],
  ['HAS_ENEMY_TARGETED', 'HAS_BOTH_TARGETED'],
  ['HAS_FRIENDLY_TARGETED', 'HAS_BOTH_TARGETED'],
  ['HAS_PHYSICAL_DAMAGE', 'HAS_PURE_DAMAGE'],
];

const BENCHMARKS = ['Anti-Mage', 'Sniper', 'Wraith King', 'Puck', 'Kunkka', 'Bane', 'Lion', 'Silencer', 'Tusk'];

function load() {
  for (const f of [`${STRATZ_CACHE}/heroes.json`, MAPPINGS]) {
    if (!existsSync(f)) throw new Error(`missing ${f}; run the §31/§32 research first`);
  }
  return {
    stratz: JSON.parse(readFileSync(`${STRATZ_CACHE}/heroes.json`, 'utf8')),
    mappings: JSON.parse(readFileSync(MAPPINGS, 'utf8')),
    positions: existsSync(POSITIONS) ? JSON.parse(readFileSync(POSITIONS, 'utf8')) : null,
  };
}

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');
const fmtRow = (a, b, c) => `${String(a).padStart(5)} ${String(b).padStart(5)} ${String(c).padStart(7)}`;

/** Raw-value histogram per dimension, straight from the ability rows. */
function rawRows(heroes, dimension) {
  const out = [];
  for (const h of heroes) {
    for (const a of h.abilities ?? []) {
      const stat = a?.ability?.stat;
      out.push(stat ? (stat[dimension] ?? null) : null);
    }
  }
  return out;
}

/** §10 — per-hero completeness on one dimension. */
function completeness(heroes, map, dimension) {
  const complete = [];
  const incomplete = [];
  for (const h of heroes) {
    const c = heroDimensionCoverage(h.abilities, map, dimension);
    (c.complete ? complete : incomplete).push({ hero: h.displayName, ...c });
  }
  return { complete, incomplete };
}

/* ─────────────────────────────── report ─────────────────────────────── */

function sectionDomain(p, ctx) {
  p('=== Semantic domain ===');
  p();
  p('  runtime maps (in-memory merge, §32 artifact untouched):');
  p(`    unitDamageType  ${ctx.maps35.unitDamageType.size} entries  ${[...ctx.maps35.unitDamageType].map(([r, s]) => `${r}→${s}`).join('  ')}`);
  p(`    unitTargetTeam  ${ctx.maps35.unitTargetTeam.size} entries  ${[...ctx.maps35.unitTargetTeam].map(([r, s]) => `${r}→${s}`).join('  ')}`);
  p();
  for (const dim of ['unitDamageType', 'unitTargetTeam']) {
    const a = ctx.audits[dim];
    p(`  ${dim}:`);
    p(`    raw values observed   ${Object.entries(a.observed).map(([k, v]) => `${k}:${v}`).join('  ')}`);
    p(`    mapped                ${a.mapped}/${a.total}  (${pct(a.mapped, a.total)})`);
    p(`    unknown values        ${Object.keys(a.unknown).length ? JSON.stringify(a.unknown) : 'none'}`);
    p(`    field-missing         ${a.missing}`);
    p(`    status                ${a.status}`);
    p();
  }
  const anyUnmapped = ['unitDamageType', 'unitTargetTeam'].some((d) => ctx.audits[d].status !== 'COMPLETE');
  p(`  UNMAPPED_RAW_VALUE detected: ${anyUnmapped ? 'YES — mapping completeness stopped' : 'no'}`);
  p("  Expected domain fixed from §2 BEFORE the run; observed STRATZ raws");
  p("  contain nothing outside it, so the external enum's 7/8 stay excluded.");
  p();
}

function sectionCoverage(p, ctx) {
  p('=== Damage coverage ===');
  p();
  const d = ctx.damageComplete;
  p(`  row coverage            ${ctx.knownRows.damage}/${ctx.rowTotals.damage} known (incl. NONE rows)`);
  p(`  damageCompleteHeroes    ${d.complete.length}/${ctx.heroes.length}`);
  p(`  incomplete heroes       ${d.incomplete.length ? d.incomplete.map((x) => `${x.hero} (${x.known}/${x.total})`).join(', ') : 'none'}`);
  p();
  p('=== Target-team coverage ===');
  p();
  const t = ctx.targetComplete;
  p(`  row coverage            ${ctx.knownRows.target}/${ctx.rowTotals.target} known (incl. NONE/CUSTOM rows)`);
  p(`  targetCompleteHeroes    ${t.complete.length}/${ctx.heroes.length}`);
  p(`  incomplete heroes       ${t.incomplete.length ? t.incomplete.map((x) => `${x.hero} (${x.known}/${x.total})`).join(', ') : 'none'}`);
  p();
  p(`  allDamageKnown          ${ctx.bothComplete.damage}`);
  p(`  allTargetKnown          ${ctx.bothComplete.target}`);
  p(`  complete on BOTH dims   ${ctx.bothComplete.both}/${ctx.heroes.length}`);
  p();
  p('  §10 expectation: no 127/127 — `stat: null` rows must stay UNKNOWN.');
  p();
}

function sectionDistributions(p, ctx) {
  p('=== Capability distributions ===');
  p();
  p('                     №33 (T/F/U)      №35 (T/F/U)      ΔFALSE');
  for (const id of IDS) {
    const a = ctx.dist33[id];
    const b = ctx.dist35[id];
    p(`  ${id.padEnd(24)} ${fmtRow(a.TRUE, a.FALSE, a.UNKNOWN)}   ${fmtRow(b.TRUE, b.FALSE, b.UNKNOWN)}   ${String(b.FALSE - a.FALSE).padStart(6)}`);
  }
  p();
  p('  §9 mandatory comparison — direct T/F/U of №33 vs №35 (same table):');
  p();
  p('                 №33                     №35');
  p('                     T / F / U             T / F / U');
  const label = { HAS_PHYSICAL_DAMAGE: 'Physical', HAS_MAGICAL_DAMAGE: 'Magical', HAS_PURE_DAMAGE: 'Pure', HAS_ENEMY_TARGETED: 'Enemy', HAS_FRIENDLY_TARGETED: 'Friendly', HAS_BOTH_TARGETED: 'Both' };
  for (const id of IDS) {
    const a = ctx.dist33[id];
    const b = ctx.dist35[id];
    p(`  ${label[id].padEnd(16)} ${`${a.TRUE} / ${a.FALSE} / ${a.UNKNOWN}`.padEnd(24)} ${`${b.TRUE} / ${b.FALSE} / ${b.UNKNOWN}`}`);
  }
  p();
  const neverFalse35 = IDS.filter((id) => ctx.dist35[id].FALSE === 0);
  p(`  never-FALSE: №33 ${ctx.neverFalse33.length}/6 → №35 ${neverFalse35.length}/6${neverFalse35.length ? `  still: ${neverFalse35.join(', ')}` : '  — none'}`);
  p();
  p('  informativeness shares (§12 — descriptive only, no new score):');
  p('    capability                  TRUE    FALSE  UNKNOWN    known');
  for (const id of IDS) {
    const f = ctx.availability[id];
    p(`    ${id.padEnd(25)} ${pct(f.trueShare, 1).padStart(6)} ${pct(f.falseShare, 1).padStart(6)} ${pct(f.unknownShare, 1).padStart(8)} ${pct(f.knownShare, 1).padStart(7)}`);
  }
  p();
  p("  No canonical entropy helper exists anywhere in the codebase, so §12's");
  p('  entropy metric is reported as the three shares + effective known share.');
  p();
}

function sectionFalseAvailability(p, ctx) {
  p('=== FALSE availability ===');
  p();
  p('    capability                  FALSE  known(T+F)  known share');
  for (const id of IDS) {
    const f = ctx.availability[id];
    p(`    ${id.padEnd(25)} ${String(f.falseHeroes).padStart(5)} ${String(f.knownHeroes).padStart(11)} ${pct(f.knownHeroes, f.total).padStart(12)}`);
  }
  p();
  const totalFalse35 = IDS.reduce((s, id) => s + ctx.dist35[id].FALSE, 0);
  const totalFalse33 = IDS.reduce((s, id) => s + ctx.dist33[id].FALSE, 0);
  p(`  total FALSE states: №33 ${totalFalse33} → №35 ${totalFalse35}${totalFalse33 ? ` (×${(totalFalse35 / totalFalse33).toFixed(1)})` : ''}`);
  p('  §14 question: does FALSE carry information now — see also §15 pairs that');
  p('  could not even EXIST as a group before (FALSE/FALSE etc).');
  p();
}

function sectionSignatures(p, ctx) {
  p('=== Capability signatures ===');
  p();
  p(`  №35 distinct signatures  ${ctx.groups.length}/${ctx.heroes.length}   (№33: 34/127)`);
  p(`  distinct signatures       ${ctx.groups.length} / ${ctx.heroes.length} = ${pct(ctx.groups.length, ctx.heroes.length)}`);
  p(`  largest signature         ${ctx.groups[0].count} / ${ctx.heroes.length} = ${pct(ctx.groups[0].count, ctx.heroes.length)}`);
  const top2 = ctx.groups.slice(0, 2).reduce((s, g) => s + g.count, 0);
  p(`  top-2 signatures          ${top2} / ${ctx.heroes.length} = ${pct(top2, ctx.heroes.length)}`);
  p('  distinct signature count is descriptive;');
  p('  group concentration is the stronger diagnostic of discrimination.');
  p(`  largest group            ${ctx.groups[0].count} heroes`);
  const smallest = ctx.groups[ctx.groups.length - 1].count;
  const smallestCount = ctx.groups.filter((g) => g.count === smallest).length;
  p(`  smallest groups          ${smallestCount} × ${smallest} hero${smallest === 1 ? '' : 's'}`);
  const allUnknown = ctx.groups.filter((g) => IDS.every((id) => g.signature.includes(`${id}=UNKNOWN`))).length;
  p(`  fully UNKNOWN profiles   ${allUnknown}`);
  p();
  p('  top groups:');
  for (const g of ctx.groups.slice(0, 5)) {
    p(`    ×${String(g.count).padStart(3)}  ${g.signature}`);
  }
  p();
  for (const [name, list] of [['damage', DAMAGE_CAPS], ['target', TARGET_CAPS]]) {
    const sigs = new Set(ctx.profiles35.map((pr) => list.map((id) => pr.capabilities[id].state).join('/')));
    const counts = list.map((id) => ctx.dist35[id]);
    p(`  ${name}-only signatures  ${sigs.size}/${ctx.heroes.length}   (${counts.map((d) => `T${d.TRUE}/F${d.FALSE}/U${d.UNKNOWN}`).join('  ')})`);
  }
  p();
}

function sectionRedundancy(p, ctx) {
  p('=== Redundancy ===');
  p();
  p('    pair                               №33 agree  №35 agree  disting.  same-T  same-F  both-U');
  for (const [a, b] of REDUNDANCY_PAIRS) {
    const r33 = capabilityRedundancyV2(ctx.profiles33, a, b);
    const r35 = capabilityRedundancyV2(ctx.profiles35, a, b);
    const label = `${a} vs ${b}`;
    const sameT = ctx.profiles35.filter((pr) => pr.capabilities[a].state === 'TRUE' && pr.capabilities[b].state === 'TRUE').length;
    const sameF = ctx.profiles35.filter((pr) => pr.capabilities[a].state === 'FALSE' && pr.capabilities[b].state === 'FALSE').length;
    p(`    ${label.padEnd(34)} ${pct(r33.identical, r33.identical + r33.distinguish).padStart(9)} ${pct(r35.identical, r35.identical + r35.distinguish).padStart(9)} ${String(r35.distinguish).padStart(9)} ${String(sameT).padStart(7)} ${String(sameF).padStart(7)} ${String(r35.bothUnknown).padStart(6)}`);
  }
  p();
  const me = capabilityRedundancyV2(ctx.profiles35, 'HAS_MAGICAL_DAMAGE', 'HAS_ENEMY_TARGETED');
  const me33 = capabilityRedundancyV2(ctx.profiles33, 'HAS_MAGICAL_DAMAGE', 'HAS_ENEMY_TARGETED');
  p(`  Magical vs Enemy: ${pct(me33.identical, me33.identical + me33.distinguish)} (§33) → ${pct(me.identical, me.identical + me.distinguish)} (§35).`);
  p('  Agreement percentages are STRUCTURALLY unchanged: in §33 every pair was');
  p('  {TRUE, UNKNOWN}, TRUE never downgrades, and U→F turns (U,U) agreement');
  p('  into (F,F) agreement while (T,U)/(U,T) stays distinguishable. What');
  p('  changed is composition: both-UNKNOWN columns collapsed toward 0, so');
  p('  agreement now means shared FACT, not shared ignorance.');
  p();
}

function sectionPairUniqueness(p, ctx) {
  p('=== Pair uniqueness ===');
  p();
  p('    pair                                    distinct 2-feature signatures (of 9)');
  for (const [a, b] of UNIQUENESS_PAIRS) {
    const u = pairUniqueness(ctx.profiles35, a, b);
    const u33 = pairUniqueness(ctx.profiles33, a, b);
    const newCombos = Object.keys(u.combos).filter((k) => !u33.combos[k]);
    const goneCombos = Object.keys(u33.combos).filter((k) => !u.combos[k]);
    const label = `${a} + ${b}`;
    const extra = [
      newCombos.length ? `new: ${newCombos.join(', ')}` : '',
      goneCombos.length ? `gone: ${goneCombos.join(', ')}` : '',
    ].filter(Boolean).join('   ');
    p(`    ${label.padEnd(45)} ${u.distinct} (№33: ${u33.distinct})${extra ? `  ${extra}` : ''}`);
  }
  p();
  p('  New combinations could not occur in §33 (a FALSE that was unreachable) —');
  p('  this is where the zero mapping creates hero groups rather than merely');
  p('  relabelling old ones.');
  p();
}

function sectionBenchmarks(p, ctx) {
  p('=== Benchmark heroes ===');
  p();
  p('    hero             abil  dmgKnown tgtKnown | Phy  Mag  Pur | Enm  Frd  Bth');
  for (const name of BENCHMARKS) {
    const hero = ctx.heroByName.get(name);
    if (!hero) { p(`    ${name.padEnd(16)} NOT IN POOL`); continue; }
    const profile = ctx.profileById.get(hero.id);
    const dc = heroDimensionCoverage(hero.abilities, ctx.maps35.unitDamageType, 'unitDamageType');
    const tc = heroDimensionCoverage(hero.abilities, ctx.maps35.unitTargetTeam, 'unitTargetTeam');
    const st = (id) => profile.capabilities[id].state.replace('UNKNOWN', 'U').replace('TRUE', 'T').replace('FALSE', 'F');
    p(`    ${name.padEnd(16)} ${String((hero.abilities ?? []).length).padStart(4)} ${String(`${dc.known}/${dc.total}`).padStart(8)} ${String(`${tc.known}/${tc.total}`).padStart(8)} | ${st('HAS_PHYSICAL_DAMAGE').padStart(3)}  ${st('HAS_MAGICAL_DAMAGE').padStart(3)}  ${st('HAS_PURE_DAMAGE').padStart(3)} | ${st('HAS_ENEMY_TARGETED').padStart(3)}  ${st('HAS_FRIENDLY_TARGETED').padStart(3)}  ${st('HAS_BOTH_TARGETED').padStart(3)}`);
  }
  p();
}

function sectionPosition(p, ctx) {
  p('=== Hero-position intersection ===');
  p();
  if (!ctx.positions) { p('  positions.json absent — skipped.'); p(); return; }
  const r = ctx.position;
  p(`  gate-eligible hero-position cells (share ≥8%, games ≥500): ${r.cells}`);
  p(`    complete capability profile    ${r.completeCells}`);
  p(`    unknown capability present     ${r.incompleteCells}`);
  p(`  capability states inside cells   known ${r.knownCapabilities} / unknown ${r.unknownCapabilities}`);
  p(`  pool heroes without position data ${r.heroesWithoutPositionData.length}`);
  p();
  p('  Read-only coexistence check: the position model and its eligibility');
  p('  gate are untouched. This is the cell count a future Hero + Position +');
  p('  EnemyCapability layer would start from.');
  p();
}

function sectionComparison(p, ctx) {
  p('=== Comparison with §33 ===');
  p();
  const f33 = IDS.reduce((s, id) => s + ctx.dist33[id].FALSE, 0);
  const f35 = IDS.reduce((s, id) => s + ctx.dist35[id].FALSE, 0);
  const u33 = IDS.reduce((s, id) => s + ctx.dist33[id].UNKNOWN, 0);
  const u35 = IDS.reduce((s, id) => s + ctx.dist35[id].UNKNOWN, 0);
  const t33 = IDS.reduce((s, id) => s + ctx.dist33[id].TRUE, 0);
  const t35 = IDS.reduce((s, id) => s + ctx.dist35[id].TRUE, 0);

  p('                              №33        №35');
  p(`  row coverage (damage)   ${pct(ctx.coverage33.damage, 1).padStart(8)}   ${pct(ctx.coverage35.damage, 1).padStart(8)}`);
  p(`  row coverage (target)   ${pct(ctx.coverage33.target, 1).padStart(8)}   ${pct(ctx.coverage35.target, 1).padStart(8)}`);
  p(`  damage-complete heroes  ${String(ctx.complete33.damage).padStart(8)}   ${String(ctx.complete35.damage).padStart(8)}`);
  p(`  target-complete heroes  ${String(ctx.complete33.target).padStart(8)}   ${String(ctx.complete35.target).padStart(8)}`);
  p(`  never-FALSE caps        ${String(ctx.neverFalse33.length).padStart(8)}/6   ${String(ctx.neverFalse35.length).padStart(8)}/6`);
  p(`  sum TRUE/FALSE/UNKNOWN  ${`${t33}/${f33}/${u33}`.padStart(8)}   ${`${t35}/${f35}/${u35}`.padStart(8)}`);
  p(`  distinct signatures     ${'34'.padStart(8)}/127 ${String(ctx.groups.length).padStart(8)}/127`);
  p(`  largest group           ${'23'.padStart(8)}    ${String(ctx.groups[0].count).padStart(8)}`);
  const me33 = capabilityRedundancyV2(ctx.profiles33, 'HAS_MAGICAL_DAMAGE', 'HAS_ENEMY_TARGETED');
  const me35 = capabilityRedundancyV2(ctx.profiles35, 'HAS_MAGICAL_DAMAGE', 'HAS_ENEMY_TARGETED');
  p(`  agreement MAGICAL/ENEMY ${pct(me33.identical, me33.identical + me33.distinguish).padStart(8)}   ${pct(me35.identical, me35.identical + me35.distinguish).padStart(8)}`);
  p();
  p('  TRUE counts are identical by construction: a confirmed hit was already');
  p('  TRUE in §33 and nothing that was known became unknown. The whole effect');
  p('  of resolving NONE lives in the FALSE and UNKNOWN columns.');
  p();
}

function sectionLimitations(p, ctx) {
  p('=== Limitations ===');
  p();
  p('  1. Existence only (§19): 3 magical abilities are not 3x stronger, and');
  p('     no capability is weighted. This is a coarse presence/absence layer.');
  p('  2. Dimensions deliberately excluded (§5): isUltimate, isTalent, duration,');
  p('     castRange, dispellable, isInnate — none informs these profiles.');
  p('  3. HAS_CUSTOM_TARGETED excluded (§4): CUSTOM is a diagnostic raw');
  p('     semantic, not a self-evident gameplay capability.');
  p('  4. unitTargetFlags stays UNKNOWN — §34 §16 left it unmapped, and §35');
  p('     does not revisit enum codes.');
  p('  5. No wins / items / matchups imported (§18): profiles are strictly');
  p('     Hero → Ability → Semantic. Nothing here predicts match outcomes.');
  p('  6. §17 reads positions.json but changes no eligibility; the capability');
  p('     layer is not yet wired into any ranking — this report only informs');
  p('     that future decision.');
  p('  7. The §34 residual (3 inconclusive target rows) is preserved: they are');
  p('     NONE-compatible but not proof, and heroes depending on them stay');
  p('     UNKNOWN wherever the data does not decide.');
  p('  8. FALSE is a statement about the SOURCE, not about gameplay reach: it');
  p('     means "no ability row declares this semantics", not "the hero cannot');
  p('     affect enemies". Benchmark example: Puck resolves Enemy=FALSE because');
  p('     all six STRATZ rows carry unitTargetTeam=0 (ground/point-targeted');
  p('     abilities declare no unit team). A conditioning layer must consume it');
  p('     as "declared targeting absent", never as "harmless to enemies".');
  p();
}

function sectionConclusion(p, ctx) {
  p('=== Conclusion ===');
  p();
  const f33 = IDS.reduce((s, id) => s + ctx.dist33[id].FALSE, 0);
  const f35 = IDS.reduce((s, id) => s + ctx.dist35[id].FALSE, 0);
  const neverFalse35 = IDS.filter((id) => ctx.dist35[id].FALSE === 0);

  p('  1. Does confirmed NONE materially increase FALSE states?');
  p(`     FALSE states across the six capabilities: ${f33} → ${f35};`);
  p(`     never-FALSE capabilities ${ctx.neverFalse33.length}/6 → ${neverFalse35.length}/6.`);
  p(`     ${f35 > f33 * 2 ? 'Yes — materially.' : f35 > f33 ? 'Yes, but modestly.' : 'No — negligible.'} Every capability can now express a negative${neverFalse35.length === 0 ? '' : ` except ${neverFalse35.join(', ')}`}.`);
  p();
  p('  2. How many heroes now have a complete damage capability profile?');
  p(`     ${ctx.complete35.damage}/${ctx.heroes.length} (was ${ctx.complete33.damage}/${ctx.heroes.length} in §33).`);
  p();
  p('  3. How many have a complete target capability profile?');
  p(`     ${ctx.complete35.target}/${ctx.heroes.length} (was ${ctx.complete33.target}/${ctx.heroes.length} in §33).`);
  p();
  p('  4. How many distinct hero signatures exist?');
  p(`     ${ctx.groups.length}/${ctx.heroes.length} full six-feature signatures (§33: 34/127);`);
  p(`     largest group ${ctx.groups[0].count} heroes.`);
  p();
  p('  5. Are the capabilities actually complementary?');
  const aggs = REDUNDANCY_PAIRS.map(([a, b]) => {
    const r = capabilityRedundancyV2(ctx.profiles35, a, b);
    return { a, b, pct: pct(r.identical, r.identical + r.distinguish) };
  }).sort((x, y) => parseFloat(y.pct) - parseFloat(x.pct));
  p(`     highest agreement ${aggs[0].pct} (${aggs[0].a} vs ${aggs[0].b}),`);
  p(`     lowest ${aggs[aggs.length - 1].pct} (${aggs[aggs.length - 1].a} vs ${aggs[aggs.length - 1].b}).`);
  p('     No pair collapses into the same feature; damage and target stay');
  p('     distinct axes rather than one repeated axis. Agreement is unchanged');
  p('     from §33 by the U→F structure — the new information is that it now');
  p('     rests on known facts (both-UNKNOWN ≈ 0) instead of shared ignorance.');
  p();
  p('  MAIN QUESTION: after restoring NONE, is Hero → Ability → typed');
  p('  semantic expressive enough to work as a coarse enemy feature layer?');
  p();
  const rowCoverage = Math.min(ctx.audits.unitDamageType.mappedShare, ctx.audits.unitTargetTeam.mappedShare);
  const completeShare = ctx.bothComplete.both / ctx.heroes.length;
  // §35.1: the field keeps its historical name for back-compat, but it is a
  // DIVERSITY diagnostic (distinct signatures / pool), not a quality score.
  const distinctSignatureShare = ctx.groups.length / ctx.heroes.length;
  const verdict = capabilityVerdictV2({ rowCoverage, completeShare, signatureShare: distinctSignatureShare, neverFalse: neverFalse35.length });
  p(`  Verdict: ${verdict}`);
  p();
  p(`  rowCoverage ${pct(rowCoverage, 1)} · completeShare ${pct(ctx.bothComplete.both, ctx.heroes.length)} · distinctSignatureShare ${pct(ctx.groups.length, ctx.heroes.length)} · neverFalse ${neverFalse35.length}`);
  p(`  largest signature ${pct(ctx.groups[0].count, ctx.heroes.length)} · top-2 signatures ${pct(ctx.groups.slice(0, 2).reduce((s, g) => s + g.count, 0), ctx.heroes.length)} (concentration, not a verdict input)`);
  p();
  if (verdict === 'CAPABILITY_EXACT') {
    p('  The domain is now essentially fully known and the profiles genuinely');
    p('  separate heroes; the layer is worth carrying as an auxiliary signal.');
  } else if (verdict === 'CAPABILITY_PARTIAL') {
    p('  The domain is usable and FALSE states are real, but residual UNKNOWN');
    p('  keeps a share of heroes undecided — usable as a coarse auxiliary layer');
    p('  with the UNKNOWN state passed through honestly.');
  } else {
    p('  Coverage is good but the profiles barely discriminate or the features');
    p('  remain redundant — this branch should be closed rather than shipped.');
  }
  p();
  p('  No weights. No EnemyCapabilityScore. No percentage over an unknown');
  p('  denominator. Nothing written outside scripts/ and docs/.');
  p();
}

/* ─────────────────────────────── main ─────────────────────────────── */

function reportAll(data) {
  const out = [];
  const p = (s = '') => out.push(s);
  const { stratz, mappings, positions } = data;
  const heroes = stratz.heroes ?? [];

  // §3: two in-memory maps from the same artifact — §35 merged, §33 baseline.
  const maps35 = mergeConfirmedMappings(mappings);
  const maps33 = mergeConfirmedMappings(mappings, {});

  const profiles35 = heroes.map((h) => heroCapabilityProfileV2(h.id, h.abilities, maps35));
  const profiles33 = heroes.map((h) => heroCapabilityProfileV2(h.id, h.abilities, maps33));

  const dist33 = Object.fromEntries(IDS.map((id) => [id, capabilityDistributionV2(profiles33, id)]));
  const dist35 = Object.fromEntries(IDS.map((id) => [id, capabilityDistributionV2(profiles35, id)]));
  const availability = Object.fromEntries(IDS.map((id) => [id, falseAvailability(profiles35, id)]));

  const damageRows = rawRows(heroes, 'unitDamageType');
  const targetRows = rawRows(heroes, 'unitTargetTeam');
  const audits = {
    unitDamageType: domainAudit(damageRows, maps35.unitDamageType, EXPECTED_RAW_DOMAIN.unitDamageType),
    unitTargetTeam: domainAudit(targetRows, maps35.unitTargetTeam, EXPECTED_RAW_DOMAIN.unitTargetTeam),
  };

  const damageComplete = completeness(heroes, maps35.unitDamageType, 'unitDamageType');
  const targetComplete = completeness(heroes, maps35.unitTargetTeam, 'unitTargetTeam');
  const bothComplete = {
    damage: damageComplete.complete.length,
    target: targetComplete.complete.length,
    both: heroes.filter((h) =>
      heroDimensionCoverage(h.abilities, maps35.unitDamageType, 'unitDamageType').complete &&
      heroDimensionCoverage(h.abilities, maps35.unitTargetTeam, 'unitTargetTeam').complete,
    ).length,
  };

  const coverage35 = {
    damage: audits.unitDamageType.mappedShare,
    target: audits.unitTargetTeam.mappedShare,
  };
  const coverage33 = {
    damage: damageRows.filter((r) => r !== null && r !== undefined && maps33.unitDamageType.has(String(r))).length / (damageRows.length || 1),
    target: targetRows.filter((r) => r !== null && r !== undefined && maps33.unitTargetTeam.has(String(r))).length / (targetRows.length || 1),
  };

  const complete33 = {
    damage: heroes.filter((h) => heroDimensionCoverage(h.abilities, maps33.unitDamageType, 'unitDamageType').complete).length,
    target: heroes.filter((h) => heroDimensionCoverage(h.abilities, maps33.unitTargetTeam, 'unitTargetTeam').complete).length,
  };
  const complete35 = { damage: bothComplete.damage, target: bothComplete.target };

  const ctx = {
    heroes, maps33, maps35, profiles33, profiles35, dist33, dist35, availability,
    audits,
    rowTotals: { damage: damageRows.length, target: targetRows.length },
    knownRows: {
      damage: damageRows.filter((r) => r !== null && r !== undefined && maps35.unitDamageType.has(String(r))).length,
      target: targetRows.filter((r) => r !== null && r !== undefined && maps35.unitTargetTeam.has(String(r))).length,
    },
    damageComplete, targetComplete, bothComplete,
    coverage33, coverage35, complete33, complete35,
    neverFalse33: IDS.filter((id) => dist33[id].FALSE === 0),
    neverFalse35: IDS.filter((id) => dist35[id].FALSE === 0),
    groups: signatureGroups(profiles35),
    heroByName: new Map(heroes.map((h) => [h.displayName, h])),
    profileById: new Map(heroes.map((h, i) => [h.id, profiles35[i]])),
    positions,
    position: positionIntersection(profiles35, positions),
  };

  p('# ТЗ §35 — Capability Profile v2 after confirmed NONE');
  p();
  p(`  STRATZ snapshot ${stratz.capturedAt}   gameVersionId ${mappings.stratzGameVersionId}   heroes ${heroes.length}`);
  p('  mappings §32 (read-only) + §34 zero semantics merged in memory');
  p(`  confirmed mappings №33 baseline  ${Object.entries(maps33).map(([f, m]) => `${f}=${m.size}`).join('  ')}`);
  p(`  runtime maps №35                 ${Object.entries(maps35).map(([f, m]) => `${f}=${m.size}`).join('  ')}`);
  p();
  p('```bash');
  p('node scripts/stratz-hero-capability-v2-research.mjs');
  p('```');
  p();

  sectionDomain(p, ctx);
  sectionCoverage(p, ctx);
  sectionDistributions(p, ctx);
  sectionFalseAvailability(p, ctx);
  sectionSignatures(p, ctx);
  sectionRedundancy(p, ctx);
  sectionPairUniqueness(p, ctx);
  sectionBenchmarks(p, ctx);
  sectionPosition(p, ctx);
  sectionComparison(p, ctx);
  sectionLimitations(p, ctx);
  sectionConclusion(p, ctx);

  console.log(out.join('\n'));
}

function main() {
  try {
    reportAll(load());
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}

main();





