/**
 * ТЗ №10 research — item/build data sources.
 *
 * READ-ONLY. Touches nothing in production: it reads public/data, queries
 * STRATZ, and writes only to /tmp. No token is ever persisted or logged.
 *
 *   node scripts/item-research.mjs schema      # §2  schema introspection
 *   node scripts/item-research.mjs sample      # §10 the 5 required heroes
 *   node scripts/item-research.mjs timing      # §4  timing availability
 *   node scripts/item-research.mjs window      # §9  1 week vs 4 weeks
 *   node scripts/item-research.mjs position    # §12 does position change items
 *   node scripts/item-research.mjs metadata    # §6/§15 item identity + metadata
 *   node scripts/item-research.mjs all
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { StratzTransport, loadToken, BUCKET_SEC, BRACKETS } from './update-data-stratz.mjs';
import { getCompleteWeeklyBuckets } from './stratz/buckets.mjs';

const CACHE_DIR = '/tmp/stratz-research/cache';
const WI = getCompleteWeeklyBuckets(new Date(), 4);
const heroes = JSON.parse(readFileSync('public/data/heroes.json', 'utf8'));
const idOf = (n) => {
  const h = heroes.find((x) => x.name === n);
  if (!h) throw new Error(`hero not found: ${n}`);
  return h.id;
};

/** Cache on disk keyed by query hash. No token in the key, none in the payload. */
async function q(transport, query, tag) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const key = path.join(CACHE_DIR, `${tag}.json`);
  try {
    return JSON.parse(readFileSync(key, 'utf8'));
  } catch {
    /* cache miss */
  }
  const res = await transport.query(query);
  writeFileSync(key, JSON.stringify(res));
  return res;
}

const typeFields = async (t, name) => {
  const r = await t.query(`{ __type(name: "${name}") { name fields { name description type { name kind ofType { name kind ofType { name } } } } } }`);
  const ty = r.data?.__type;
  if (!ty) return null;
  console.log(`\n=== ${ty.name} (${ty.fields.length} fields) ===`);
  for (const f of ty.fields) {
    const tn = f.type.name || f.type.ofType?.name || f.type.ofType?.ofType?.name;
    console.log(`  ${f.name}: ${tn}`);
  }
  return ty;
};

// ---------------------------------------------------------------- §2 schema
async function schema() {
  const t = new StratzTransport(loadToken());
  await t.init();
  try {
    // `heroStats` returns the object HeroStatsQuery directly (not a list), so
    // the type name is the field's own type.
    const root = await t.query(`{ __schema { queryType { fields { name type { name kind ofType { name } } } } } }`);
    const hsqName = root.data.__schema.queryType.fields.find((f) => f.name === 'heroStats').type.name;
    const hsq = await t.query(`{ __type(name: "${hsqName}") { name fields { name args { name type { name kind ofType { name kind ofType { name } } } } type { name kind ofType { name } } } } }`);

    console.log('=== HeroStatsQuery: item-related fields ===');
    for (const f of hsq.data.__type.fields) {
      if (!/item/i.test(f.name)) continue;
      const a = f.args
        .map((x) => `${x.name}:${x.type.name || x.type.ofType?.name}${x.type.ofType?.ofType ? '<' + (x.type.ofType?.ofType.name) + '>' : ''}`)
        .join(', ');
      console.log(`  ${f.name}(${a}) -> ${f.type.name || f.type.ofType?.name}`);
    }

    console.log('\n=== batching (§17): LIST vs scalar per arg ===');
    const full = hsq.data.__type.fields.find((f) => f.name === 'itemFullPurchase');
    for (const a of full.args) {
      console.log(`  itemFullPurchase.${a.name}: ${a.type.kind}${a.type.ofType ? ` of ${a.type.ofType.name}` : ''}`);
    }

    for (const n of ['HeroItemPurchaseType', 'HeroItemStartingPurchaseType', 'HeroNeutralItemType', 'ItemType', 'ItemCategoriesType']) {
      await typeFields(t, n);
    }

    // Any item constants / item-typed args anywhere in the schema.
    const all = await t.query(`{ __schema { types { name kind } } }`);
    const itemTypes = all.data.__schema.types
      .filter((x) => /item/i.test(x.name || ''))
      .map((x) => `${x.kind === 'ENUM' ? 'E' : x.kind === 'OBJECT' ? 'O' : x.kind === 'INPUT_OBJECT' ? 'I' : 'S'} ${x.name}`);
    console.log('\n=== every item-named type in the schema ===');
    console.log('  ' + itemTypes.join('\n  '));
  } finally {
    await t.close();
  }
}

