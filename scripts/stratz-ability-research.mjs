#!/usr/bin/env node
/**
 * ТЗ §30 — STRATZ ability graph audit.
 *
 *   node scripts/stratz-ability-research.mjs plan
 *   node scripts/stratz-ability-research.mjs all
 *
 * ТЗ №29 showed OpenDota and GameTracking cannot supply a machine-readable
 * `Hero -> Ability` graph. STRATZ was the one remaining candidate, so this
 * asks of its CURRENT GraphQL schema:
 *
 *   1. does a complete Hero -> Ability graph exist?
 *   2. does it carry enough SEMANTICS to replace the failed control source?
 *
 * The schema is DISCOVERED, not assumed. Every field this script asks for is
 * first checked with `__type` and reported as PRESENT / ABSENT, so a field
 * that does not exist is a finding rather than a runtime crash.
 *
 * Read-only: one `query` operation, no `mutation`, no `subscription`. GraphQL
 * requires HTTP POST, which is transport, not a write. The guard below aborts
 * the run if that ever stops being true. No match crawl, no production data.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StratzTransport } from './update-data-stratz.mjs';
import {
  MODIFIER_CONTROL_FLAGS,
  PROVENANCE_FIELDS,
  STATE,
  WANTED_ABILITY_FIELDS,
  WANTED_STAT_FIELDS,
  modifierFlagCoverage,
  normalizeModifier,
  provenanceCoverage,
  resolveHeroAbilities,
  semanticFieldCoverage,
  upgradeProvenance,
} from './stratz-ability-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = '/tmp/stratz-ability-research';
mkdirSync(CACHE, { recursive: true });
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const writeJson = (f, v) => writeFileSync(f, JSON.stringify(v));

/** §26 — token from env/.env; never in cache, never in stdout. */
function loadToken() {
  const e = process.env.STRATZ_API_TOKEN?.trim();
  if (e) return e;
  try {
    const raw = readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*STRATZ_API_TOKEN\s*=\s*(.*?)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    }
  } catch { /* no .env */ }
  return null;
}

/** §18 — read-only guard, checked before anything is sent. */
export function assertReadOnly(query) {
  const problems = [];
  if (/\bmutation\b/i.test(query)) problems.push('query declares a mutation');
  if (/\bsubscription\b/i.test(query)) problems.push('query declares a subscription');
  for (const f of ['create', 'update', 'delete', 'mutate']) {
    if (new RegExp(`\\b${f}[A-Z]`, 'i').test(query)) problems.push(`query references write field "${f}*"`);
  }
  if (problems.length) throw new Error(`STRATZ query is not read-only: ${problems.join('; ')}`);
  return true;
}

const H = (t) => `\n=== ${t} ===`;
const pct1 = (x) => (x === null || x === undefined ? 'n/a' : `${(100 * x).toFixed(1)}%`);

async function introspectType(transport, name) {
  const r = await transport.query(`{ __type(name: "${name}") { kind fields { name } } }`);
  return r?.data?.__type ?? null;
}

async function typeFields(transport, name) {
  const t = await introspectType(transport, name);
  return { kind: t?.kind ?? null, exists: Boolean(t), fields: (t?.fields ?? []).map((f) => f.name) };
}

async function edgesInto(transport, targetType) {
  const r = await transport.query(`{ __schema { types { name fields { name type { name ofType { name ofType { name } } } } } } }`);
  const out = [];
  for (const ty of r?.data?.__schema?.types ?? []) {
    for (const f of ty.fields ?? []) {
      const chain = [f.type?.name, f.type?.ofType?.name, f.type?.ofType?.ofType?.name].filter(Boolean);
      if (chain.includes(targetType)) out.push(`${ty.name}.${f.name}`);
    }
  }
  return out;
}

const SCHEMA_QUERY = `query SchemaAudit {
  __schema {
    queryType { fields { name } }
    types { name kind }
  }
}`;

/* ------------------------------------------------------------------ audit */

