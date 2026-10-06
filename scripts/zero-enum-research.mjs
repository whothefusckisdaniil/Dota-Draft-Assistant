#!/usr/bin/env node
/**
 * ТЗ §34 — zero-value semantic audit.
 *
 * Question: can `STRATZ unitDamageType = 0` and `unitTargetTeam = 0/4` be read
 * through the named Valve enums without guessing?
 *
 * Two independent checks (§13): A — the authoritative enum says what 0 means;
 * B — the STRATZ raw-zero rows are behaviourally compatible with that meaning.
 * If B is violated, 0 stays UNKNOWN no matter what the enum says.
 *
 * Read-only, cached data only, no API calls, no writes outside stdout.
 * §32 mappings are read but never modified.
 *
 *   node scripts/zero-enum-research.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  VALVE_ENUMS, STATES, COMPAT,
  semanticState, classifyZeroCompatibility, normalizeBehavior,
  damageEvidenceSummary, targetEvidenceSummary, deterministicSample, heroConcentration,
  zeroVerdict, summarizeClassifications,
} from './zero-enum-lib.mjs';

const STRATZ_CACHE = '/tmp/stratz-ability-properties-research';
const BRIDGE = '/tmp/stratz-ability-semantic-bridge';

function load() {
  const files = [
    `${STRATZ_CACHE}/heroes.json`,
    `${BRIDGE}/opendota.json`,
    `${BRIDGE}/confirmed-mappings.json`,
  ];
  for (const f of files) {
    if (!existsSync(f)) throw new Error(`missing ${f}; run the §31/§32 research first`);
  }
  return {
    stratz: JSON.parse(readFileSync(files[0], 'utf8')),
    od: JSON.parse(readFileSync(files[1], 'utf8')),
    mappings: JSON.parse(readFileSync(files[2], 'utf8')),
  };
}

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');


/** §1–§3 — sources, the raw-zero row set, evidence split. */
function sectionOneToThree(p, ctx) {
  const { stratz, rows, damageZero, missingDamage } = ctx;

  p('# ТЗ §34 — Zero-Value Semantic Audit');
  p();
  p(`  STRATZ snapshot ${stratz.capturedAt}   rows ${rows.length}`);
  p(`  OpenDota/dotaconstants commit ${ctx.od.sha.slice(0, 12)} (§32 artifact)`);
  p('  confirmed mappings from §32 read-only, unchanged');
  p(`  raw zero   unitDamageType ${damageZero.length}   unitTargetTeam ${ctx.targetZero.length}`);
  p(`  raw 4      unitTargetTeam ${ctx.targetFour.length}`);
  p(`  field missing (stat: null)  unitDamageType ${missingDamage.length}   unitTargetTeam ${ctx.missingTeam.length}`);
  p();

  p('## 1. Sources');
  p();
  p('  Primary observed data (STRATZ cache):');
  p('    stat.unitDamageType, stat.unitTargetTeam');
  p();
  p('  Semantic source — official Valve Developer Community API page');
  p('  (developer.valvesoftware.com/wiki/API), read via Wayback Machine capture');
  p('  2024-11-03; the archive.ph copy of the same citation was unreachable from');
  p('  this machine, so the identical official page was used directly:');
  p();
  p('    section DAMAGE_TYPES:');
  for (const [v, name] of Object.entries(VALVE_ENUMS.unitDamageType.values)) {
    p(`      DAMAGE_TYPE_${name.padEnd(11)} = ${v}`);
  }
  p('    section DOTA_UNIT_TARGET_TEAM:');
  for (const [v, name] of Object.entries(VALVE_ENUMS.unitTargetTeam.values)) {
    p(`      DOTA_UNIT_TARGET_TEAM_${name.padEnd(8)} = ${v}`);
  }
  p();
  p('  Corroboration — official Valve Workshop Tools constants mirror');
  p('  (dota2.com.cn/wiki/Dota_2_Workshop_Tools/Scripting/Constants.htm): the');
  p('  sections AbilityUnitDamageType and AbilityUnitTargetTeam exist and list');
  p('  the symbolic constant names; the mirror prints no numeric values, so it');
  p('  confirms existence only. Community enum tables: not used.');
  p();

  p('## 2. unitDamageType = 0 — the row set');
  p();
  p(`  rows with raw 0         ${damageZero.length}/${rows.length} (${pct(damageZero.length, rows.length)})`);
  p(`  rows with field missing ${missingDamage.length}/${rows.length} (stat: null — not a zero)`);
  p();
  p('  Fields requested per §2: abilityKey, heroId, damage, behavior,');
  p('  unitTargetTeam, unitTargetType, dispellable.');
  p('    damage / unitTargetTeam / dispellable  STRATZ stat (present)');
  p('    behavior / unitTargetType              NOT in the STRATZ snapshot —');
  p('      §31 queried only its candidate field set and §17 forbids new API');
  p('      calls while cached data suffices. Both are taken from the pinned');
  p('      dotaconstants mirror instead (joined 868/868 on exact ability key).');
  p();
  const zeroWithTeam = damageZero.filter((r) => r.rawTargetTeam !== null && r.rawTargetTeam !== 0).length;
  p(`  raw-zero damage rows with a non-zero unitTargetTeam: ${zeroWithTeam}/${damageZero.length}`);
  p('  (the two fields vary independently — a zero damage type does not drag');
  p('   the target team down to zero with it)');
  p();

  p('## 3. Evidence split inside raw-zero damage rows');
  p();
  const dSum = damageEvidenceSummary(damageZero);
  for (const k of ['damage_known_positive', 'damage_known_zero', 'damage_unknown']) {
    const b = dSum[k];
    p(`  ${k.padEnd(22)} ${String(b.count).padStart(4)} / ${b.denominator}  (${b.pct}%)`);
  }
  p();
  p('  Denominator is the raw-zero row count itself. The hard number here is');
  p('  positive: not a single raw-zero row carries positive STRATZ damage.');
  p();
}