// ---------------------------------------------------------------- §10 sample
const SAMPLE = [
  ['Sniper', 1], ['Anti-Mage', 1], ['Wraith King', 1], ['Puck', 2], ['Bane', 4],
];
const ALL_POS = [1, 2, 3, 4, 5];

// NB: must stay SYNCHRONOUS. An `async` here returns a Promise, which the
// transport then serialises as {"query":{}} — which STRATZ rejects with a
// misleading "JSON body text could not be parsed ... BytePositionInLine: 10".
function itemQuery(heroId, positionIds, bucket) {
  return `{ heroStats { itemFullPurchase(
      heroId: ${heroId},
      week: ${bucket * BUCKET_SEC},
      bracketBasicIds: [${BRACKETS.join(', ')}],
      positionIds: [${positionIds.map((p) => `POSITION_${p}`).join(', ')}]
    ) { heroId position itemId instance time matchCount winCount winsAverage } } }`;
}

async function sample() {
  const t = new StratzTransport(loadToken());
  await t.init();
  try {
    for (const [name, pos] of SAMPLE) {
      const id = idOf(name);
      const res = await q(t, itemQuery(id, [pos], WI.buckets[3]), `sample-${name}-p${pos}`);
      const rows = res.data?.heroStats?.itemFullPurchase ?? [];
      console.log(`\n=== ${name} (#${id}) pos${pos}, week ${WI.buckets[3]} — ${rows.length} rows ===`);
      if (rows.length === 0) { console.log('  (empty)'); continue; }
      console.log('  raw row[0]:', JSON.stringify(rows[0]));
      const tot = rows.reduce((s, r) => s + (r.matchCount ?? 0), 0);
      const items = new Set(rows.map((r) => r.itemId));
      const times = new Set(rows.map((r) => r.time));
      const positions = new Set(rows.map((r) => r.position));
      console.log(`  distinct items=${items.size}  distinct time values=${times.size}  distinct positions=${[...positions].join(',')}`);
      console.log(`  time values: ${[...times].sort((a, b) => a - b).slice(0, 15).join(', ')}`);
      console.log(`  sum matchCount over rows: ${tot}`);
      console.log('  top 8 rows by matchCount:');
      for (const r of rows.slice().sort((a, b) => b.matchCount - a.matchCount).slice(0, 8)) {
        console.log(
          `    item=${String(r.itemId).padStart(5)} time=${String(r.time).padStart(6)} inst=${r.instance} ` +
          `match=${String(r.matchCount).padStart(8)} win=${String(r.winCount).padStart(8)} ` +
          `winsAvg=${r.winsAverage} wr=${((r.winCount / r.matchCount) * 100).toFixed(1)}%`,
        );
      }
    }
  } finally {
    await t.close();
  }
}

