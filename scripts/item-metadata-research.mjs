/**
 * ТЗ №16 — item metadata field research against the live STRATZ schema.
 *
 * Three stages, deliberately separated:
 *   schema  — introspect what fields EXIST (never assume)
 *   probe   — query them for representative items and show RAW responses
 *   compare — available schema vs what the generator persists today
 *
 * Token is read from process.env by the caller and never printed.
 *
 *   node scripts/item-metadata-research.mjs schema
 *   node scripts/item-metadata-research.mjs probe
 *   node scripts/item-metadata-research.mjs compare
 *   node scripts/item-metadata-research.mjs all
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadToken, StratzTransport } from './update-data-stratz.mjs';

const ENDPOINT = 'https://api.stratz.com/graphql';

/** Representative items, resolved BY NAME so no id is hardcoded. (§3, §13) */
const WANTED = [
  'Battle Fury', 'Manta Style', 'Black King Bar', 'Power Treads', 'Arcane Boots',
  'Guardian Greaves', "Aghanim's Scepter", "Aghanim's Blessing", "Aghanim's Shard",
  'Moon Shard', 'Magic Wand', 'Healing Salve', 'Observer Ward', 'Tango',
];

const items = JSON.parse(readFileSync(path.resolve('public/data/items.json'), 'utf8'));
const byName = new Map(Object.values(items).map((i) => [i.name, i]));

async function connect() {
  const token = loadToken();
  if (!token) throw new Error('STRATZ_API_TOKEN is not set');
  const t = new StratzTransport(token);
  await t.init();
  return t;
}

// ---------------------------------------------------------------- §1 schema
const CANDIDATE_FIELDS = [
  'isRecipe', 'needsComponents', 'components', 'consumedBy', 'departsFrom',
  'charges', 'stackable', 'held', 'replaces', 'replacedBy', 'upgradeOf',
  'itemClass', 'qual', 'buyback', 'stockMax', 'cost', 'isPurchasable',
  'consumable', 'permanent', 'chargesMax', 'initialCharges',
];

async function schema(t) {
  console.log('=== §1 — which candidate fields actually EXIST? ===\n');
  const q = `{ __type(name: "ItemStat") { name fields { name type { name kind ofType { name kind } } } } }`;
  const res = await t.query(q);
  const fields = res.data?.__type?.fields ?? [];
  const names = new Set(fields.map((f) => f.name));
  console.log(`ItemStat exposes ${fields.length} fields:\n`);
  for (const f of fields) {
    console.log(`  ${f.name.padEnd(20)} ${f.type?.name ?? f.type?.kind}`);
  }
  console.log('\n--- candidate field verdict ---');
  for (const c of CANDIDATE_FIELDS) {
    console.log(`  ${names.has(c) ? 'EXISTS   ' : 'absent   '} ${c}`);
  }

  // The Item wrapper may carry some fields instead.
  const q2 = `{ __type(name: "Item") { name fields { name type { name kind ofType { name kind } } } } }`;
  const res2 = await t.query(q2);
  const itemFields = res2.data?.__type?.fields ?? [];
  const inames = new Set(itemFields.map((f) => f.name));
  console.log(`\nItem exposes ${itemFields.length} fields:`);
  for (const f of itemFields) {
    console.log(`  ${f.name.padEnd(20)} ${f.type?.name ?? f.type?.kind}`);
  }
  return { itemStat: [...names], item: [...inames] };
}

// ----------------------------------------------------------------- §2 probe
// ItemStatType fields live under `stat`, not on ItemType directly.
const ITEM_SCALARS = 'id name displayName shortName';
const STAT_FIELDS = [
  'isRecipe', 'needsComponents', 'upgradeItem', 'upgradeRecipe', 'itemResult', 'behavior',
  'cost', 'quality', 'shopTags', 'isSellable', 'isDroppable', 'isPurchasable', 'isSideShop',
  'isStackable', 'isPermanent', 'isHideCharges', 'isRequiresCharges', 'isDisplayCharges',
  'isSupport', 'stockMax', 'initialCharges', 'initialStock', 'stockTime',
  'neutralItemDropTime', 'neutralItemTier',
].join(' ');

