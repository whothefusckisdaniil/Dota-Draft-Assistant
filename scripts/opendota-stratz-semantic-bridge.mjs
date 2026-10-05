#!/usr/bin/env node
/**
 * ТЗ §32 — OpenDota semantic bridge for STRATZ ability properties.
 *
 * Question: can a second, official source (odota/dotaconstants, mirrored by the
 * OpenDota API) resolve the bare integers that §31 had to leave opaque, WITHOUT
 * a hand-written mapping?
 *
 * Method: join on exact ability key, build paired observations, and let the
 * consistency of those observations decide. Nothing here declares that "0 =
 * Physical"; that appears only if every ability carrying raw 0 also carries
 * `dmg_type: "Physical"` in both halves of a deterministic split.
 *
 *   node scripts/opendota-stratz-semantic-bridge.mjs all --cached
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  VALIDATION, FIELD_PAIRS,
  exactAbilityJoin, buildValueCrossTable,
  splitDeterministically, validateMapping,
} from './opendota-stratz-ability-lib.mjs';

const STRATZ_CACHE = '/tmp/stratz-ability-properties-research';
const CACHE = '/tmp/stratz-ability-semantic-bridge';
mkdirSync(CACHE, { recursive: true });
const OD_FILE = `${CACHE}/opendota.json`;
const REPO = 'odota/dotaconstants';
const UA = 'dota-draft-assistant-research';

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

/** §2 — pin the exact commit, so the artifact identity is not a floating branch. */
async function fetchOpenDota() {
  if (process.argv.includes('--cached')) {
    if (!existsSync(OD_FILE)) throw new Error(`no cache at ${OD_FILE}`);
    return JSON.parse(readFileSync(OD_FILE, 'utf8'));
  }
  const commits = await getJson(`https://api.github.com/repos/${REPO}/commits?path=build/abilities.json&per_page=1`);
  const sha = commits?.[0]?.sha;
  if (!sha) throw new Error('could not resolve dotaconstants commit SHA');
  const base = `https://raw.githubusercontent.com/${REPO}/${sha}/build`;
  const [abilities, heroAbilities] = await Promise.all([getJson(`${base}/abilities.json`), getJson(`${base}/hero_abilities.json`)]);
  const data = { repo: REPO, sha, base, fetchedAt: new Date().toISOString(), abilityCount: Object.keys(abilities).length, abilities, heroAbilities };
  writeFileSync(OD_FILE, JSON.stringify(data));
  return data;
}

const pct = (n, d) => (d ? `${(100 * n / d).toFixed(1)}%` : 'n/a');

function main() {
  const stratz = JSON.parse(readFileSync(`${STRATZ_CACHE}/heroes.json`, 'utf8'));
  return fetchOpenDota().then((od) => report(stratz, od)).catch((e) => {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  });
}