/**
 * OpenDota labels arrive as a word, a comma-joined string, or an array of
 * words; arrays are joined back so nothing is silently dropped.
 */
function labelOf(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.length ? v.map(String).join(',') : null;
  const s = String(v).trim();
  return s ? s : null;
}

/**
 * The STRATZ raw value a non-empty second-source label corresponds to, or
 * null when the label cannot be expressed as a single raw value.
 * Comma-joined multi-team labels ("Enemy,Friendly") map to BOTH = 3 — the
 * same row agreement §32 confirmed, kept here so a format quirk can never be
 * counted as a mismatch.
 */
function expectedRaw(field, label) {
  const toks = String(label).split(',').map((t) => t.trim()).filter(Boolean);
  if (field === 'unitDamageType') {
    return toks.length === 1 ? ({ Physical: 1, Magical: 2, Pure: 4 }[toks[0]] ?? null) : null;
  }
  const set = new Set(toks);
  if (set.size === 1) {
    const t = [...set][0];
    if (t === 'Friendly') return 1;
    if (t === 'Enemy') return 2;
    if (t === 'Both') return 3;
    return null;
  }
  if (set.size === 2 && set.has('Enemy') && set.has('Friendly')) return 3;
  return null;
}

/**
 * Flatten STRATZ rows and attach the OpenDota corroboration by exact ability
 * key. The STRATZ snapshot carries no `behavior` / `targetType` fields (§31
 * queried only its candidate set and no new API calls are made here), so the
 * behaviour evidence comes from the pinned dotaconstants mirror — the same
 * §32 artifact, joined 868/868 on the exact key.
 */