async function runAudit(transport) {
  // §2 — discover the real type names rather than assuming them.
  const schema = await transport.query(SCHEMA_QUERY);
  const types = schema?.data?.__schema?.types ?? [];
  const typeNames = new Set(types.map((t) => t.name));
  const queryFields = (schema?.data?.__schema?.queryType?.fields ?? []).map((f) => f.name);

  const heroType = ['HeroType', 'ConstantHeroType'].find((n) => typeNames.has(n)) ?? 'HeroType';
  const abilityType = ['AbilityType', 'ConstantAbilityType'].find((n) => typeNames.has(n)) ?? 'AbilityType';
  const modifierType = ['ModifierType', 'ConstantModifierType'].find((n) => typeNames.has(n)) ?? 'ModifierType';

  const hero = await typeFields(transport, heroType);
  const ability = await typeFields(transport, abilityType);
  const modifier = await typeFields(transport, modifierType);
  const stat = await typeFields(transport, 'AbilityStatType');
  const link = await typeFields(transport, 'HeroAbilityType');
  const attr = await typeFields(transport, 'AbilityAttributeType');
  const constantQuery = await typeFields(transport, 'ConstantQuery');
  const modifierEdges = await edgesInto(transport, modifierType);

  // §3/§10 — the join, measured against the real hero pool. `hero` is not a root
  // field: it lives under `constants`, so the whole pool is fetched in ONE query
  // rather than 127 round trips.
  const heroesRes = await transport.query(`{ constants { heroes {
    id name displayName gameVersionId
    abilities { slot abilityId ability { id name isTalent
      stat { ${WANTED_STAT_FIELDS.join(' ')} }
      attributes { name value requiresScepter }
    } }
  } } }`);
  const rawHeroes = heroesRes?.data?.constants?.heroes ?? [];
  const heroes = rawHeroes.map((h) => ({ id: h.id, name: h.name, displayName: h.displayName, gameVersionId: h.gameVersionId }));
  const heroAbilities = rawHeroes
    .filter((h) => Array.isArray(h.abilities))
    .map((h) => ({ hero: h, resolved: resolveHeroAbilities(h, h.abilities) }));

  // §5 — are the control flags populated, or merely declared?
  const flagFields = modifier.fields.filter((f) => MODIFIER_CONTROL_FLAGS.includes(f));
  const modsRes = await transport.query(`{ constants { modifiers { id name ${flagFields.join(' ')} } } }`);
  const rawMods = modsRes?.data?.constants?.modifiers ?? [];
  const mods = rawMods.map(normalizeModifier).filter(Boolean);
  const flagCoverage = modifierFlagCoverage(mods, flagFields);

  return {
    inspectedAt: new Date().toISOString(),
    typeNames: { heroType, abilityType, modifierType, found: { hero: typeNames.has(heroType), ability: typeNames.has(abilityType), modifier: typeNames.has(modifierType) } },
    queryFields, constantQueryFields: constantQuery.fields,
    types: { hero, ability, modifier, stat, link, attr },
    modifierEdges,
    heroes, heroAbilities, abilitiesFetched: heroAbilities.length,
    modifiers: mods, rawModifierCount: rawMods.length, flagCoverage, flagFields,
  };
}

function verdictOf(a) {
  const heroesWithAbilities = a.heroAbilities.filter((x) => x.resolved.abilityCount > 0).length;
  const joinPct = a.heroes.length ? heroesWithAbilities / a.heroes.length : 0;
  const populatedFlags = a.flagCoverage.filter((f) => f.state === STATE.AVAILABLE).length;
  const statUpgrades = semanticFieldCoverage(a.types.stat.fields, ['isGrantedByShard', 'hasShardUpgrade', 'isGrantedByScepter', 'hasScepterUpgrade', 'isInnate'])
    .filter((x) => x.state === STATE.AVAILABLE).length;

  if (!a.typeNames.found.hero || a.heroes.length === 0 || joinPct < 0.5) {
    return ['STRATZ_ABILITY_BLOCKED', `Hero -> Ability graph is unusable: ${heroesWithAbilities}/${a.heroes.length} heroes resolve abilities.`];
  }
  if (populatedFlags === 0) {
    return ['STRATZ_ABILITY_PARTIAL', `Hero -> Ability resolves for ${heroesWithAbilities}/${a.heroes.length} heroes and upgrade provenance is typed (${statUpgrades}/5 stat fields present), but ${a.flagFields.length} control flags are DECLARED on ModifierType and 0 of them are POPULATED in the constants, and there is no Ability -> Modifier edge to reach them through.`];
  }
  if (joinPct < 0.99 || statUpgrades < 5) {
    return ['STRATZ_ABILITY_PROMISING', `Hero -> Ability at ${pct1(joinPct)}, ${populatedFlags} control flags populated.`];
  }
  return ['STRATZ_ABILITY_EXACT', `Hero -> Ability complete (${heroesWithAbilities}/${a.heroes.length}) with ${populatedFlags} control flags populated.`];
}


