#!/usr/bin/env node
/**
 * ТЗ §33 — tri-state hero capability research.
 *
 * Question: can PARTIAL ability semantics become an honest, useful hero-level
 * layer without recovering the unknown `0` values?
 *
 * The answer is only ever TRUE / FALSE / UNKNOWN, where FALSE requires complete
 * knowledge of the relevant abilities and TRUE requires a single confirmed
 * observation. No percentages, no shares, no weights, no EnemyCapabilityScore.
 *
 *   node scripts/stratz-hero-capability-research.mjs all --cached
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  TRI, CAPABILITIES,
  heroCapabilityProfile, capabilityDistribution, capabilitySignature, capabilityRedundancy,
} from './stratz-hero-capability-lib.mjs';

const STRATZ_CACHE = '/tmp/stratz-ability-properties-research';
const MAPPINGS = '/tmp/stratz-ability-semantic-bridge/confirmed-mappings.json';
const POSITIONS = 'public/data/positions.json';

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

/** Read §32's validated verdicts. Nothing here re-decides a mapping. */
function confirmedMaps(mappings) {
  const out = {};
  for (const [field, rec] of Object.entries(mappings.fields ?? {})) {
    out[field] = new Map((rec.mapping ?? []).filter((m) => m.validationStatus === 'CONFIRMED').map((m) => [m.rawValue, m.semantic]));
  }
  return out;
}