/** Sections 1-3: join, hero graph, split. */
function report(stratz, od) {
  const out = [];
  const p = (s = '') => out.push(s);
  const heroes = stratz.heroes ?? [];
  const gv = [...new Set(heroes.map((h) => h.gameVersionId).filter(Boolean))];

  p('# ТЗ §32 — OpenDota Semantic Bridge');
  p();
  p(`  STRATZ  gameVersionId ${gv.join(', ') || 'n/a'}   snapshot ${stratz.capturedAt}`);
  p(`  OpenDota repo ${od.repo}`);
  p(`  OpenDota commit ${od.sha}`);
  p(`  OpenDota fetched ${od.fetchedAt}   ability records ${od.abilityCount}`);
  p();

  const stratzAbilities = heroes.flatMap((h) => h.abilities.map((a) => a.ability).filter(Boolean));
  const distinctNames = new Set(stratzAbilities.map((a) => a.name));
  const join = exactAbilityJoin(stratzAbilities, od.abilities);
  p('## 1. Ability join (exact key only, §3)');
  p();
  p(`  STRATZ abilities       ${stratzAbilities.length}`);
  p(`  distinct STRATZ names  ${distinctNames.size}`);
  p(`  joined                 ${join.matchedCount}`);
  p(`  missing in OpenDota    ${join.missingOpenDota.length}${join.missingOpenDota.length ? `: ${join.missingOpenDota.slice(0, 10).join(', ')}` : ''}`);
  p(`  duplicate keys         ${join.duplicates.length}`);
  p(`  coverage               ${pct(join.matchedCount, distinctNames.size)}`);
  p();

  p('## 2. Hero graph cross-check (§4)');
  p();
  let heroHit = 0;
  const heroMissing = [];
  const diffs = [];
  for (const h of heroes) {
    // STRATZ already stores the full npc_dota_hero_* key; adding a prefix breaks it.
    const rec = od.heroAbilities?.[h.name];
    if (!rec) { heroMissing.push(h.name); continue; }
    heroHit += 1;
    const s = new Set(h.abilities.map((a) => a.ability?.name).filter(Boolean));
    const o = new Set(rec.abilities ?? []);
    const onlyS = [...s].filter((x) => !o.has(x));
    const onlyO = [...o].filter((x) => !s.has(x));
    if (onlyS.length || onlyO.length) diffs.push({ hero: h.name, onlyS, onlyO });
  }
  p(`  heroes joined          ${heroHit}/${heroes.length}  (${pct(heroHit, heroes.length)})`);
  p(`  missing in OpenDota    ${heroMissing.length}${heroMissing.length ? `: ${heroMissing.slice(0, 8).join(', ')}` : ''}`);
  p(`  differing ability sets ${diffs.length}`);
/** Section 4: cross-tables and mapping status for each field pair. */
  for (const d of diffs.slice(0, 8)) {
    p(`    ${d.hero}: only-STRATZ [${d.onlyS.slice(0, 4).join(',')}]  only-OpenDota [${d.onlyO.slice(0, 4).join(',')}]`);
  }
  p();

  const pairs = join.matched;
  const { a, b } = splitDeterministically(pairs);
  p('## 3. Deterministic out-of-sample split (§9)');
  p();
  p(`  A (mapping derived here)  ${a.length} abilities, first key "${a[0]?.key}"`);
  p(`  B (validation only)       ${b.length} abilities, first key "${b[0]?.key}"`);
  p();

  const summaries = fieldSections(p, pairs, a, b);
  heroSection(p, heroes, od, summaries);
  alignmentSection(p, gv, stratz, od);
  verdictSection(p, summaries, join, distinctNames, heroHit, heroes);
  console.log(out.join('\n'));
}
function fieldSections(p, pairs, a, b) {
  const summaries = {};
  for (const { stratz: sf, opendota: of } of FIELD_PAIRS) {
    p(`## 4. ${sf} <- ${of ?? '(no counterpart)'}`);
    p();
    if (!of) {
      p('  No OpenDota field is a proven counterpart for a STRATZ bitmask.');
      p('  `target_team` and `target_type` describe team and unit classes, not a');
      p('  bit->flag table, so they cannot establish bit-level correspondence.');
      p(`  Verdict: ${VALIDATION.UNKNOWN} (§11 — not guessed)`);
      p();
      summaries[sf] = { verdict: VALIDATION.UNKNOWN, confirmed: [] };
      continue;
    }
    const full = buildValueCrossTable(pairs, sf, of);
    const v = validateMapping(a, b, sf, of);
    p(`  paired observations ${full.observations}   with a semantic ${full.skills.raw}   without ${full.skills.noSemantic}`);
    p();
    p('  raw   n    OpenDota labels (count)                    A-derived / out-of-sample');
    for (const e of full.entries) {
      const labels = e.breakdown.map((x) => `${x.semantic ?? '(none)'}:${x.count}`).join('  ');
      const res = v.results.find((r) => r.rawValue === e.rawValue);
      const status = res ? `${res.validationStatus} / ${res.outOfSample}` : 'not observed in A';
      p(`  ${String(e.rawValue).padEnd(4)} ${String(e.count).padStart(4)}  ${labels.padEnd(42)} ${status}`);
    }
    p();
    const confirmed = v.results.filter((r) => r.validationStatus === VALIDATION.CONFIRMED);
    const conflicts = v.results.filter((r) => r.outOfSample === 'CONFLICT');
    p(`  CONFIRMED after out-of-sample validation: ${confirmed.length}/${full.entries.length}`);
    if (conflicts.length) p(`  CONFLICTS between A and B: ${conflicts.length} (${conflicts.map((c) => `raw ${c.rawValue}`).join(', ')})`);
    if (v.bOnlyValues.length) p(`  raw values only in B, unmappable from A: ${v.bOnlyValues.join(', ')}`);
    p();
    summaries[sf] = { verdict: confirmed.length === full.entries.length ? 'EXACT' : confirmed.length > 0 ? 'PARTIAL' : 'BLOCKED', confirmed, entries: full.entries };
  }
  return summaries;
}