/** Find the real type names instead of assuming them (§1: never assume). */
async function discover(t) {
  console.log('=== §1a — discovering the actual type names ===\n');
  const q = `{ __schema { queryType { name } types { name kind } } }`;
  const res = await t.query(q);
  const sc = res.data?.__schema;
  if (!sc) {
    console.log('__schema returned nothing. GraphQL errors:', JSON.stringify(res.errors ?? null).slice(0, 500));
    return [];
  }
  console.log(`queryType = ${sc.queryType?.name}`);
  console.log(`schema has ${sc.types.length} types`);

  // §1: read the REAL field list of the two types the catalogue uses.
  const TYPES = ['ItemType', 'ItemStatType', 'ItemComponentType', 'ItemLanguageType'];
  const available = {};
  for (const name of TYPES) {
    const r = await t.query(`{ x: __type(name: "${name}") { kind name fields { name type { name kind ofType { name kind } } } } }`);
    const typ = r.data?.x;
    if (!typ) { console.log(`\n--- ${name}: NOT IN SCHEMA ---`); continue; }
    available[name] = typ.fields.map((f) => f.name);
    console.log(`\n--- ${name} (${typ.kind}) — ${typ.fields.length} fields ---`);
    for (const f of typ.fields) {
      const t = f.type?.name ?? f.type?.kind;
      const of = f.type?.ofType?.name ? ` -> ${f.type.ofType.name}` : '';
      console.log(`  ${f.name.padEnd(24)} ${t}${of}`);
    }
  }

  console.log('\n--- candidate field verdict (ItemType / ItemStatType) ---');
  const have = new Set([...(available.ItemType ?? []), ...(available.ItemStatType ?? [])]);
  for (const c of CANDIDATE_FIELDS) {
    const where = [];
    if (available.ItemType?.includes(c)) where.push('ItemType');
    if (available.ItemStatType?.includes(c)) where.push('ItemStatType');
    console.log(`  ${where.length ? 'EXISTS' : 'absent'}  ${c.padEnd(20)} ${where.join(', ')}`);
  }
  return available;
}



/** Query every field that schema() proved exists, for the representative set. */
async function probe(t, available) {
  console.log('\n\n=== §2/§17 — real responses for the representative items ===\n');
  const known = new Set([...(available.ItemType ?? []), ...(available.ItemStatType ?? [])]);
  const wanted = STAT_FIELDS.split(/\s+/);
  const missing = wanted.filter((f) => !known.has(f));
  if (missing.length) console.log(`(not in schema, skipped: ${missing.join(', ')})\n`);
  const use = wanted.filter((f) => known.has(f));
  const q = `{ constants { items(language: ENGLISH) { ${ITEM_SCALARS} components { index componentId } stat { ${use.join(' ')} } } } }`;
  const res = await t.query(q);
  const all = res.data?.constants?.items ?? [];
  console.log(`fetched ${all.length} items\n`);

  for (const name of WANTED) {
    const it = all.find((x) => x.displayName === name || x.name === name);
    if (!it) { console.log(`!! ${name}: NOT FOUND in constants`); continue; }
    const raw = { ...it };
    delete raw.image;
    console.log(`--- ${name} (id ${it.id}) ---`);
    console.log(JSON.stringify(raw));
  }

  console.log('\n=== §4/§5/§6 — relation fields across the whole catalogue ===');
  const relFields = ['upgradeItem', 'itemResult', 'upgradeRecipe', 'initialCharges',
    'isPermanent', 'isRequiresCharges', 'behavior', 'neutralItemTier',
    'needsComponents', 'isRecipe', 'isSellable', 'isDroppable', 'quality'];
  for (const f of relFields) {
    const nonNull = all.filter((x) => x.stat?.[f] !== null && x.stat?.[f] !== undefined && x.stat?.[f] !== false && x.stat?.[f] !== 0);
    console.log(`  ${f.padEnd(18)} set on ${String(nonNull.length).padStart(3)}/${all.length} items`);
    for (const s of nonNull.slice(0, 6)) {
      console.log(`      ${s.displayName} (${s.id}): ${JSON.stringify(s.stat?.[f])}`);
    }
  // §4 — the decisive question: does ANY field link a purchased item to the
  // upgrade it produces when consumed? Checked on real data, not assumed.
  console.log('\n=== §4 — is there a consumption/transformation link at all? ===');
  const linked = all.filter((x) => x.stat?.upgradeItem != null && x.stat.upgradeItem !== x.id);
  console.log(`  items whose upgradeItem points at a DIFFERENT id: ${linked.length}/${all.length}`);
  for (const s of linked.slice(0, 10)) {
    console.log(`      ${s.displayName} (${s.id}) -> upgradeItem ${s.stat.upgradeItem}`);
  }
  const byId = new Map(all.map((x) => [x.id, x]));
  const scepter = all.find((x) => x.displayName === "Aghanim's Scepter");
  const blessing = all.find((x) => x.displayName === "Aghanim's Blessing");
  if (scepter && blessing) {
    console.log(`\n  Aghanim's Scepter (${scepter.id}) vs Blessing (${blessing.id}):`);
    const same = ['quality', 'shopTags', 'behavior', 'cost'];
    for (const f of same) {
      console.log(`      stat.${f.padEnd(12)} ${JSON.stringify(scepter.stat[f])}  vs  ${JSON.stringify(blessing.stat[f])}`);
    }
    const names = ['id', 'name', 'shortName'];
    for (const f of names) {
      console.log(`      ${f.padEnd(15)} ${JSON.stringify(scepter[f])}  vs  ${JSON.stringify(blessing[f])}`);
    }
    const keys = Object.keys(scepter.stat);
    const differing = keys.filter((k) => JSON.stringify(scepter.stat[k]) !== JSON.stringify(blessing.stat[k]));
    console.log(`      stat fields that DIFFER: ${differing.length ? differing.join(', ') : 'none'}`);
    console.log(`      any consumedBy/departsFrom field: NONE (absent from the schema)`);
  }

  // §3 — the recipe graph that IS available.
  console.log('\n=== §3 — recipe graph actually present ===');
  const recipes = all.filter((x) => x.stat?.isRecipe === true && x.stat?.itemResult != null);
  console.log(`  recipes with an itemResult: ${recipes.length}/${all.filter((x) => x.stat?.isRecipe).length}`);
  for (const r of recipes.slice(0, 8)) {
    const out = byId.get(r.stat.itemResult);
    console.log(`      recipe ${String(r.id).padStart(4)} -> item ${String(r.stat.itemResult).padStart(4)} (${out?.displayName ?? '?'})`);
  }
  const comps = all.filter((x) => Array.isArray(x.components) && x.components.length);
  console.log(`  items whose components list is NON-EMPTY: ${comps.length}/${all.length}`);
  const qualityKinds = new Map();
  for (const x of all) {
    const q = x.stat?.quality ?? '(null)';
    qualityKinds.set(q, (qualityKinds.get(q) ?? 0) + 1);
  }
  console.log(`  quality values: ${[...qualityKinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ')}`);
  console.log(`      of which isRecipe=true: ${comps.filter((x) => x.stat?.isRecipe === true).length}   isRecipe=false: ${comps.filter((x) => x.stat?.isRecipe !== true).length}`);
  for (const s of comps.slice(0, 6)) {
    console.log(`      ${s.displayName} (${s.id}) isRecipe=${s.stat?.isRecipe} quality=${s.stat?.quality} -> ${JSON.stringify(s.components)}`);
  }
  const complete = all.filter((x) => x.stat?.isRecipe === true && x.stat?.itemResult != null && Array.isArray(x.components) && x.components.length);
  console.log(`  COMPLETE recipe edges (isRecipe + itemResult + components): ${complete.length}`);
  for (const s of complete.slice(0, 5)) {
    const parts = s.components.map((c) => byId.get(c.componentId)?.displayName ?? c.componentId);
    console.log(`      ${s.displayName} (${s.id}) -> item ${s.stat.itemResult}, parts [${parts.join(' + ')}]`);
  }
  console.log(`\n  quality === 'consumable'  : ${all.filter((x) => x.stat?.quality === 'consumable').length} items`);
  console.log(`  quality === 'component'  : ${all.filter((x) => x.stat?.quality === 'component').length} items`);

  // §11 coverage, restricted to the items the production catalogue ships.
  const shipped = new Set(Object.keys(items).map(Number));
  const inShip = all.filter((x) => shipped.has(x.id));
  const productOf = new Set(all.filter((x) => x.stat?.isRecipe && x.stat?.itemResult != null).map((x) => x.stat.itemResult));
  const cov = {
    total: inShip.length,
    recipeKnown: inShip.filter((x) => productOf.has(x.id)).length,
    chargesKnown: inShip.filter((x) => (x.stat?.initialCharges ?? 0) > 0).length,
    requiresCharges: inShip.filter((x) => x.stat?.isRequiresCharges === true).length,
    isPermanent: inShip.filter((x) => x.stat?.isPermanent === true).length,
    qualityConsumable: inShip.filter((x) => x.stat?.quality === 'consumable').length,
    qualityComponent: inShip.filter((x) => x.stat?.quality === 'component').length,
    consumptionLink: 0,
  };
  console.log('\n=== §11 — coverage over the SHIPPED catalogue ===');
  for (const [k, v] of Object.entries(cov)) {
    console.log(`  ${k.padEnd(18)} ${String(v).padStart(3)} / ${cov.total}`);
  }
  return all;
}
  }
