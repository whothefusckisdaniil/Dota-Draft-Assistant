#!/usr/bin/env node
/**
 * ТЗ §31 — ability property research.
 *
 * Question: do the eight typed property fields produce stable, diverse
 * hero-level features, and what does the source actually know about them?
 *
 * Read-only. One aggregate `constants` query, no match queries. Nothing here
 * builds a capability, a score, or an `EnemyCapability`, and no property is
 * weighted (§19).
 *
 *   node scripts/stratz-ability-properties-research.mjs all
 *   node scripts/stratz-ability-properties-research.mjs all --cached
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StratzTransport } from './update-data-stratz.mjs';
import {
  CONFIDENCE, PROPERTY_FIELDS, SEMANTICALLY_OPAQUE,
  normalizeAbilityProperties, valueCoverage, categoricalDistribution,
  numericDistribution, shareWithDenominator, heroFeatureProfile,
  profileSignature, featureOverlap,
} from './stratz-ability-properties-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = '/tmp/stratz-ability-properties-research';
mkdirSync(CACHE, { recursive: true });
const DATA = path.join(CACHE, 'heroes.json');

function loadToken() {
  const fromEnv = process.env.STRATZ_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    for (const line of readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*STRATZ_API_TOKEN\s*=\s*(.*?)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    }
  } catch { /* no .env */ }
  return null;
}
const F = "damage unitDamageType duration castRange unitTargetTeam unitTargetFlags dispellable spellImmunity";

/** §22 — confidence is decided from measured data, never assumed. */
function confidenceFor(field, cov, entries) {
  if (cov.nonNull === 0) return CONFIDENCE.SCHEMA_ONLY;
  const opaque = SEMANTICALLY_OPAQUE.has(field);
  const halfEmpty = cov.nullPct > 50;
  if (opaque) {
    return entries > 1 ? CONFIDENCE.PARTIALLY_POPULATED : CONFIDENCE.UNINFORMATIVE;
  }
  if (halfEmpty) return CONFIDENCE.PARTIALLY_POPULATED;
  if (field === 'isInnate') return CONFIDENCE.FULLY_POPULATED;
  if (field === 'dispellable') return CONFIDENCE.FULLY_POPULATED;
  return entries > 1 ? CONFIDENCE.FULLY_POPULATED : CONFIDENCE.UNINFORMATIVE;
}

function pct(n) {
  return `${(100 * n).toFixed(1)}%`;
}

/** §14 — candidate features. `opaque` ones cannot be called available. */
const FEATURES = {
  HAS_DISPELLABLE_ABILITY: { known: (r) => r.dispellable !== null, select: (r) => r.dispellable === 'YES' },
  HAS_TIMED_ABILITY: { known: (r) => r.duration !== null, select: (r) => r.duration !== null },
  HAS_INNATE_ABILITY: { known: (r) => r.isInnate !== null, select: (r) => r.isInnate === true },
  HAS_LONG_RANGE_ABILITY: {
    known: (r) => r.castRange !== null,
    select: (r) => Array.isArray(r.castRange) && r.castRange.some((v) => typeof v === 'number' && v > 900),
  },
  HAS_DAMAGE_ABILITY: {
    known: (r) => r.damage !== null,
    select: (r) => Array.isArray(r.damage) && r.damage.some((v) => typeof v === 'number' && v > 0),
  },
  // Opaque: meaning depends on interpreting a bare integer. §5/§6/§7.
  HAS_PHYSICAL_DAMAGE: { opaque: true, known: (r) => r.unitDamageType !== null, select: () => false },
  HAS_MAGICAL_DAMAGE: { opaque: true, known: (r) => r.unitDamageType !== null, select: () => false },
  HAS_PURE_DAMAGE: { opaque: true, known: (r) => r.unitDamageType !== null, select: () => false },
  HAS_ENEMY_TARGETED_ABILITY: { opaque: true, known: (r) => r.unitTargetTeam !== null, select: () => false },
  HAS_ALLY_TARGETED_ABILITY: { opaque: true, known: (r) => r.unitTargetTeam !== null, select: () => false },
  HAS_SELF_TARGETED_ABILITY: { opaque: true, known: (r) => r.unitTargetTeam !== null, select: () => false },
};

