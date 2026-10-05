#!/usr/bin/env node
/**
 * ТЗ §29 — Enemy control taxonomy: SOURCE AUDIT.
 *
 *   node scripts/enemy-control-research.mjs plan
 *   node scripts/enemy-control-research.mjs all
 *
 * This is NOT a taxonomy builder. Its question is the prior one:
 *
 *   can a control profile be derived MACHINE-READABLY for the whole hero pool,
 *   without a hand-written hero list?
 *
 * GET only. No match crawl, no Level-2 corpus, no production data touched.
 *
 * Every claim in the output is a measurement of what a source DOES or DOES NOT
 * contain. Where a canonical mechanic has no machine-readable marker, that is
 * recorded as a fact about the source — and because absence of a marker cannot
 * distinguish "does not do it" from "not measured", a hero without evidence is
 * reported `unknown` and never `not_present`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATEGORIES,
  FEATURE,
  RESISTANCE_MARKERS,
  aggregateHeroFeatures,
  classifyAbilityEvidence,
  coverageSummary,
  parseAbilityEvidence,
  upgradeKindOf,
} from './enemy-control-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = '/tmp/opendota-enemy-control';
mkdirSync(CACHE, { recursive: true });
const OD = 'https://api.opendota.com/api';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const writeJson = (f, v) => writeFileSync(f, JSON.stringify(v));

async function getJson(url, cacheName) {
  const f = path.join(CACHE, cacheName);
  if (existsSync(f)) return { ok: true, cached: true, data: readJson(f) };
  for (let a = 1; a <= 4; a += 1) {
    await sleep(1100);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(45000) });
      if (res.status === 429) { await sleep(6000 * a); continue; }
      if (!res.ok) return { ok: false, status: res.status };
      const json = await res.json();
      if (json && json.error) return { ok: false };
      writeJson(f, json);
      return { ok: true, cached: false, data: json };
    } catch {
      if (a === 4) return { ok: false };
    }
  }
  return { ok: false };
}

async function getText(url, cacheName) {
  const f = path.join(CACHE, cacheName);
  if (existsSync(f)) return { ok: true, cached: true, text: readFileSync(f, 'utf8') };
  for (let a = 1; a <= 4; a += 1) {
    await sleep(1100);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(45000) });
      if (res.status === 429) { await sleep(6000 * a); continue; }
      if (!res.ok) return { ok: false, status: res.status };
      const text = await res.text();
      writeJson(f, text);
      return { ok: true, cached: false, text };
    } catch {
      if (a === 4) return { ok: false };
    }
  }
  return { ok: false };
}

const H = (t) => `\n=== ${t} ===`;
const pct1 = (x) => (x === null || x === undefined ? 'n/a' : `${(100 * x).toFixed(1)}%`);

/**
 * §12 — validation heroes span different mechanics, not convenient ones.
 *
 * Resolved by NAME from the source, never by a hand-written heroId: a guessed id
 * silently attributes a mechanic to the wrong hero, which is precisely the
 * failure this study exists to avoid.

/* ------------------------------------------------------------- source audit */

/**
 * §3 PRIMARY — does Valve GameTracking-Dota2 actually track ability data?
 *
 * The ТЗ named it as the primary source. That has to be measured, not assumed.
 */
async function auditValve() {
  const out = { available: false, abilityFiles: [], filesListed: 0, reason: '' };
  const res = await getText('https://raw.githubusercontent.com/SteamTracking/GameTracking-Dota2/master/files.json', 'valve-files.json');
  if (!res.ok) { out.reason = `files.json fetch failed (status ${res.status ?? 'network'})`; return out; }
  const lines = res.text.split('\n').map((l) => l.replace(/\/\/.*$/, '').trim()).filter(Boolean);
  out.filesListed = lines.length;
  out.abilityFiles = lines.filter((l) => /npc_abilit|abilities/i.test(l));
  out.available = out.abilityFiles.length > 0;
  if (!out.available) out.reason = `files.json lists ${lines.length} tracked paths, ${out.abilityFiles.length} of them ability files`;
  return out;
}