// §12 — does `positionIds` ACTUALLY filter, or is the `position` field a lying
// echo? Compare aggregate row identity across different position filters.
// If the two responses are byte-identical, the filter does nothing.
async function positionCheck() {
  const t = new StratzTransport(loadToken());
  await t.init();
  try {
    for (const nm of ['Bane', 'Kunkka']) {
      const id = idOf(nm);
      const b = WI.buckets[3];
      const seen = new Map();
      for (const p of [1, 2, 3, 4, 5]) {
        const res = await q(t, itemQuery(id, [p], b), `poscheck-${nm}-p${p}`);
        const rows = res.data?.heroStats?.itemFullPurchase ?? [];
        const tot = rows.reduce((s, r) => s + r.matchCount, 0);
        const echo = [...new Set(rows.map((r) => r.position))].join(',');
        // Fingerprint of the actual numbers, ignoring the echo field.
        const fp = rows
          .map((r) => `${r.itemId}/${r.instance}/${r.time}:${r.matchCount}`)
          .sort()
          .join('|');
        seen.set(fp, [...(seen.get(fp) ?? []), p]);
        console.log(
          `${nm} filter=POS_${p}: rows=${String(rows.length).padStart(4)} sumMatch=${String(tot).padStart(9)} echo=${echo} fingerprint#${[...seen.keys()].indexOf(fp) + 1}`,
        );
      }
      const dupes = [...seen.entries()].filter(([, ps]) => ps.length > 1);
      console.log(`  -> ${seen.size} distinct datasets across 5 filters; ${dupes.length ? `IDENTICAL: ${JSON.stringify(dupes)}` : 'all different (filter works)'}`);
    }
  } finally {
    await t.close();
  }
}

// §4/§5 — what is `time`? what is `matchCount`?
async function semantics() {
  const t = new StratzTransport(loadToken());
  await t.init();
  try {
    const id = idOf('Sniper');
    const b = WI.buckets[3];
    const res = await q(t, itemQuery(id, [1], b), `sample-Sniper-p1`);
    const rows = res.data.heroStats.itemFullPurchase;

    const times = [...new Set(rows.map((r) => r.time))].sort((a, b) => a - b);
    console.log('=== `time` values ===');
    console.log('  min', times[0], 'max', times[times.length - 1], 'count', times.length);
    console.log('  all:', times.join(','));
    console.log('  are they contiguous integers?', times.every((v, i) => i === 0 || v === times[i - 1] + 1));

    const byTime = new Map();
    for (const r of rows) byTime.set(r.time, (byTime.get(r.time) ?? 0) + r.matchCount);
    console.log('\n=== matchCount by time value (first 30) ===');
    for (const [tv, n] of [...byTime.entries()].sort((a, b) => a[0] - b[0]).slice(0, 30)) {
      console.log(`   t=${String(tv).padStart(3)}  ${String(n).padStart(9)}`);
    }

    // Is matchCount "games where bought" or "purchases"? Compare the per-time
    // sums with the hero's actual game count for the same slice.
    const stats = await q(
      t,
      `{ heroStats { stats(heroIds: [${id}], week: ${b * BUCKET_SEC}, bracketBasicIds: [${BRACKETS.join(',')}], groupByPosition: true) { position matchCount winCount } } }`,
      `sem-stats-sniper`,
    );
    console.log('\n=== Sniper games in the same week/bracket slice ===');
    for (const s of stats.data.heroStats.stats) console.log(`  ${s.position}: ${s.matchCount}`);

    const perTime = new Map();
    for (const r of rows) perTime.set(r.time, (perTime.get(r.time) ?? 0) + r.matchCount);
    const maxPerTime = Math.max(...perTime.values());
    const games = stats.data.heroStats.stats.find((s) => s.position === 'POSITION_1')?.matchCount ?? 0;
    console.log(`\n  hero games (pos1) = ${games}`);
    console.log(`  max matchCount in ANY single time bucket = ${maxPerTime}`);
    console.log(`  max <= games? ${maxPerTime <= games}  (if true, matchCount is games-at-that-time, not purchases)`);

    const sumAll = rows.reduce((s, r) => s + r.matchCount, 0);
    console.log(`  sum over all rows = ${sumAll}; sum/games = ${(sumAll / games).toFixed(2)} (mean items per game)`);
  } finally {
    await t.close();
  }
}