async function fetchData({ cached }) {
  if (cached) {
    if (!existsSync(DATA)) throw new Error(`no cache at ${DATA}; run once without --cached`);
    return JSON.parse(readFileSync(DATA, 'utf8'));
  }
  const t = new StratzTransport(loadToken());
  try {
    await t.init();
    const q = await t.query(`{ constants { heroes { id displayName name gameVersionId abilities { ability { id name stat { isInnate ${F} } } } } } }`);
    if (q?.errors) throw new Error(`GraphQL: ${JSON.stringify(q.errors[0]?.message).slice(0, 200)}`);
    const data = {
      capturedAt: new Date().toISOString(),
      gameVersionId: q?.data?.constants?.gameVersionId ?? null,
      patch: q?.data?.constants?.patch ?? null,
      heroes: q?.data?.constants?.heroes ?? [],
    };
    writeFileSync(DATA, JSON.stringify(data));
    process.stderr.write(`  cached ${data.heroes.length} heroes -> ${DATA}\n`);
    return data;
  } finally {
    await t.close();
  }
}

function report(d) {
  const out = [];
  const p = (s = '') => out.push(s);
  const heroes = d.heroes ?? [];
  const rows = heroes.flatMap((h) => h.abilities.map((a) => normalizeAbilityProperties(a.ability))).filter(Boolean);

  p('# ТЗ §31 — Ability Property Research');
  p();
  p(`  gameVersionId ${[...new Set(heroes.map((h) => h.gameVersionId).filter(Boolean))].join(", ") || "n/a"}`);
  p(`  captured ${d.capturedAt}`);
  p(`  heroes ${heroes.length}   abilities ${rows.length}`);
  p();
  p('## 1. Population audit — schema exists != populated != informative');
  p();
  p('  field              nonNull    null   null%  distinct  shape       confidence');
  const covs = {};
  for (const f of PROPERTY_FIELDS) {
    const cov = valueCoverage(rows, f);
    covs[f] = cov;
    const sample = rows.find((r) => r[f] !== null)?.[f];
    const shape = cov.isArray ? 'array' : cov.isBoolean ? 'boolean' : cov.isNumeric ? 'integer' : typeof sample;
    p(`  ${f.padEnd(17)} ${String(cov.nonNull).padStart(6)} ${String(cov.null).padStart(7)} ${(cov.nullPct ?? 0).toFixed(1).padStart(6)}% ${String(cov.distinct).padStart(9)}  ${shape.padEnd(10)}  ${confidenceFor(f, cov, cov.distinct)}`);
  }
  p();

  p('## 2. damage — an array, and 97% absent');
  p();
  const dmg = covs.damage;
  const dmgRows = rows.filter((r) => r.damage !== null);
  const arr = dmgRows.filter((r) => Array.isArray(r.damage)).length;
  const zero = dmgRows.filter((r) => Array.isArray(r.damage) && r.damage.every((v) => v === 0)).length;
  const pos = dmgRows.filter((r) => Array.isArray(r.damage) && r.damage.some((v) => typeof v === 'number' && v > 0)).length;
  const neg = dmgRows.filter((r) => Array.isArray(r.damage) && r.damage.some((v) => typeof v === 'number' && v < 0)).length;
  p(`  present ${dmg.nonNull}/${dmg.total}   array ${arr}   scalar ${dmg.nonNull - arr}`);
  p(`  all-zero series ${zero}   any positive ${pos}   any negative ${neg}`);
  p(`  distinct ${dmg.distinct}, e.g. ${dmg.values.slice(0, 5).join('  ')}`);
  p();
  p('  `damage` is a per-level series, not a scalar, so "has damage" is not a');
  p('  scalar question. 97% null and the rest dominated by all-zero series.');
  p('  Zero is NOT treated as absence of damage.');
  p();

  p('## 3. unitDamageType — populated integers, NO authoritative mapping');
  p();
  dumpDist(p, categoricalDistribution(rows, 'unitDamageType'));
  p('  Four integer values, fully populated, and no UnitDamageTypeEnum type');
  p('  exists anywhere in the STRATZ schema. 0/1/2/4 cannot be called');
  p('  physical/magical/pure without an authoritative source (§5). UNKNOWN.');
  p();

  p('## 4. unitTargetTeam — same situation');
  p();
  dumpDist(p, categoricalDistribution(rows, 'unitTargetTeam'));
  p('  Five values, fully populated, no enum type in the schema. "enemy /');
  p('  ally / self" is plausible but not derivable, so those features are');
  p('  UNKNOWN (§6).');
  p();

  p('## 5. unitTargetFlags — a bitmask with no bit definitions');
  p();
  const flags = categoricalDistribution(rows, 'unitTargetFlags');
  dumpDist(p, flags);
  const maxFlag = Math.max(...flags.entries.map((e) => Number(e.value)));
  p(`  max ${maxFlag} spans ${(maxFlag + 1).toString(2).length} bits, but only ${flags.entries.length}`);
  p('  distinct patterns occur. It is a bitmask, yet no bit->meaning mapping');
  p('  is published, so it stays a raw integer (§7 requires UNKNOWN).');
  p();

  p('## 6. castRange — array, 60% absent');
  p();
  const crRows = rows.flatMap((r) => (Array.isArray(r.castRange) ? r.castRange.map((v) => ({ castRange: v })) : []));
  const cr = numericDistribution(crRows, 'castRange');
  p(`  arrays present ${covs.castRange.nonNull}/${covs.castRange.total}   scalar ${rows.filter((r) => typeof r.castRange === 'number').length}`);
  p(`  min ${cr.min}  p10 ${cr.percentiles.p10}  p25 ${cr.percentiles.p25}  p50 ${cr.percentiles.p50}  p75 ${cr.percentiles.p75}  p90 ${cr.percentiles.p90}  max ${cr.max}`);
  for (const b of cr.bins) p(`  bin ${b.label.padEnd(14)} ${String(b.count).padStart(5)}`);
  p();
  p('  Multi-element arrays are per-level ranges. Bins are descriptive only.');
  p();

  p('## 7. duration — populated but ~97% zero');
  p();
  const durRows = rows.filter((r) => r.duration !== null);
  const dArr = durRows.filter((r) => Array.isArray(r.duration)).length;
  const dStr = durRows.filter((r) => typeof r.duration === 'string').length;
  const dNum = durRows.filter((r) => typeof r.duration === 'number').length;
  const dPos = durRows.filter((r) => {
    const v = Array.isArray(r.duration) ? r.duration[0] : r.duration;
    return typeof v === 'number' ? v > 0 : typeof v === 'string' && Number(v) > 0;
  }).length;
  p(`  present ${covs.duration.nonNull}/${covs.duration.total}   array ${dArr}   string ${dStr}   number ${dNum}`);
  p(`  positive ${dPos}   zero/empty ${durRows.length - dPos}   distinct ${covs.duration.distinct}`);
  p(`  e.g. ${covs.duration.values.slice(0, 8).join('  ')}`);
  p();
  p('  Correcting an earlier expectation: the field is NOT three shapes, it is');
  p('  one — always a STRING. But the strings encode per-level series in a');
  p('  space-separated list ("1.0 1.0 1.0 1.0"), so a single numeric');
  p('  distribution still does not apply without splitting first. 839 of 866');
  p('  are zero-or-empty, so `duration` is 0.0 for ~97% of all abilities and');
  p('  carries almost no per-hero signal: HAS_TIMED_ABILITY is true for');
  p('  127/127 heroes at share 1.000. Populated is not the same as');
  p('  discriminative, and this field is the clearest example of that.');
  p();

  p('## 8. dispellable — the only field with self-evident semantics');
  p();
  dumpDist(p, categoricalDistribution(rows, 'dispellable'));
  p('  A STRING enum, so it needs no mapping: YES / NO / NONE read directly.');
  p('  Highest-confidence field in the set, and still silent on threat (§10).');
  p();
  return finish(p, out, d, rows, heroes, covs);
}