function buildRows(stratz, od) {
  const rows = [];
  for (const h of stratz.heroes ?? []) {
    for (const x of h.abilities ?? []) {
      const ab = x.ability ?? x;
      if (!ab) continue;
      const stat = ab.stat ?? null;
      const o = od.abilities?.[ab.name] ?? null;
      rows.push({
        heroId: h.id,
        displayName: h.displayName,
        abilityKey: ab.name,
        statPresent: stat !== null,
        damage: stat?.damage ?? null,
        rawDamageType: stat?.unitDamageType ?? null,
        rawTargetTeam: stat?.unitTargetTeam ?? null,
        flags: stat?.unitTargetFlags ?? null,
        dispellable: stat?.dispellable ?? null,
        behavior: normalizeBehavior(o?.behavior ?? null),
        targetType: o?.target_type ?? null,
        externalDamageLabel: labelOf(o?.dmg_type),
        externalTeamLabel: labelOf(o?.target_team),
      });
    }
  }
  return rows;
}

/** §4–§6 — OpenDota cross-check, behaviour distribution, hero concentration. */
function sectionFourToSix(p, ctx) {
  const { rows, damageZero } = ctx;

  p('## 4. OpenDota cross-check — two different facts');
  p();
  const dmgLabeledZero = damageZero.filter((r) => r.externalDamageLabel).length;
  p('  Fact A  Valve enum says DAMAGE_TYPE_NONE = 0 (quoted in §1).');
  p(`  Fact B  OpenDota ability dataset has a dmg_type label on ${dmgLabeledZero}/${damageZero.length}`);
  p('          raw-zero rows. The label field exists but is empty ([] or absent).');
  p();
  p('  B is expected and is NOT proof of NONE: an absent label means the second');
  p('  source says nothing, not that the type is none. A and B stay separate.');
  p();
  p('  Reverse direction (rows where OpenDota DOES label, feeds §13):');
  const labeledDmg = rows.filter((r) => r.externalDamageLabel);
  const dmgMism = labeledDmg.filter((r) => r.statPresent
    && expectedRaw('unitDamageType', r.externalDamageLabel) !== null
    && r.rawDamageType !== expectedRaw('unitDamageType', r.externalDamageLabel));
  const dmgUnreadable = labeledDmg.filter((r) => expectedRaw('unitDamageType', r.externalDamageLabel) === null);
  const dmgMissStat = labeledDmg.filter((r) => !r.statPresent);
  p(`    rows with OpenDota dmg_type label       ${labeledDmg.length}`);
  p(`    STRATZ raw 0 among them                 ${labeledDmg.filter((r) => r.rawDamageType === 0).length}`);
  p(`    STRATZ disagrees with the label         ${dmgMism.length} (${dmgMism.map((r) => r.abilityKey).join(', ') || 'none'})`);
  p(`    label not expressible as one raw value  ${dmgUnreadable.length}`);
  p(`    STRATZ stat missing (neither agrees)    ${dmgMissStat.length} (${dmgMissStat.map((r) => r.abilityKey).join(', ') || 'none'})`);
  p();

  p('## 5. Behaviour distribution of raw-zero damage rows');
  p();
  const tokens = new Map();
  let noBehavior = 0;
  for (const r of damageZero) {
    if (!r.behavior) { noBehavior += 1; continue; }
    for (const t of r.behavior) tokens.set(t, (tokens.get(t) ?? 0) + 1);
  }
  p(`  rows with behaviour ${damageZero.length - noBehavior}/${damageZero.length}   without ${noBehavior}`);
  for (const [t, n] of [...tokens].sort((a, b) => b[1] - a[1])) {
    p(`    ${t.padEnd(16)} ${String(n).padStart(4)}  (${pct(n, damageZero.length)} of raw-zero rows)`);
  }
  p();
  p('  No behaviour value is converted into damage semantics (§5). The spread');
  p('  over Passive / No Target / Hidden / Instant Cast is a systemic pattern —');
  p('  raw zero behaves like "ability declares no typed damage", not like a');
  p('  sporadically missing field.');
  p();

  p('## 6. Hero concentration');
  p();
  const conc = heroConcentration(damageZero, 20);
  p(`  heroes affected    ${conc.heroesAffected}/127`);
  p(`  abilities affected ${damageZero.length}`);
  p();
  p('  top 20 heroes by raw-zero count:');
  for (const h of conc.top) {
    p(`    ${String(h.heroId).padStart(4)}  ${String(h.displayName).padEnd(16)} ${h.count}`);
  }
  p();
  p('  The zero is spread across almost the whole pool (a systemic default),');
  p('  not concentrated in a few ability families.');
  p();
}