// §6/§15 — canonical item identity and metadata.
async function itemMeta() {
  const t = new StratzTransport(loadToken());
  await t.init();
  try {
    const root = await t.query(`{ __schema { queryType { fields { name args { name type { name kind ofType { name } } } type { name kind ofType { name } } } } } }`);
    console.log('=== Query root: constants / metadata ===');
    for (const f of root.data.__schema.queryType.fields) {
      if (!/constant|item/i.test(f.name)) continue;
      const a = f.args.map((x) => `${x.name}:${x.type.name || x.type.ofType?.name}`).join(', ');
      console.log(`  ${f.name}(${a}) -> ${f.type.name || f.type.ofType?.name}`);
    }
    for (const n of ['ItemType', 'ItemCategoriesType', 'ConstantItemType', 'ItemStatType', 'ItemAttributeType', 'ItemComponentType']) {
      await typeFields(t, n);
    }
    for (const n of ['LanguageEnum']) {
      const e = await t.query(`{ __type(name: "${n}") { kind enumValues { name } } }`);
      const ty = e.data?.__type;
      if (ty?.enumValues) console.log(`\n=== ${n} values ===\n  ${ty.enumValues.map((v) => v.name).join(', ')}`);
    }
    const cq = await t.query(`{ __type(name: "ConstantQuery") { fields { name args { name type { name kind ofType { name } } } type { name kind ofType { name } } } } }`);
    console.log('\n=== ConstantQuery fields ===');
    for (const f of cq.data.__type.fields) {
      const a = f.args.map((x) => `${x.name}:${x.type.name || x.type.ofType?.name}`).join(', ');
      console.log(`  ${f.name}(${a}) -> ${f.type.name || f.type.ofType?.name}`);
    }
    try {
      const r = await t.query('{ constants { items(language: ENGLISH) { id name displayName shortName isSupportFullItem image } } }');
      const items = r.data?.constants?.items ?? [];
      console.log(`\n=== constants.items: ${items.length} entries ===`);
      console.log('  raw[0]:', JSON.stringify(items[0]));
      const pick = (re) => items.filter((i) => re.test(i.name ?? '')).slice(0, 14);
      for (const [label, re] of [
        ['shard / scepter', /Shard|Scepter/i],
        ['consumables', /Tango|Glyph|Quelling|Smoke|Soul Ring|Faerie|Town Portal/i],
        ['recipes', /Recipe/i],
      ]) {
        console.log(`\n  ${label}:`);
        for (const i of pick(re)) console.log(`    ${String(i.id).padStart(4)} ${String(i.name).padEnd(28)} ${String(i.displayName).padEnd(28)} full=${i.isSupportFullItem}`);
      }
    } catch (e) {
      console.log(`\n  constants.items failed: ${String(e.message).slice(0, 240)}`);
    }
  } finally {
    await t.close();
  }
}

// §11 — can the source distinguish Sniper/Battle Fury from Anti-Mage/Battle Fury?
// No blacklist: this only asks whether the DATA separates them.
//
// BATTLE_FURY_ID is resolved from constants.items, not assumed. An earlier pass
// of this script hard-coded 135 and produced a nonsense comparison: 135 is
// Monkey King Bar. Verified via `item-research.mjs names`.
const BATTLE_FURY_ID = 145;