/** Section 5: hero reconstruction over CONFIRMED mappings only (§10). */
function heroSection(p, heroes, od, summaries) {
  p('## 5. Hero-level reconstruction (CONFIRMED mappings only, §10)');
  p();
  const dmgMap = new Map((summaries.unitDamageType?.confirmed ?? []).map((m) => [m.rawValue, m.semantic]));
  const teamMap = new Map((summaries.unitTargetTeam?.confirmed ?? []).map((m) => [m.rawValue, m.semantic]));
  if (!dmgMap.size && !teamMap.size) {
    p('  No mapping reached CONFIRMED, so no hero semantic profile is produced.');
    p('  Producing one anyway is exactly what §10 forbids.');
    p();
    return;
  }
  const shown = [];
  for (const h of heroes) {
    const counts = new Map();
    let known = 0;
    let unknown = 0;
    for (const a of h.abilities) {
      const ab = a.ability;
      if (!ab) continue;
      const st = ab.stat ?? {};
      const d = dmgMap.get(String(st.unitDamageType));
      const t = teamMap.get(String(st.unitTargetTeam));
      if (d) { known += 1; counts.set(`damage:${d}`, (counts.get(`damage:${d}`) ?? 0) + 1); } else unknown += 1;
      if (t) { known += 1; counts.set(`team:${t}`, (counts.get(`team:${t}`) ?? 0) + 1); }
    }
    shown.push({ name: h.displayName, known, unknown, counts });
  }
  for (const v of shown.sort((x, y) => x.name.localeCompare(y.name)).slice(0, 6)) {
    p(`  ${v.name.padEnd(16)} known ${String(v.known).padStart(3)}  unmapped ${String(v.unknown).padStart(3)}  ${[...v.counts].map(([k, c]) => `${k}=${c}`).join(' ')}`);
  }
  void od;
  p();
}

/** Section 6: patch alignment is NOT assumed (§16). */
function alignmentSection(p, gv, stratz, od) {
  p('## 6. Patch alignment (§16)');
  p();
  p(`  STRATZ  gameVersionId ${gv.join(', ') || 'n/a'}   snapshot ${stratz.capturedAt}`);
  p(`  OpenDota commit ${od.sha.slice(0, 12)}   fetched ${od.fetchedAt}`);
  p('  Neither source states the other\'s patch or game version, so alignment is');
  p('  NOT established. Recorded as PATCH_MISMATCH rather than assumed.');
  p();
}

function verdictSection(p, summaries, join, distinctNames, heroHit, heroes) {
  p('## 7. Verdict');
  p();
  const dm = summaries.unitDamageType?.verdict ?? VALIDATION.UNKNOWN;
  const tm = summaries.unitTargetTeam?.verdict ?? VALIDATION.UNKNOWN;
  // BLOCKED means nothing could be confirmed, not "some raw values are unmapped".
  // Raw 0 is the largest group in both fields and OpenDota simply carries no
  // label for those abilities, so a partial answer is still an answer.
  const confirmedCount = (summaries.unitDamageType?.confirmed?.length ?? 0) + (summaries.unitTargetTeam?.confirmed?.length ?? 0);
  const verdict = dm === 'EXACT' && tm === 'EXACT' ? 'OPENDOTA_SEMANTICS_EXACT'
    : confirmedCount > 0 ? 'OPENDOTA_SEMANTICS_PARTIAL'
      : 'OPENDOTA_SEMANTICS_BLOCKED';
  p(`  Verdict: ${verdict}`);
  p();
  p(`  unitDamageType   ${dm} (${summaries.unitDamageType?.confirmed?.length ?? 0} confirmed)`);
  p(`  unitTargetTeam   ${tm} (${summaries.unitTargetTeam?.confirmed?.length ?? 0} confirmed)`);
  p(`  unitTargetFlags  ${summaries.unitTargetFlags?.verdict ?? VALIDATION.UNKNOWN}`);
  p(`  ability join     ${pct(join.matchedCount, distinctNames.size)} (${join.matchedCount}/${distinctNames.size})`);
  p(`  hero join        ${pct(heroHit, heroes.length)} (${heroHit}/${heroes.length})`);
  p();
  p('  §19: even a confirmed mapping is ability semantics only. It is NOT an');
  p('  EnemyCapability and carries no threat weighting.');
  p();
}


main();