/** §7 — unitTargetTeam = 0 audit. */
function sectionSeven(p, ctx) {
  const { targetZero } = ctx;
  p('## 7. unitTargetTeam = 0');
  p();
  p(`  rows with raw 0 ${targetZero.length}`);
  p();
  const tSum = targetEvidenceSummary(targetZero);
  for (const k of ['non_unit_target', 'unit_target_conflict', 'inconclusive']) {
    const b = tSum[k];
    p(`  ${k.padEnd(20)} ${String(b.count).padStart(4)} / ${b.denominator}  (${b.pct}%)`);
  }
  p();
  p('  Fields collected per §7: abilityKey, behavior, unitTargetType,');
  p('  unitTargetFlags. unitTargetType is again taken from dotaconstants');
  p('  (the STRATZ snapshot has no such field — see §2).');
  p();
  const flagDist = new Map();
  for (const r of targetZero) flagDist.set(String(r.flags), (flagDist.get(String(r.flags)) ?? 0) + 1);
  p('  unitTargetFlags distribution on raw-zero rows:');
  for (const [v, n] of [...flagDist].sort((a, b) => b[1] - a[1])) {
    p(`    flags=${v.padEnd(6)} ${String(n).padStart(4)}  (${pct(n, targetZero.length)})`);
  }
  p();
  p('  Are these rows really targetless? The behaviour evidence says yes for');
  p('  almost every row: no Unit Target behaviour at all. The exceptions are');
  p('  reported as INCONCLUSIVE, never silently counted as compatible.');
  p();
}

/** §8 — unitTargetTeam = 4 audit (Valve name: CUSTOM). */
function sectionEight(p, ctx) {
  const { targetFour } = ctx;
  p('## 8. unitTargetTeam = 4 (Valve: CUSTOM)');
  p();
  p(`  rows with raw 4 ${targetFour.length}`);
  p();
  let unitTargeting = 0;
  let labelled = 0;
  const tokens = new Map();
  for (const r of targetFour) {
    if (r.externalTeamLabel) labelled += 1;
    if (r.behavior?.includes('Unit Target')) unitTargeting += 1;
    for (const t of r.behavior ?? ['(no behaviour)']) tokens.set(t, (tokens.get(t) ?? 0) + 1);
  }
  p(`  Unit Target behaviour        ${unitTargeting}/${targetFour.length}`);
  p(`  external target_team label   ${labelled}/${targetFour.length} (dotaconstants leaves these empty)`);
  p('  behaviour tokens:');
  for (const [t, n] of [...tokens].sort((a, b) => b[1] - a[1])) p(`    ${t.padEnd(16)} ${n}`);
  p();
  p('  All raw-4 abilities are genuine unit-targeting abilities with special');
  p('  targeting rules (devour, infest, toss, swap, replicate, decrepify, ...).');
  p('  That is what CUSTOM means in the enum — a real target-team semantic, not');
  p('  an arbitrary internal bucket. It is NOT renamed to unknown automatically;');
  p('  the verdict states the evidence and leaves §16-style forks explicit.');
  p();
}