function report({ stratz, mappings }, positionsFiles = []) {
  const out = [];
  const p = (s = '') => out.push(s);
  const heroes = stratz.heroes ?? [];
  const maps = confirmedMaps(mappings);

  p('# ТЗ §33 — Tri-state Hero Capability Research');
  p();
  p(`  STRATZ gameVersionId ${mappings.stratzGameVersionId ?? 'n/a'}   snapshot ${stratz.capturedAt}`);
  p(`  mappings from §32, OpenDota commit ${(mappings.opendotaCommit ?? '').slice(0, 12)}`);
  p(`  heroes ${heroes.length}`);
  p(`  confirmed mappings ${Object.entries(maps).map(([f, m]) => `${f}=${m.size}`).join('  ')}`);
  p(`  unknown raws       ${Object.entries(mappings.unmapped ?? {}).map(([f, u]) => `${f}=${u.map((x) => x.rawValue).join('/')}`).join('  ')}`);
  p();

  const profiles = heroes.map((h) => heroCapabilityProfile(h.displayName, h.abilities, maps));
  const ids = CAPABILITIES.map((c) => c.id);

  p('## 1. Capability states across the pool');
  p();
  p('  capability                 TRUE   FALSE  UNKNOWN   informative?');
  for (const id of ids) {
    const d = capabilityDistribution(profiles, id);
    const informative = d.FALSE > 0 || (d.TRUE > 0 && d.UNKNOWN > 0);
    p(`  ${id.padEnd(25)} ${String(d.TRUE).padStart(5)} ${String(d.FALSE).padStart(6)} ${String(d.UNKNOWN).padStart(8)}   ${informative ? 'yes' : 'NO — saturated'}`);
  }
  p();
  const neverFalse = ids.filter((id) => capabilityDistribution(profiles, id).FALSE === 0);
  p(`  capabilities that can NEVER be FALSE for any hero: ${neverFalse.length}/${ids.length}`);
  p('    ' + neverFalse.join(', '));
  p('  FALSE requires complete knowledge of the relevant abilities, and §32.1');
  p('  measured 0/127 heroes complete on target team and 3/127 on damage type.');
  p();

  p('## 2. Profile diversity');
  p();
  const sigs = new Map();
  for (const pr of profiles) {
    const s = capabilitySignature(pr);
    sigs.set(s, (sigs.get(s) ?? 0) + 1);
  }
  const sorted = [...sigs.entries()].sort((a, b) => b[1] - a[1]);
  p(`  distinct signatures ${sigs.size}/${profiles.length}   largest group ${sorted[0][1]}`);
  for (const [sig, n] of sorted.slice(0, 4)) p(`    ${String(n).padStart(3)} heroes: ${sig.slice(0, 94)}`);
  const allUnknown = profiles.filter((pr) => Object.values(pr.capabilities).every((c) => c.state === TRI.UNKNOWN));
  p(`  heroes with a fully UNKNOWN profile: ${allUnknown.length}`);
  p();

  p('## 3. Redundancy between capabilities');
  p();
  const PAIRS = [['HAS_MAGICAL_DAMAGE', 'HAS_PURE_DAMAGE'], ['HAS_PHYSICAL_DAMAGE', 'HAS_PURE_DAMAGE'], ['HAS_ENEMY_TARGETED', 'HAS_FRIENDLY_TARGETED'], ['HAS_ENEMY_TARGETED', 'HAS_BOTH_TARGETED'], ['HAS_MAGICAL_DAMAGE', 'HAS_ENEMY_TARGETED']];
  for (const [a, b] of PAIRS) {
    const r = capabilityRedundancy(profiles, a, b);
    p(`  ${a} vs ${b}`);
    p(`    identical ${String(r.identical).padStart(3)}  distinguish ${String(r.distinguish).padStart(3)}  both-UNKNOWN ${String(r.bothUnknown).padStart(3)}  agreement ${(r.agreement * 100).toFixed(1)}%`);
  }
  p();
  return finish(p, out, profiles, ids, sigs, neverFalse, heroes, positionsFiles);
}
/** Sections 4-6: group separation, ontology intersection, verdict. */
function finish(p, out, profiles, ids, sigs, neverFalse, heroes, positionsFiles) {
  p('## 4. Damage and target capabilities, measured separately');
  p();
  for (const group of ['damage', 'target']) {
    const subset = CAPABILITIES.filter((c) => c.group === group);
    const sub = heroes.map((h) => heroCapabilityProfile(h.displayName, h.abilities, mapsFrom(sigs), subset));
    const uniq = new Set(sub.map((pr) => capabilitySignature(pr))).size;
    const anyFalse = subset.some((c) => capabilityDistribution(profiles, c.id).FALSE > 0);
    p(`  ${group.padEnd(7)} distinct signatures ${String(uniq).padStart(3)}/${heroes.length}   FALSE reachable: ${anyFalse ? 'yes' : 'NO'}`);
  }
  p();
  p('  They are not merged into one vector: they come from fields with different');
  p('  coverage (47.4% vs 32.7%) and different ability to be negative.');
  p();

  p('## 5. Intersection with the production Hero + Position ontology');
  p();
  const curated = curatedHeroes(positionsFiles);
  p(`  curated lane heroes parsed: ${curated.size}`);
  const inPool = profiles.filter((pr) => curated.has(pr.heroId));
  p(`  present in the ability pool: ${inPool.length}/${curated.size}`);
  for (const id of ids) {
    const d = capabilityDistribution(inPool, id);
    p(`    ${id.padEnd(25)} TRUE ${String(d.TRUE).padStart(3)}  FALSE ${String(d.FALSE).padStart(3)}  UNKNOWN ${String(d.UNKNOWN).padStart(3)}`);
  }
  p(`  distinct signatures inside the curated set: ${new Set(inPool.map((pr) => capabilitySignature(pr))).size}/${inPool.length}`);
  p('  This is a coexistence check, not a claim of equivalence: the curated');
  p('  tables encode pick/role intent, these encode ability semantics.');
  p();

  p('## 6. Verdict');
  p();
  const usable = ids.filter((id) => {
    const d = capabilityDistribution(profiles, id);
    return d.TRUE > 0 && d.UNKNOWN > 0;
  });
  const verdict = usable.length >= 3 && sigs.size > heroes.length / 2 ? 'CAPABILITY_TRISTATE_USABLE'
    : usable.length >= 1 ? 'CAPABILITY_TRISTATE_MARGINAL' : 'CAPABILITY_TRISTATE_BLOCKED';
  p(`  Verdict: ${verdict}`);
  p();
  p(`  usable (TRUE and UNKNOWN both present) ${usable.length}/${ids.length}`);
  p(`    ${usable.join(', ') || 'none'}`);
  p(`  never-FALSE capabilities             ${neverFalse.length}/${ids.length}`);
  p(`  distinct signatures                  ${sigs.size}/${heroes.length}`);
  p();
  p('  No weights. No EnemyCapabilityScore. No percentage over an unknown');
  p('  denominator. Nothing shipped to src/.');
  p();
  console.log(out.join('\n'));
}

/** Reconstruct the raw->semantic maps from the capability profile inputs. */
function mapsFrom() {
  return CURRENT_MAPS;
}
let CURRENT_MAPS = new Map();

/** Read curated lane tables as text; production code is never imported or modified. */
function curatedHeroes(files) {
  const names = new Set();
  for (const f of files) {
    let txt;
    try { txt = readFileSync(f, 'utf8'); } catch { continue; }
    for (const m of txt.matchAll(/^\s{2}'?([A-Za-z][A-Za-z ]*?)'?:/gm)) names.add(m[1]);
  }
  return names;
}

function main() {
  try {
    const data = load();
    CURRENT_MAPS = confirmedMaps(data.mappings);
    report(data, ['src/scoring/positions.ts', 'src/scoring/positionsExtra.ts']);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}

main();