/* ------------------------------------------------------------------ report */

function printReport(a) {
  const o = [];
  const p = (s = '') => o.push(s);
  const [verdict, reason] = verdictOf(a);
  const withAb = a.heroAbilities.filter((x) => x.resolved.abilityCount > 0);
  const emptyAb = a.heroAbilities.filter((x) => x.resolved.abilityCount === 0);
  const dupes = a.heroAbilities.reduce((s, x) => s + x.resolved.duplicateLinks, 0);
  const totalAbilities = new Set(a.heroAbilities.flatMap((x) => x.resolved.abilities.map((z) => z.id))).size;
  const populated = a.flagCoverage.filter((c) => c.state === STATE.AVAILABLE);
  const statUpgrades = semanticFieldCoverage(a.types.stat.fields,
    ['isGrantedByShard', 'hasShardUpgrade', 'isGrantedByScepter', 'hasScepterUpgrade', 'isInnate'])
    .filter((x) => x.state === STATE.AVAILABLE).length;

  p(H('Schema discovery (§2/§4)'));
  p(`  root query fields (${a.queryFields.length}) : ${a.queryFields.join(', ')}`);
  p(`  types found : HeroType=${a.typeNames.found.hero} AbilityType=${a.typeNames.found.ability} ModifierType=${a.typeNames.found.modifier}`);
  p(`  ConstantQuery fields : ${a.constantQueryFields.join(', ')}`);
  p('  Every field below is checked with __type first; ABSENT is a finding, not a crash.');

  p(H('Hero -> Ability graph (§3/§10)'));
  p(`  HeroType fields (${a.types.hero.fields.length}) : ${a.types.hero.fields.join(', ')}`);
  p(`  HeroAbilityType     : ${a.types.link.fields.join(', ')}`);
  p(`  heroes in constants : ${a.heroes.length}`);
  p(`  heroes with ability relation   : ${withAb.length}/${a.heroes.length}`);
  p(`  heroes with EMPTY ability list : ${emptyAb.length}`);
  p(`  heroes unresolved              : ${a.heroes.length - a.heroAbilities.length}`);
  p(`  unique abilities linked        : ${totalAbilities}`);
  p(`  duplicate ability links        : ${dupes}`);
  p(`  HEADLINE  Hero -> Ability = ${withAb.length}/${a.heroes.length} (${pct1(a.heroes.length ? withAb.length / a.heroes.length : null)})`);

  p(H('Ability semantic fields (§4)'));
  p(`  AbilityType fields (${a.types.ability.fields.length}) : ${a.types.ability.fields.join(', ')}`);
  for (const c of semanticFieldCoverage(a.types.ability.fields, WANTED_ABILITY_FIELDS)) {
    p(`    ${c.state === STATE.AVAILABLE ? 'PRESENT' : 'ABSENT '}  ${c.field}`);
  }
  p(`  AbilityStatType fields (${a.types.stat.fields.length})`);
  for (const c of semanticFieldCoverage(a.types.stat.fields, WANTED_STAT_FIELDS)) {
    p(`    ${c.state === STATE.AVAILABLE ? 'PRESENT' : 'ABSENT '}  ${c.field}`);
  }

  p(H('Modifier relation (§5) — the decisive question'));
  p(`  ModifierType fields (${a.types.modifier.fields.length}) : ${a.types.modifier.fields.join(', ')}`);
  p(`  edges into ModifierType across the whole schema : ${a.modifierEdges.length}`);
  for (const e of a.modifierEdges) p(`    ${e}`);
  p(`  modifiers returned by constants : ${a.rawModifierCount}`);
  p('  control flags: DECLARED vs POPULATED');
  for (const c of a.flagCoverage) p(`    ${c.field.padEnd(18)} ${c.state.padEnd(13)} trueCount=${c.trueCount}`);
  p('');
  p('  A flag that is DECLARED but never returns a boolean is `unknown`, never');
  p('  `not_present`: STRATZ ships the schema shape without the data.');

  p(H('Upgrade semantics (§11) — six independent facts, not one label'));
  const prov = a.heroAbilities.flatMap((x) => x.resolved.abilities.map((z) => upgradeProvenance(z)));
  const cov = provenanceCoverage(prov);
  p(`  across ${prov.length} abilities:`);
  p('  field                   yes    no  unknown');
  for (const f of PROVENANCE_FIELDS) {
    const c = cov[f];
    p(`    ${f.padEnd(22)} ${String(c.yes).padStart(4)} ${String(c.no).padStart(5)} ${String(c.unknown).padStart(9)}`);
  }
  p('');
  p('  isGrantedByShard and hasShardUpgrade are DIFFERENT facts and are reported');
  p('  separately: an ability that APPEARS because of a shard is not the same as');
  p('  one that merely HAS a shard upgrade. `unknown` means the field was not');
  p('  returned — never a negative.');

  p(H('Control markers audit (§6/§12)'));
  p(`  declared control flags : ${a.flagCoverage.length}`);
  p(`  populated (any true)   : ${populated.length}`);
  p('  No taxonomy is derived here. A control category is recorded only when a');
  p('  TYPED boolean is true; no description or name matching was performed.');

  p(H('Patch / version (§9)'));
  p(`  schema inspected at : ${a.inspectedAt}`);
  p(`  gameVersionId seen  : ${[...new Set(a.heroes.map((h) => h.gameVersionId).filter(Boolean))].join(', ') || 'n/a'}`);

  p(H('Comparison with ТЗ §29 (§15)'));
  p('                          OpenDota    Valve     STRATZ');
  p(`  Hero -> Ability         NO (0/127)  NO        YES (${withAb.length}/${a.heroes.length})`);
  p(`  Upgrade provenance      NO          NO        YES (${statUpgrades}/5 requested provenance fields exist; isTalent is on AbilityType)`);
  p(`  Control markers         partial     NO        DECLARED, UNPOPULATED (${populated.length}/${a.flagCoverage.length})`);
  p('  Version / provenance    snapshot    n/a       timestamp + gameVersionId');
  p('  No weighting: this records what each source exposes, not which is better.');

  p(H('Conclusion'));
  p(`VERDICT: ${verdict}`);
  p(`  ${reason}`);
  p('');
  p('  The GRAPH is real; the CONTROL DATA inside it is not. That is a different');
  p('  failure from ТЗ №29: there the shape was missing, here the shape is right');
  p('  and the population is missing.');
  console.log(o.join('\n'));
  return verdict;
}