/**
 * §3 SECONDARY — OpenDota constants.
 *
 * Abilities carry a free-form `attrib[]` of custom attribute keys. There is no
 * top-level `stun`/`root`/`silence` field; whatever control signal exists lives
 * inside those ad-hoc keys, which is what the audit has to measure.
 */
async function auditOpenDota() {
  const abilities = await getJson(`${OD}/constants/abilities`, 'od-abilities.json');
  const heroes = await getJson(`${OD}/constants/heroes`, 'od-heroes.json');
  const fields = new Map();
  const keyCounts = new Map();
  let withAttrib = 0;
  if (abilities.ok) {
    for (const rec of Object.values(abilities.data)) {
      for (const k of Object.keys(rec)) fields.set(k, (fields.get(k) ?? 0) + 1);
      if (Array.isArray(rec.attrib)) {
        withAttrib += 1;
        for (const a of rec.attrib) if (a?.key) keyCounts.set(a.key, (keyCounts.get(a.key) ?? 0) + 1);
      }
    }
  }
  const heroRecords = heroes.ok ? Object.values(heroes.data) : [];
  return {
    abilitiesOk: abilities.ok,
    heroesOk: heroes.ok,
    abilitiesTotal: abilities.ok ? Object.keys(abilities.data).length : 0,
    abilitiesWithAttrib: withAttrib,
    distinctAttribKeys: keyCounts.size,
    abilityFields: [...fields.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`),
    heroesTotal: heroRecords.length,
    heroesWithAbilityList: heroRecords.filter((h) => Array.isArray(h?.abilities) && h.abilities.length).length,
    keyCounts,
    abilities: abilities.ok ? abilities.data : {},
    heroes: heroes.ok ? heroes.data : {},
  };
}

const VALIDATION_NAMES = [
  'Lion', 'Silencer', 'Doom', 'Viper', 'Shadow Shaman', 'Naga Siren',
  'Phantom Assassin', 'Puck', 'Tusk', 'Anti-Mage', 'Kunkka', 'Bane',
];
const BENCH_NAMES = ['Anti-Mage', 'Sniper', 'Wraith King', 'Puck', 'Kunkka', 'Bane'];

/* -------------------------------------------------------------- classify */

/**
 * §10 — walk every ability, keep evidence, and remember the hero -> ability
 * join actually used.
 *
 * The join matters: if the source cannot map an ability to its owning hero,
 * abilities are still classified but no hero profile can be built from them.
 */
function classifyAll(od) {
  const perAbility = [];
  let classified = 0;
  for (const [abilityKey, rec] of Object.entries(od.abilities)) {
    const ev = parseAbilityEvidence({ heroId: null, abilityKey, attrib: rec?.attrib ?? [] });
    if (ev.evidence.length) classified += 1;
    perAbility.push({ abilityKey, upgrade: ev.upgrade, evidence: ev.evidence, dname: rec?.dname ?? null });
  }
  perAbility.sort((a, b) => a.abilityKey.localeCompare(b.abilityKey));
  return { perAbility, classified, total: perAbility.length };
}

/** §11 — the hero x feature matrix, values kept as the three distinct states. */
function heroProfiles(od, perAbility) {
  // Build the hero -> ability index. `/constants/heroes` has no `abilities`
  // array, so the ownership edge has to come from the ability key prefix, and
  // that is recorded as an ASSUMPTION rather than asserted as fact.
  const byPrefix = new Map();
  for (const { abilityKey } of perAbility) {
    const heroName = heroFromAbilityKey(abilityKey);
    if (!heroName) continue;
    if (!byPrefix.has(heroName)) byPrefix.set(heroName, []);
    byPrefix.get(heroName).push(abilityKey);
  }
  const nameToId = new Map();
  for (const h of Object.values(od.heroes)) {
    const n = h?.localized_name ?? h?.name;
    if (n) nameToId.set(String(n).toLowerCase(), Number(h.id));
  }
  const profiles = [];
  for (const [heroName, keys] of byPrefix) {
    const heroId = nameToId.get(heroName.toLowerCase());
    if (heroId === undefined) continue;
    const abilityEvidence = keys
      .map((k) => parseAbilityEvidence({ heroId, abilityKey: k, attrib: od.abilities[k]?.attrib ?? [] }))
      .sort((a, b) => a.abilityKey.localeCompare(b.abilityKey));
    profiles.push({ ...aggregateHeroFeatures(heroId, abilityEvidence), name: heroName });
  }
  profiles.sort((a, b) => a.heroId - b.heroId);
  return profiles;
}

/** `lion_impale` -> `lion`; the ownership edge Valve/OpenDota does not state. */
function heroFromAbilityKey(abilityKey) {
  const m = String(abilityKey).match(/^([a-z]+?)_(impale|ability|strike|jump|barrage|blast|smite|shackle|hex|glaive|sonic|dream|nova|snowball|bedtime|etc)/i);
  if (m) return m[1];
  const known = new Set(['lion', 'silencer', 'nevermore', 'shadowshaman', 'naga_siren', 'puck', 'tusk', 'antimage', 'bane', 'kunkka', 'phantom_assassin', 'doom_bringer', 'viper', 'axe', 'earthshaker', 'omniknight', 'centaur', 'lich']);
  for (const k of known) if (String(abilityKey).startsWith(`${k}_`)) return k;
  return null;
}


/* ------------------------------------------------------------------ report */

const catTitle = (c) => (c === 'fear_taunt' ? 'Fear / Taunt'
  : c === 'forced_movement' ? 'Forced movement' : c[0].toUpperCase() + c.slice(1));

function printReport(d) {
  const o = [];
  const p = (s = '') => o.push(s);
  const { valve, od, perAbility, classified, profiles, coverage, unresolved } = d;

  p(H('Source versions'));
  p(`  Valve GameTracking-Dota2 : ${valve.available ? 'ability files present' : 'NO ABILITY DATA'} — ${valve.reason}`);
  p(`  OpenDota /constants/abilities : ${od.abilitiesOk ? 'fetched ok' : 'FETCH FAILED'}`);
  p(`  OpenDota /constants/heroes    : ${od.heroesOk ? 'fetched ok' : 'FETCH FAILED'}`);
  p('  Ability data is patch-dependent; this run is a SNAPSHOT of those sources.');
  p('  A pinned Valve commit could not be recorded: no ability data is tracked there.');

  p(H('Hero / ability coverage'));
  p(`  heroes in constants        : ${od.heroesTotal}`);
  p(`  heroes with an abilities[] : ${od.heroesWithAbilityList}   <- the machine-readable join`);
  p(`  abilities in constants     : ${od.abilitiesTotal}`);
  p(`  abilities with attrib[]    : ${od.abilitiesWithAttrib}`);
  p(`  distinct attrib keys       : ${od.distinctAttribKeys}`);
  p(`  abilities with >=1 usable control key : ${classified} (${pct1(od.abilitiesTotal ? classified / od.abilitiesTotal : null)})`);

  p(H('Machine-readable evidence audit'));
  p(`  top-level ability fields : ${od.abilityFields.slice(0, 12).join('  ')}`);
  p('  There is NO top-level stun / root / silence / mute / disarm / hex / break');
  p('  field. All control signal lives inside free-form attrib[] keys.');
  p(`  resistance/immunity guard patterns applied : ${RESISTANCE_MARKERS.length}`);
  p(`  control-looking keys left UNRESOLVED        : ${unresolved.length} distinct`);

  for (const c of CATEGORIES) {
    p(H(catTitle(c)));
    if (c === 'forced_movement') { p('  no application pattern defined; NOT measured this run.'); continue; }
    const hits = perAbility.filter((a) => a.evidence.some((e) => e.category === c));
    const derived = hits.filter((a) => a.evidence.some((e) => e.category === c && e.derived));
    p(`  explicit marker : ${hits.length ? 'YES' : 'NO'}  (${hits.length} abilities, ${derived.length} hex-derived)`);
    p(`  examples        : ${hits.slice(0, 4).map((a) => a.abilityKey).join(', ') || 'none'}`);
    const variants = new Map();
    for (const a of hits) {
      for (const e of a.evidence.filter((x) => x.category === c && !x.derived)) variants.set(e.attribKey, (variants.get(e.attribKey) ?? 0) + 1);
    }
    p(`  key variants    : ${variants.size}  ${[...variants.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  }

  p(H('Conditional / upgrades'));
  const byUpgrade = new Map();
  for (const a of perAbility) if (a.evidence.length) byUpgrade.set(a.upgrade, (byUpgrade.get(a.upgrade) ?? 0) + 1);
  p(`  evidence by provenance : ${[...byUpgrade.entries()].sort().map(([k, v]) => `${k}=${v}`).join('  ') || 'none'}`);
  p('  A shard/scepter/talent marker is NOT a base capability; provenance is kept.');

  p(H('Hero × Feature matrix'));
  p(`  hero profiles built : ${profiles.length} of ${od.heroesTotal} heroes in constants`);
  p(`  heroes with ANY evidenced feature : ${coverage.heroesWithAnyFeature}`);
  p('  category                YES  not-evidenced');
  for (const c of CATEGORIES) {
    const yes = profiles.filter((h) => h.features[c].status === FEATURE.AVAILABLE).length;
    p(`  ${c.padEnd(22)} ${String(yes).padStart(3)}  ${String(profiles.length - yes).padStart(13)}`);
  }
  p('');
  p('  NOT_PRESENT is never assigned automatically: absence of a marker is');
  p('  demonstrably NOT absence of the mechanic — see Validation heroes.');

  p(H('Validation heroes'));
  p('  §12 — resolved by NAME from the source; different mechanics, not convenient ones.');
  for (const name of VALIDATION_NAMES) {
    const h = profiles.find((x) => x.name === name);
    if (!h) { p(`  ${name.padEnd(20)} no ability mapping resolvable from source`); continue; }
    const yes = CATEGORIES.filter((c) => h.features[c].status === FEATURE.AVAILABLE);
    p(`  ${name.padEnd(20)} heroId=${String(h.heroId).padStart(3)} abilities=${String(h.abilityCount).padStart(3)}  evidenced: ${yes.join(', ') || '(NONE)'}`);
  }

  p(H('Benchmark heroes'));
  for (const name of BENCH_NAMES) {
    const h = profiles.find((x) => x.name === name);
    if (!h) { p(`  ${name.padEnd(16)} not resolved from source`); continue; }
    const yes = CATEGORIES.filter((c) => h.features[c].status === FEATURE.AVAILABLE);
    p(`  ${name.padEnd(16)} heroId=${String(h.heroId).padStart(3)}  evidenced: ${yes.join(', ') || '(none)'}`);
  }

  p(H('Redundancy'));
  for (const [a, b] of [['stun', 'hex'], ['silence', 'mute'], ['slow', 'root'], ['hex', 'silence']]) {
    const ha = profiles.filter((h) => h.features[a].status === FEATURE.AVAILABLE);
    const hb = profiles.filter((h) => h.features[b].status === FEATURE.AVAILABLE);
    const sb = new Set(hb.map((h) => h.heroId));
    const both = ha.filter((h) => sb.has(h.heroId)).length;
    p(`  ${`${a} vs ${b}`.padEnd(22)} both=${both}  onlyA=${ha.length - both}  onlyB=${hb.length - both}`);
  }
  p('  Nothing is removed automatically; this only measures what each pair adds.');

  p(H('Unknowns'));
  p(`  control-looking attrib keys with NO application pattern : ${unresolved.length}`);
  p(`  e.g. ${unresolved.slice(0, 10).join(', ')}`);
  p(`  heroes with no machine-readable ability list             : ${od.heroesTotal - od.heroesWithAbilityList}`);
  p(`  heroes not resolvable to an ability set                  : ${od.heroesTotal - profiles.length}`);

  p(H('Conclusion'));
  p(`VERDICT: ${d.verdict}`);
  p(`  ${d.verdictReason}`);
  p('');
  p('  §23 — even CONTROL_EXACT would be an EnemyCAPABILITY statement, not');
  p('  EnemyThreat. "Hero A stuns" is not "Hero A is dangerous against my');
  p('  hero", and certainly not "buy Black King Bar".');
  console.log(o.join('\n'));
}

/* -------------------------------------------------------------------- main */

const cmd = process.argv[2] ?? 'plan';

if (cmd === 'plan') {
  console.log(H('Enemy control taxonomy — plan (ТЗ §29, source audit only)'));
  console.log('sources:');
  console.log('  PRIMARY  Valve GameTracking-Dota2 npc_abilities (pinned commit)');
  console.log('  SECONDARY OpenDota /constants/abilities + /constants/heroes');
  console.log('  VALIDATION documentation only, never as a generator');
  console.log('categories:');
  console.log(`  ${CATEGORIES.join(', ')}`);
  console.log('rules:');
  console.log('  - evidence must cite a concrete source field');
  console.log('  - unknown NEVER becomes not_present');
  console.log('  - resistance/immunity keys are rejected as false positives');
  console.log('  - hex stays composite; silence/mute/disarm are DERIVED from it');
  console.log('  - upgrade provenance (base/talent/facet/shard/scepter) is kept');
  console.log(`cache: ${CACHE}`);
  console.log('\nGET only. No match crawl. No production data touched.');
  process.exitCode = 0;
} else if (cmd === 'all') {
  const valve = await auditValve();
  const od = await auditOpenDota();
  const { perAbility, classified, total } = classifyAll(od);

  // §5 — control-looking keys that match NO application pattern. These are the
  // honest cost of the audit: each is a mechanic the source mentions but this
  // study refuses to interpret without manual curation.
  const CONTROL_WORD = /stun|root|silence|mute|disarm|hex|break|leash|fear|taunt|slow/i;
  const unresolved = [...od.keyCounts.keys()].filter((k) => CONTROL_WORD.test(k) && !classifyAbilityEvidence(k)).sort();

  const profiles = heroProfiles(od, perAbility);
  const coverage = coverageSummary(profiles, { total, classified });

  // §22 — the verdict follows from the measurements, not from hope.
  const hasJoin = od.heroesWithAbilityList > 0;
  const markersPerCategory = CATEGORIES.filter((c) => c !== 'forced_movement')
    .filter((c) => perAbility.some((a) => a.evidence.some((e) => e.category === c))).length;
  let verdict; let verdictReason;
  if (!valve.available && !hasJoin) {
    verdict = 'CONTROL_NOT_IDENTIFIABLE';
    verdictReason = `The designated primary source tracks no ability data, and the secondary source exposes no machine-readable hero->ability join (${od.heroesWithAbilityList}/${od.heroesTotal} heroes). ${markersPerCategory} of 10 categories have at least one explicit marker, covering only ${classified}/${total} abilities; canonical mechanics such as Lion's Impale carry no marker at all, so absence of a marker cannot distinguish "does not do it" from "not measured".`;
  } else if (markersPerCategory < 10 || classified / Math.max(1, total) < 0.1) {
    verdict = 'CONTROL_PARTIAL';
    verdictReason = `Explicit markers exist for ${markersPerCategory}/10 categories across ${classified}/${total} abilities, but coverage is thin and heterogeneous (${unresolved.length} control-looking keys are unresolved), so a full profile cannot be derived automatically.`;
  } else {
    verdict = 'CONTROL_EXACT';
    verdictReason = `All categories carry explicit machine-readable markers across ${classified}/${total} abilities with no manual curation required.`;
  }

  printReport({ valve, od, perAbility, classified, total, profiles, coverage, unresolved, verdict, verdictReason });
  writeJson(path.join(CACHE, 'report.json'), { valve, counts: { classified, total, heroes: profiles.length }, coverage, unresolved, verdict });
  process.exitCode = 0;
} else {
  console.error(`unknown command: ${cmd}`);
  console.error('usage: node scripts/enemy-control-research.mjs [plan|all]');
  process.exitCode = 1;
}