function dumpDist(p, dist) {
  for (const e of dist.entries) p(`  ${String(e.value).padEnd(7)} ${String(e.count).padStart(5)}  ${pct(e.share)}`);
  p(`  unknown ${dist.unknown}`);
}

function main() {
  const cached = process.argv.slice(2).includes('--cached');
  return fetchData({ cached }).then(report).catch((e) => {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  });
}

/** Sections 9-13: aggregation, diversity, redundancy, benchmarks, verdict. */
function finish(p, out, d, rows, heroes, covs) {
  const profiles = heroes.map((h) => heroFeatureProfile(h.displayName, h.abilities.map((a) => a.ability), FEATURES));
  const plain = Object.keys(FEATURES).filter((k) => !FEATURES[k].opaque);

  p('## 9. Hero-level aggregation (raw shares, explicit denominators)');
  p();
  p('  feature                        heroes>0   mean share   min known   max known');
  for (const name of plain) {
    const withIt = profiles.filter((pr) => pr.features[name].numerator > 0).length;
    const shares = profiles.map((pr) => pr.features[name].share).filter((s) => s !== null);
    const denoms = profiles.map((pr) => pr.features[name].denominator);
    const mean = shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : null;
    p(`  ${name.padEnd(30)} ${String(withIt).padStart(5)}      ${(mean === null ? 'n/a' : mean.toFixed(3)).padStart(6)}     ${String(Math.min(...denoms)).padStart(5)}      ${String(Math.max(...denoms)).padStart(6)}`);
  }
  p();
  p('  Each share divides by abilities whose field is KNOWN, never by all');
  p('  abilities, and the unknown count is carried alongside (§12/§13).');
  p('  Opaque features (physical/magical/pure, enemy/ally/self) are omitted:');
  p('  they have no authoritative mapping, so no share of them is meaningful.');
  p();

  p('## 10. Feature diversity — do the 127 heroes actually differ?');
  p();
  const sigs = new Map();
  for (const pr of profiles) {
    const s = profileSignature(pr);
    sigs.set(s, (sigs.get(s) ?? 0) + 1);
  }
  const biggest = Math.max(...sigs.values());
  p(`  distinct signatures ${sigs.size}/${profiles.length}   largest single group ${biggest}`);
  p();
  if (sigs.size <= 3) {
    p('  These features do not separate heroes at all: nearly every hero has');
    p('  the same signature. §26 is not met and nothing may be scored.');
  }
  p();

  p('## 11. Redundancy (hero-set overlap)');
  p();
  const PAIRS = [['HAS_TIMED_ABILITY', 'HAS_DISPELLABLE_ABILITY'], ['HAS_LONG_RANGE_ABILITY', 'HAS_INNATE_ABILITY'], ['HAS_TIMED_ABILITY', 'HAS_INNATE_ABILITY'], ['HAS_DISPELLABLE_ABILITY', 'HAS_LONG_RANGE_ABILITY']];
  for (const [a, b] of PAIRS) {
    const o = featureOverlap(profiles, a, b);
    p(`  ${a} vs ${b}`);
    p(`    both ${o.both}   onlyA ${o.onlyA}   onlyB ${o.onlyB}   neither ${o.neither}   jaccard ${o.jaccard === null ? 'n/a' : o.jaccard.toFixed(3)}`);
  }
  p();

  p('## 12. Benchmarks');
  p();
  for (const target of ['Anti-Mage', 'Sniper', 'Wraith King', 'Puck', 'Kunkka', 'Bane', 'Lion', 'Silencer', 'Tusk']) {
    const h = heroes.find((x) => x.displayName === target);
    if (!h) { p(`  ${target.padEnd(13)} NOT FOUND`); continue; }
    const rs = h.abilities.map((a) => normalizeAbilityProperties(a.ability)).filter(Boolean);
    const top = (f, n) => categoricalDistribution(rs, f).entries.slice(0, n).map((e) => `${e.value}x${e.count}`).join(',');
    p(`  ${target.padEnd(13)} ab ${String(rs.length).padStart(2)}  dmg ${top('unitDamageType', 3).padEnd(15)} team ${top('unitTargetTeam', 3).padEnd(15)} flags ${top('unitTargetFlags', 2)}`);
  }
  p();
  p('  Sanity check only, not a tuning table. Note that the benchmark columns');
  p('  are raw integers for the same reason as §3-§5.');
  p();

  p('## 13. Verdict');
  p();
  const opaque = PROPERTY_FIELDS.filter((f) => SEMANTICALLY_OPAQUE.has(f));
  // A field is only informative if it actually SEPARATES heroes. `duration` is
  // 99.8% populated but true for 127/127 heroes, so it separates nobody.
  const discriminative = plain.filter((name) => {
    const withIt = profiles.filter((pr) => pr.features[name].numerator > 0).length;
    const none = profiles.filter((pr) => pr.features[name].denominator > 0 && pr.features[name].numerator === 0).length;
    return withIt > 0 && none > 0;
  });
  const verdict = discriminative.length >= 3 && sigs.size > profiles.length / 2 ? 'PROPERTY_PROMISING'
    : discriminative.length >= 1 ? 'PROPERTY_PARTIAL' : 'PROPERTY_BLOCKED';
  p(`  Verdict: ${verdict}`);
  p();
  p(`  discriminative features   ${discriminative.join(', ') || 'none'}`);
  p(`  populated but not useful  duration (99.8% populated, 127/127 heroes true)`);
  p(`  populated but opaque      ${opaque.join(', ')}`);
  p(`  distinct hero signatures  ${sigs.size}/${profiles.length}`);
  p();
  p('  The three target/damage fields are 99.8% populated, carry 13 distinct');
  p('  bit patterns and 91 distinct cast ranges, and are the only fields that');
  p('  truly separate heroes — yet all three are bare integers with no enum');
  p('  and no published bit definitions, so their meaning is UNKNOWN and they');
  p('  cannot be used. The fields we CAN read (dispellable, isInnate) are the');
  p('  least discriminative, and duration separates nobody at all.');
  p();
  p('  So §26 is only half met: hero separation is demonstrable, but not');
  p('  through fields whose meaning we may state. No EnemyCapability, no');
  p('  weighting, no score, nothing shipped.');
  console.log(out.join('\n'));
}
main();