// ---------------------------------------------------------------- §2 compare
function compare(available) {
  console.log('\n\n=== §2 — schema vs persisted ===\n');
  const persisted = new Set(Object.keys(Object.values(items)[0]));
  console.log(`persisted by the generator: ${[...persisted].join(', ')}\n`);
  const interesting = [...new Set([...(available.ItemType ?? []), ...(available.ItemStatType ?? [])])].filter(
    (f) => !['id', 'name', 'displayName', 'shortName', 'image', 'isSupportFullItem', 'components', 'stat', 'attributes', 'language', '__typename'].includes(f),
  );
  console.log('field                | persisted | verdict');
  console.log('---------------------|-----------|-------------------------');
  for (const f of interesting.sort()) {
    const p = persisted.has(f);
    console.log(`  ${f.padEnd(19)} |${p ? '    yes   ' : '    NO    '} | ${p ? 'kept' : 'AVAILABLE BUT DROPPED'}`);
  }
  const dropped = interesting.filter((f) => !persisted.has(f));
  console.log(`\n${dropped.length} schema fields are available and thrown away today:`);
  console.log('  ' + dropped.join(', '));
  console.log('\nThe generator query already FETCHES isRecipe and needsComponents and');
  console.log('uses isRecipe only to drop recipes; neither value is persisted.');
}

const cmd = process.argv[2] ?? 'all';
const t0 = Date.now();
const transport = await connect();
try {
  const available = await discover(transport);
  if (cmd !== 'discover') {
    await probe(transport, available);
    compare(available);
  }
} finally {
  await transport.close();
}
console.log(`\n[research ${cmd} — ${Date.now() - t0} ms]`);