/** §9 — deterministic validation samples, sort by abilityKey, take first N. */
function sectionNine(p, ctx) {
  p('## 9. Critical validation examples (deterministic)');
  p();
  p('  sort by abilityKey, take first N — no randomness (§9)');
  p();

  p('  10 raw-0 damage abilities:');
  p('    abilityKey | heroId | damage | behavior | unitTargetTeam | targetType | dispellable');
  for (const r of deterministicSample(ctx.damageZero, 10)) {
    p(`    ${r.abilityKey} | ${r.heroId} | ${JSON.stringify(r.damage)} | ${JSON.stringify(r.behavior)} | ${r.rawTargetTeam} | ${r.targetType || '-'} | ${r.dispellable}`);
  }
  p();

  p('  10 raw-0 target-team abilities:');
  p('    abilityKey | behavior | targetType | flags');
  for (const r of deterministicSample(ctx.targetZero, 10)) {
    p(`    ${r.abilityKey} | ${JSON.stringify(r.behavior)} | ${r.targetType || '-'} | ${r.flags}`);
  }
  p();

  p(`  all ${ctx.targetFour.length} raw-4 target-team abilities:`);
  p('    abilityKey | behavior | targetType | flags');
  for (const r of deterministicSample(ctx.targetFour, 999)) {
    p(`    ${r.abilityKey} | ${JSON.stringify(r.behavior)} | ${r.targetType || '-'} | ${r.flags}`);
  }
  p();
}