async function battleFury() {
  const t = new StratzTransport(loadToken());
  await t.init();
  try {
    const names = JSON.parse(readFileSync(path.join(CACHE_DIR, 'constants-items.json'), 'utf8'))
      .data.constants.items;
    const nm = (id) => names.find((i) => i.id === id)?.displayName ?? `id${id}`;
    console.log(`Battle Fury id = ${BATTLE_FURY_ID} (${nm(BATTLE_FURY_ID)})`);

    // Denominator: the hero's games in the SAME week+position slice, so the
    // comparison is a rate, not a raw count (Anti-Mage plays 9x Sniper's games).
    const statsCache = new Map();
    const gamesFor = async (heroId, pos, b) => {
      const key = `g-${heroId}-${pos}-${b}`;
      if (statsCache.has(key)) return statsCache.get(key);
      // No positionIds filter here: the `position` echo is unreliable (see the
      // §12 finding), so asking for one position and reading the echo back can
      // yield nothing. Request all positions and select by the echo instead.
      const r = await q(
        t,
        `{ heroStats { stats(heroIds: [${heroId}], week: ${b * BUCKET_SEC}, bracketBasicIds: [${BRACKETS.join(',')}], groupByPosition: true) { position matchCount } } }`,
        `g-all-${heroId}-${b}`,
      );
      const v = r.data.heroStats.stats.find((s) => s.position === `POSITION_${pos}`)?.matchCount ?? 0;
      statsCache.set(key, v);
      return v;
    };

    const b = WI.buckets[3];
    console.log('\n=== §11 Battle Fury sanity: same week, same brackets, purchase RATE ===');
    for (const [nmHero, pos] of [['Sniper', 1], ['Anti-Mage', 1], ['Wraith King', 1], ['Puck', 2], ['Bane', 4], ['Bane', 5], ['Kunkka', 3]]) {
      const res = await q(t, itemQuery(idOf(nmHero), [pos], b), `sample-${nmHero}-p${pos}`);
      const rows = res.data.heroStats.itemFullPurchase;
      const v = rows.filter((r) => r.itemId === BATTLE_FURY_ID)
        .reduce((s, r) => ({ games: s.games + r.matchCount, wins: s.wins + r.winCount }), { games: 0, wins: 0 });
      const games = await gamesFor(idOf(nmHero), pos, b);
      const rate = games > 0 ? (v.games / games) * 100 : 0;
      console.log(
        `  ${`${nmHero} pos${pos}`.padEnd(18)} BF games=${String(v.games).padStart(7)} / ${String(games).padStart(7)} hero games` +
        ` = ${rate.toFixed(1).padStart(5)}%   wr=${v.games ? ((v.wins / v.games) * 100).toFixed(1) : '-'}%`,
      );
    }
  } finally {
    await t.close();
  }
}

// Resolve the ids seen in purchase data back to names. Never assume an id.
async function names() {
  const t = new StratzTransport(loadToken());
  await t.init();
  try {
    const all = await q(t, '{ constants { items(language: ENGLISH) { id name displayName shortName } } }', 'constants-items');
    const byId = new Map(all.data.constants.items.map((i) => [i.id, i]));
    const seen = new Set();
    for (const tag of ['sample-Sniper-p1', 'sample-Anti-Mage-p1', 'sample-Wraith King-p1', 'sample-Puck-p2', 'sample-Bane-p4', 'poscheck-Bane-p5', 'poscheck-Kunkka-p3']) {
      try {
        const r = JSON.parse(readFileSync(path.join(CACHE_DIR, `${tag}.json`), 'utf8'));
        for (const row of r.data.heroStats.itemFullPurchase) seen.add(row.itemId);
      } catch { /* not cached */ }
    }
    const ids = [...seen].sort((a, b) => a - b);
    console.log(`=== ${ids.length} distinct item ids appeared in purchase data ===`);
    const recipes = [];
    for (const id of ids) {
      const it = byId.get(id);
      const nm = it ? it.displayName || it.name : '(NOT IN constants.items)';
      if (/recipe/i.test(it?.name ?? '')) recipes.push(id);
      console.log(`  ${String(id).padStart(5)}  ${String(nm).padEnd(30)} ${it?.name ?? ''}`);
    }
    console.log(`\nrecipe ids present in purchase data: ${recipes.length ? recipes.join(', ') : 'NONE'}`);
    const missing = ids.filter((id) => !byId.has(id));
    console.log(`ids with no constants entry: ${missing.length ? missing.join(', ') : 'none'}`);

    // Battle Fury, resolved rather than assumed.
    for (const id of [135, 136, 145, 170, 147, 143, 69, 36, 1, 75]) {
      const it = byId.get(id);
      console.log(`  id ${String(id).padStart(4)} = ${it ? it.displayName || it.name : '??'}`);
    }
  } finally {
    await t.close();
  }
}