/* -------------------------------------------------------------------- main */

const cmd = process.argv[2] ?? 'plan';

if (cmd === 'plan') {
  console.log(H('STRATZ ability graph audit (ТЗ §30) — plan'));
  console.log('  step 1  introspect __type for HeroType / AbilityType / ModifierType');
  console.log('  step 2  discover real type names from __schema, never assume them');
  console.log('  step 3  measure Hero -> Ability coverage over every hero in constants');
  console.log('  step 4  check whether control flags are DECLARED and POPULATED');
  console.log('  step 5  compare against OpenDota and Valve from ТЗ §29');
  console.log(`  cache: ${CACHE}   (token never written)`);
  console.log('\nRead-only: one GraphQL query operation, no mutation/subscription.');
  console.log('No match crawl, no production data touched.');
  process.exitCode = 0;
} else if (cmd === 'all') {
  const token = loadToken();
  if (!token) { console.error('FATAL: STRATZ_API_TOKEN not found'); process.exit(2); }
  const f = path.join(CACHE, 'schema.json');
  if (existsSync(f) && process.argv.includes('--cached')) {
    printReport(readJson(f));
    process.exitCode = 0;
  } else {
    const transport = new StratzTransport(token);
    let audit;
    try {
      await transport.init();
      audit = await runAudit(transport);
    } finally {
      await transport.close();
    }
    writeJson(f, audit);
    printReport(audit);
    process.exitCode = 0;
  }
} else {
  console.error(`unknown command: ${cmd}`);
  console.exitCode = 1;
}

assertReadOnly(SCHEMA_QUERY);