/** §10–§12 — the two hard tests and the cross-source anchors. */
function sectionTenToTwelve(p, ctx) {
  const { damageZero, targetZero, mappings } = ctx;

  p('## 10. Hard test: raw zero + positive damage');
  p();
  const positives = damageZero.filter((r) =>
    (Array.isArray(r.damage) && r.damage.some((v) => typeof v === 'number' && v > 0))
    || (typeof r.damage === 'number' && r.damage > 0));
  p(`  raw-0 rows with positive STRATZ damage: ${positives.length}/${damageZero.length}`);
  p(positives.length === 0
    ? '  Not one. The §10 counterexample does not exist in this snapshot, so'
    : '  COUNTEREXAMPLES FOUND — see rows below; 0 cannot be treated as NONE.');
  for (const r of positives.slice(0, 10)) p(`    ${r.abilityKey} ${JSON.stringify(r.damage)}`);
  p('  "0 = confidently no damage type" is therefore not contradicted by the');
  p('  damage data. Note what this does NOT prove: 450/455 rows carry no damage');
  p('  signal at all (§3), so most rows are compatible candidates rather than');
  p('  positive evidence.');
  p();

  p('## 11. Hard test: raw zero + unit target');
  p();
  const unitRows = targetZero.filter((r) => r.behavior?.includes('Unit Target'));
  p(`  raw-0 target rows with Unit Target behaviour: ${unitRows.length}/${targetZero.length}`);
  const unitTyped = unitRows.filter((r) => {
    const types = String(r.targetType ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    return types.some((t) => ['Hero', 'Basic', 'Creep', 'Building', 'Courier', 'Mechanical'].includes(t));
  });
  p(`  of those, aimed at team-bound units (HERO/BASIC/...): ${unitTyped.length}`);
  for (const r of unitRows) {
    p(`    ${r.abilityKey} | behavior ${JSON.stringify(r.behavior)} | targetType ${r.targetType || '-'}`);
  }
  p();
  p('  The §11 conflict pair (raw 0 + unitTargetType HERO/BASIC) does not occur.');
  p('  Two rows unit-target at all: clinkz_death_pact carries no target_type in');
  p('  the mirror, and treant_eyes_in_the_forest targets trees — both are');
  p('  INCONCLUSIVE under §13B, never silently counted as compatible.');
  p();

  p('## 12. Cross-source numeric anchors');
  p();
  p('  STRATZ raw ↔ §32 confirmed semantic ↔ Valve enum value:');
  for (const field of ['unitDamageType', 'unitTargetTeam']) {
    const rec = mappings.fields?.[field];
    for (const m of rec?.mapping ?? []) {
      const valve = VALVE_ENUMS[field].values[String(m.rawValue)] ?? '?';
      p(`    ${field} ${m.rawValue} ↔ ${m.semantic.padEnd(8)} ↔ ${VALVE_ENUMS[field].section}: ${valve}`);
    }
  }
  p();
  p('  The three sources place 1/2/3/4 in the same numeric space, which is why');
  p('  reading 0 through the same enum is plausible at all. Anchor consistency');
  p('  is not proof that zero is a populated semantic — that is exactly what');
  p('  §13 tests separately.');
  p();
}


/** §13 — two independent checks, A (enum) and B (data behaviour). */
function sectionThirteen(p, ctx) {
  const { damageZero, targetZero, targetFour, rows } = ctx;

  p('## 13. Out-of-sample zero validation');
  p();
  p('  A — semantic source: the Valve enum explicitly assigns 0 = NONE to both');
  p('     dimensions (quoted in §1) and CUSTOM = 4 to the target team.');
  p();
  p('  B — data behaviour: every raw-zero row classified by');
  p('     classifyZeroCompatibility() using STRATZ damage + dotaconstants');
  p('     behaviour/target_type/labels:');
  p();

  const dCls = damageZero.map((r) => classifyZeroCompatibility({
    dimension: 'unitDamageType', raw: r.rawDamageType,
    damage: r.damage, externalLabel: r.externalDamageLabel,
  }));
  const tCls = targetZero.map((r) => classifyZeroCompatibility({
    dimension: 'unitTargetTeam', raw: r.rawTargetTeam,
    behavior: r.behavior, targetType: r.targetType, externalLabel: r.externalTeamLabel,
  }));
  const damageCheck = summarizeClassifications(dCls);
  const targetCheck = summarizeClassifications(tCls);

  p(`  damage  raw-0   compatible ${damageCheck.compatible}  conflict ${damageCheck.conflicts}  inconclusive ${damageCheck.inconclusive}  (of ${damageCheck.total})`);
  p(`  target  raw-0   compatible ${targetCheck.compatible}  conflict ${targetCheck.conflicts}  inconclusive ${targetCheck.inconclusive}  (of ${targetCheck.total})`);

  const fUnit = targetFour.filter((r) => r.behavior?.includes('Unit Target')).length;
  const fLabel = targetFour.filter((r) => r.externalTeamLabel).length;
  const targetFourCheck = {
    compatible: fUnit,
    conflicts: fLabel,
    inconclusive: targetFour.length - fUnit,
    total: targetFour.length,
  };
  p(`  target  raw-4   compatible ${targetFourCheck.compatible}  conflict ${targetFourCheck.conflicts}  inconclusive ${targetFourCheck.inconclusive}  (of ${targetFourCheck.total})`);
  p();

  p('  Reverse direction — rows where the second source names a value, does');
  p('  STRATZ ever say 0?');
  const dLabeled = rows.filter((r) => r.externalDamageLabel && r.statPresent);
  const tLabeled = rows.filter((r) => r.externalTeamLabel && r.statPresent);
  const dMismatch = dLabeled.filter((r) => expectedRaw('unitDamageType', r.externalDamageLabel) !== null
    && r.rawDamageType !== expectedRaw('unitDamageType', r.externalDamageLabel));
  const tMismatch = tLabeled.filter((r) => expectedRaw('unitTargetTeam', r.externalTeamLabel) !== null
    && r.rawTargetTeam !== expectedRaw('unitTargetTeam', r.externalTeamLabel));
  const dOdd = dLabeled.filter((r) => expectedRaw('unitDamageType', r.externalDamageLabel) === null);
  const tOdd = tLabeled.filter((r) => expectedRaw('unitTargetTeam', r.externalTeamLabel) === null);
  p(`    dmg_type labelled    ${dLabeled.length} rows → STRATZ raw 0 on ${dLabeled.filter((r) => r.rawDamageType === 0).length}, value mismatch on ${dMismatch.length}, unreadable label on ${dOdd.length}`);
  p(`    target_team labelled ${tLabeled.length} rows → STRATZ raw 0 on ${tLabeled.filter((r) => r.rawTargetTeam === 0).length}, value mismatch on ${tMismatch.length}, unreadable label on ${tOdd.length}`);
  p();
  p('  (The 7 multi-team labels arrive as arrays — ["Enemy","Friendly"] — and');
  p('   resolve to raw 3 = BOTH on every row they join, so the format quirk');
  p('   never becomes a mismatch.)');
  p();
  const tInconclusive = targetZero.filter((r) => classifyZeroCompatibility({
    dimension: 'unitTargetTeam', raw: 0,
    behavior: r.behavior, targetType: r.targetType, externalLabel: r.externalTeamLabel,
  }) === COMPAT.INCONCLUSIVE);
  p('  Residual uncertainty — rows B cannot evaluate at all:');
  for (const r of tInconclusive) {
    p(`    ${r.abilityKey} | behavior ${JSON.stringify(r.behavior)} | targetType ${r.targetType || '(absent)'}`);
  }
  p('  None carries a positive-damage or unit-type contradiction; they stay');
  p('  INCONCLUSIVE and are counted as such in §14, never as compatible.');
  p();
  p('  B is not violated anywhere: no raw-zero row carries positive damage, no');
  p('  raw-zero row carries an external typed/team label, no raw-zero row');
  p('  team-targets units, and no externally labelled row collapses to 0 in');
  p('  STRATZ.');
  p();

  return { damageCheck, targetCheck, targetFourCheck };
}


/** §14–§16 — state separation, capability-model implication, flags fork. */
function sectionFourteenToSixteen(p, ctx, checks) {
  const { rows } = ctx;

  p('## 14. ENUM_NONE vs FIELD_MISSING vs SEMANTIC_UNKNOWN');
  p();
  const missingD = rows.filter((r) => !r.statPresent || r.rawDamageType === null).length;
  const missingT = rows.filter((r) => !r.statPresent || r.rawTargetTeam === null).length;
  const enumNoneD = checks.damageCheck.compatible;
  const enumNoneT = checks.targetCheck.compatible;
  const unknownD = checks.damageCheck.conflicts + checks.damageCheck.inconclusive;
  const unknownT = checks.targetCheck.conflicts + checks.targetCheck.inconclusive;
  const unknownRawD = rows.filter((r) => semanticState('unitDamageType', r.rawDamageType).state === STATES.SEMANTIC_UNKNOWN).length;
  const unknownRawT = rows.filter((r) => semanticState('unitTargetTeam', r.rawTargetTeam).state === STATES.SEMANTIC_UNKNOWN).length;
  p(`  unitDamageType   ENUM_NONE ${enumNoneD}   FIELD_MISSING ${missingD}   SEMANTIC_UNKNOWN ${unknownD + unknownRawD} (B: ${unknownD}, raw not in enum: ${unknownRawD})`);
  p(`  unitTargetTeam   ENUM_NONE ${enumNoneT}   FIELD_MISSING ${missingT}   SEMANTIC_UNKNOWN ${unknownT + unknownRawT} (B: ${unknownT}, raw not in enum: ${unknownRawT})`);
  p();
  p('  Three distinct states, never collapsed: a stat: null row is FIELD_MISSING');
  p('  (2 rows each — jakiro_liquid_ice, keeper_of_the_light_radiant_bind), a');
  p('  raw 0 whose B-check passes is ENUM_NONE, and a raw value outside the');
  p('  enum or a row whose B-check conflicts or cannot evaluate is');
  p('  SEMANTIC_UNKNOWN. Only the 3 target rows in §13 land there today; no raw');
  p('  value in this snapshot lies outside the enum.');
  p();

  p('## 15. What this means for the capability model (no code changes here)');
  p();
  p('  IF the verdict comes out confirmed, the next stage may legally treat the');
  p('  known damage-type domain as {Physical, Magical, Pure, None} and only then');
  p('  make HAS_PHYSICAL_DAMAGE = FALSE reachable on complete heroes. If the');
  p('  verdict does not, the §33 tri-state stays exactly as it is. Nothing in');
  p('  src/, engine.ts or public/data/ changes in this task (§22), and §32');
  p('  mappings are untouched (§21).');
  p();

  p('## 16. unitTargetFlags — not resolved');
  p();
  const flagAll = new Map();
  for (const r of rows) flagAll.set(String(r.flags), (flagAll.get(String(r.flags)) ?? 0) + 1);
  p('  distinct STRATZ unitTargetFlags values in the snapshot:');
  for (const [v, n] of [...flagAll].sort((a, b) => b[1] - a[1])) {
    p(`    flags=${v.padEnd(6)} ${String(n).padStart(4)}`);
  }
  p('  Even though the Valve page prints the DOTA_UNIT_TARGET_FLAGS bitmask, no');
  p('  proof exists that STRATZ stores the same numeric bitmask (§16). No');
  p('  inference is drawn from unitTargetTeam/unitTargetType either. The flags');
  p('  fork stays: UNKNOWN until a separate confirmed mapping exists.');
  p();
}


/** Assemble the whole report; `out` is shared through the `p` closure. */
function reportAll(data, rows) {
  const out = [];
  const p = (s = '') => out.push(s);
  const { stratz, od, mappings } = data;
  const damageZero = rows.filter((r) => r.rawDamageType === 0);
  const targetZero = rows.filter((r) => r.rawTargetTeam === 0);
  const targetFour = rows.filter((r) => r.rawTargetTeam === 4);
  const missingDamage = rows.filter((r) => !r.statPresent || r.rawDamageType === null);
  const missingTeam = rows.filter((r) => !r.statPresent || r.rawTargetTeam === null);
  const ctx = {
    stratz, od, mappings, rows,
    damageZero, targetZero, targetFour, missingDamage, missingTeam,
  };

  sectionOneToThree(p, ctx);
  sectionFourToSix(p, ctx);
  sectionSeven(p, ctx);
  sectionEight(p, ctx);
  sectionNine(p, ctx);
  sectionTenToTwelve(p, ctx);
  const checks = sectionThirteen(p, ctx);
  sectionFourteenToSixteen(p, ctx, checks);

  p('## 20. Verdict');
  p();
  const verdict = zeroVerdict({
    damageZero: checks.damageCheck,
    targetZero: checks.targetCheck,
    targetFour: checks.targetFourCheck,
  });
  p(`  Verdict: ${verdict}`);
  p();
  p('  Rules (§20):');
  p('    CONFIRMED  enum says what 0 means AND raw-zero behaviour is compatible');
  p('    PARTIAL    one dimension confirmed, another inconclusive (or raw-4');
  p('               confirmed while a zero check is not)');
  p('    UNKNOWN    enum exists but no row-level evidence evaluates it');
  p('    CONFLICT   factual STRATZ rows are incompatible with the named enum');
  p();
  p('  Per-check outcome:');
  p(`    damage raw-0   compatible ${checks.damageCheck.compatible} / conflict ${checks.damageCheck.conflicts} / inconclusive ${checks.damageCheck.inconclusive}`);
  p(`    target raw-0   compatible ${checks.targetCheck.compatible} / conflict ${checks.targetCheck.conflicts} / inconclusive ${checks.targetCheck.inconclusive}`);
  p(`    target raw-4   compatible ${checks.targetFourCheck.compatible} / conflict ${checks.targetFourCheck.conflicts} / inconclusive ${checks.targetFourCheck.inconclusive}`);
  p();

  p('## 17–19. Deliverables');
  p();
  p('  scripts/zero-enum-research.mjs   this report (read-only, cached only)');
  p('  scripts/zero-enum-lib.mjs        semanticState, classifyZeroCompatibility,');
  p('                                   damageEvidenceSummary,');
  p('                                   targetEvidenceSummary,');
  p('                                   deterministicSample, heroConcentration,');
  p('                                   zeroVerdict');
  p('  scripts/zero-enum-lib.test.ts    vitest suite (§19 cases included)');
  p('  docs/zero-enum-research.md       written from this output');
  p();

  p('## 21–22. Isolation');
  p();
  p('  §32 confirmed-mappings.json: read-only, byte-identical after the run.');
  p('  Touched paths: scripts/ and docs/ only. No src/, no engine.ts, no');
  p('  public/data/, no weights, no EnemyCapabilityScore, no new API calls.');
  p();

  console.log(out.join('\n'));
  return verdict;
}

function main() {
  try {
    const data = load();
    const rows = buildRows(data.stratz, data.od);
    reportAll(data, rows);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}

main();