// §9 — 1 complete week vs 4 complete weeks.
async function window() {
  const t = new StratzTransport(loadToken());
  await t.init();
  try {
    const names = JSON.parse(readFileSync(path.join(CACHE_DIR, 'constants-items.json'), 'utf8'))
      .data.constants.items;
    const nm = (id) => names.find((i) => i.id === id)?.displayName ?? `id${id}`;

    for (const [nmHero, pos] of [['Anti-Mage', 1], ['Bane', 4]]) {
      const perBucket = [];
      const perWindow = new Map();
      for (const b of WI.buckets) {
        const res = await q(t, itemQuery(idOf(nmHero), [pos], b), `win-${nmHero.replace(/\s/g, '')}-p${pos}-b${b}`);
        const rows = res.data.heroStats.itemFullPurchase;
        const agg = new Map();
        for (const r of rows) agg.set(r.itemId, (agg.get(r.itemId) ?? 0) + r.matchCount);
        perBucket.push({ b, rows: rows.length, items: agg.size, agg });
        for (const [k, v] of agg) perWindow.set(k, (perWindow.get(k) ?? 0) + v);
      }
      console.log(`\n=== ${nmHero} pos${pos}: per complete week ===`);
      for (const { b, rows, items } of perBucket) {
        console.log(`  week ${b}: rows=${String(rows).padStart(4)} distinct items=${String(items).padStart(3)}`);
      }
      const w1 = perBucket[3];
      const w4items = perWindow.size;
      console.log(`  1 week  -> ${w1.items} distinct items`);
      console.log(`  4 weeks -> ${w4items} distinct items (+${w4items - w1.items})`);

      // Rank stability: overlap of the top-15 between week 4 alone and the 4-week sum.
      const top1 = [...w1.agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k]) => k);
      const top4 = [...perWindow.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k]) => k);
      const overlap = top1.filter((k) => top4.includes(k)).length;
      console.log(`  top-15 overlap 1w vs 4w: ${overlap}/15`);
      console.log(`    only in 1-week top15: ${top1.filter((k) => !top4.includes(k)).map((k) => nm(k)).join(', ') || '(none)'}`);
      console.log(`    only in 4-week top15: ${top4.filter((k) => !top1.includes(k)).map((k) => nm(k)).join(', ') || '(none)'}`);
      const rare1 = [...w1.agg.entries()].filter(([, v]) => v < 50).length;
      const rare4 = [...perWindow.entries()].filter(([, v]) => v < 200).length;
      console.log(`  items with <50 purchases in 1 week: ${rare1};  <200 over 4 weeks: ${rare4}`);
    }
  } finally {
    await t.close();
  }
}

// §15 — does STRATZ item metadata cover what a build engine needs?
async function stat() {
  const t = new StratzTransport(loadToken());
  await t.init();
  try {
    for (const id of [145, 108, 609, 247, 44, 62]) {
      const r = await q(
        t,
        `{ constants { item(id: ${id}, language: ENGLISH) { id name displayName stat { cost isPurchasable isRecipe needsComponents stockMax initialStock isStackable isSupport isSideShop isSellable isDroppable quality aliases } components { index componentId } } } }`,
        `constitem-${id}`,
      );
      const it = r.data?.constants?.item;
      if (!it) { console.log(`id ${id}: NOT FOUND`); continue; }
      const s = it.stat ?? {};
      console.log(
        `${String(id).padStart(4)} ${String(it.displayName || it.name).padEnd(24)} ` +
        `cost=${String(s.cost).padStart(5)} purch=${s.isPurchasable} recipe=${s.isRecipe} needsComp=${s.needsComponents} ` +
        `stockMax=${s.stockMax} stack=${s.isStackable} sideShop=${s.isSideShop} comps=${JSON.stringify(it.components)}`,
      );
    }
  } finally {
    await t.close();
  }
}

// §17 — batching. `heroId` is a scalar (NON_NULL Short), so the only way to
// ask about N heroes in one request is GraphQL field aliasing. Verify that
// actually works before proposing it.
async function batching() {
  const t = new StratzTransport(loadToken());
  await t.init();
  try {
    const b = WI.buckets[3];
    const week = b * BUCKET_SEC;
    const ids = ['Sniper', 'Anti-Mage', 'Bane'].map(idOf);

    for (const n of [1, 2, 3]) {
      const parts = ids.slice(0, n).map((id, i) =>
        `h${i}: itemFullPurchase(heroId: ${id}, week: ${week}, bracketBasicIds: [${BRACKETS.join(',')}], positionIds: [POSITION_1, POSITION_2, POSITION_3, POSITION_4, POSITION_5]) { heroId itemId position time matchCount }`);
      const query = `{ heroStats { ${parts.join('\n')} } }`;
      const t0 = Date.now();
      const r = await t.query(query);
      const ms = Date.now() - t0;
      const counts = ids.slice(0, n).map((_, i) => r.data.heroStats[`h${i}`]?.length ?? 0);
      console.log(
        `  ${n} heroes aliased in one request: rows=[${counts.join(', ')}]  total=${counts.reduce((a, b) => a + b, 0)}  ${ms}ms  payload=${JSON.stringify(r).length} bytes`,
      );
    }

    // The decisive question for the data contract: if one request covers all 5
    // positions, can a consumer still tell WHICH position each row belongs to?
    // The `position` echo is unreliable (§12), so compare the combined response
    // against the union of the 5 single-position responses.
    const singles = new Map();
    for (const p of [1, 2, 3, 4, 5]) {
      const r = await t.query(`{ heroStats { itemFullPurchase(heroId: ${ids[2]}, week: ${week}, bracketBasicIds: [${BRACKETS.join(',')}], positionIds: [POSITION_${p}]) { itemId instance time matchCount } } }`);
      for (const row of r.data.heroStats.itemFullPurchase) {
        singles.set(`${row.itemId}/${row.instance}/${row.time}`, (singles.get(`${row.itemId}/${row.instance}/${row.time}`) ?? 0) + row.matchCount);
      }
    }
    const combined = await t.query(`{ heroStats { itemFullPurchase(heroId: ${ids[2]}, week: ${week}, bracketBasicIds: [${BRACKETS.join(',')}], positionIds: [POSITION_1, POSITION_2, POSITION_3, POSITION_4, POSITION_5]) { itemId instance time matchCount } } }`);
    const comb = new Map();
    for (const row of combined.data.heroStats.itemFullPurchase) {
      comb.set(`${row.itemId}/${row.instance}/${row.time}`, (comb.get(`${row.itemId}/${row.instance}/${row.time}`) ?? 0) + row.matchCount);
    }
    console.log(`\n  Bane: keys in union-of-5 = ${singles.size}, keys in combined = ${comb.size}`);
    let same = 0, diff = 0;
    for (const [k, v] of singles) if (comb.get(k) === v) same += 1; else diff += 1;
    console.log(`  keys with IDENTICAL count: ${same}; differing: ${diff}`);
    console.log(`  => combined response is the sum of the 5? ${diff === 0 && singles.size === comb.size}`);
    console.log('  => but position attribution is impossible from the combined response');
    console.log('     (the `position` echo is always POSITION_1 — §12).');
  } finally {
    await t.close();
  }
}

const cmd = process.argv[2] ?? 'schema';
if (cmd === 'schema') await schema();
else if (cmd === 'sample') await sample();
else if (cmd === 'position') await positionCheck();
else if (cmd === 'semantics') await semantics();
else if (cmd === 'meta') await itemMeta();
else if (cmd === 'bfury') await battleFury();
else if (cmd === 'names') await names();
else if (cmd === 'window') await window();
else if (cmd === 'stat') await stat();
else if (cmd === 'batching') await batching();
else if (cmd === 'probe') {
  // Minimal single-line probes, to isolate STRATZ's exact expectations.
  const t = new StratzTransport(loadToken());
  await t.init();
  try {
    const id = idOf('Sniper');
    const week = WI.buckets[3] * BUCKET_SEC;
    const tries = [
      ['no position filter, no time', `{ heroStats { itemFullPurchase(heroId: ${id}, week: ${week}) { itemId } } }`],
      ['with brackets', `{ heroStats { itemFullPurchase(heroId: ${id}, week: ${week}, bracketBasicIds: [${BRACKETS.join(',') }]) { itemId } } }`],
      ['with brackets+position', `{ heroStats { itemFullPurchase(heroId: ${id}, week: ${week}, bracketBasicIds: [${BRACKETS.join(',') }], positionIds: [POSITION_1]) { itemId } } }`],
      ['full field set', `{ heroStats { itemFullPurchase(heroId: ${id}, week: ${week}, bracketBasicIds: [${BRACKETS.join(',') }], positionIds: [POSITION_1]) { heroId position itemId instance time matchCount winCount winsAverage } } }`],
    ];
    for (const [label, query] of tries) {
      try {
        const r = await t.query(query);
        const rows = r.data?.heroStats?.itemFullPurchase ?? [];
        console.log(`OK   ${label}: ${rows.length} rows; first=${JSON.stringify(rows[0])}`);
      } catch (e) {
        console.log(`FAIL ${label}: ${String(e.message).slice(0, 220)}`);
      }
    }
  } finally {
    await t.close();
  }
} else if (cmd === 'newline') {
  // Why did the first multi-line attempt fail? Worth knowing before any
  // future generator reuses this query shape.
  const t = new StratzTransport(loadToken());
  await t.init();
  try {
    const id = idOf('Sniper');
    const week = WI.buckets[3] * BUCKET_SEC;
    const multi = `{ heroStats { itemFullPurchase(
      heroId: ${id},
      week: ${week}
    ) { itemId } } }`;
    const single = `{ heroStats { itemFullPurchase(heroId: ${id}, week: ${week}) { itemId } } }`;
    for (const [label, query] of [['multi-line', multi], ['single-line', single]]) {
      try {
        const r = await t.query(query);
        console.log(`OK   ${label}: ${r.data.heroStats.itemFullPurchase.length} rows`);
      } catch (e) {
        console.log(`FAIL ${label}: ${String(e.message).slice(0, 160)}`);
      }
    }
  } finally {
    await t.close();
  }
} else if (cmd === 'diagnose') {
  // Why do 4205/4206 appear in purchase data but not in the catalogue?
  const t = new StratzTransport(loadToken());
  await t.init();
  try {
    const r = await t.query(`{ constants { items(language: ENGLISH) {
      id name displayName stat { cost isPurchasable isRecipe needsComponents stockMax } } } }`);
    const all = r.data.constants.items;
    console.log('catalogue size:', all.length);
    for (const id of [4205, 4206, 145, 108]) {
      const it = all.find((x) => x.id === id);
      console.log(`  id ${id}:`, it ? JSON.stringify(it) : 'NOT IN CATALOGUE');
    }
    const noStat = all.filter((x) => !x.stat);
    console.log(`  entries with no stat object: ${noStat.length}`, noStat.slice(0, 6).map((x) => `${x.id}:${x.name}`));
    const notPurch = all.filter((x) => x.stat && x.stat.isPurchasable === false);
    console.log(`  entries with isPurchasable=false: ${notPurch.length}`, notPurch.slice(0, 6).map((x) => `${x.id}:${x.name}`));
    console.log(`  recipes: ${all.filter((x) => x.stat && x.stat.isRecipe === true).length}`);
    console.log(`  id range: ${Math.min(...all.map((x) => x.id))}..${Math.max(...all.map((x) => x.id))}`);
  } finally {
    await t.close();
  }
} else console.log('unknown command');

