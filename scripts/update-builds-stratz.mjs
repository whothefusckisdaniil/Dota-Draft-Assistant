#!/usr/bin/env node
/**
 * Weekly hero builds → public/builds/ (see scripts/stratz/builds.mjs).
 *
 *   public/builds/index.json      window, patch, names/keys of every item and
 *                                 ability the builds reference (EN + RU)
 *   public/builds/<heroId>.json   { heroId, positions: { pos: { ALL | bracket: Build } } }
 *
 * Same window as the matchups (meta.json → matchupWindow: last 30 days of the
 * current patch, bucket weights), same rank brackets, and only the positions
 * the hero is really played at (positions.json, the app's eligibility rule).
 *
 * Runs daily after the data refresh but rebuilds only when due: no builds yet,
 * a new patch, the builds are ≥ 7 days old, the roster changed, or --force.
 * ~1 request per hero per weekly bucket (~640, ~25 min) — well inside the
 * token's limits (8/s, 150/min, 1 500/h). Written to builds.__next and swapped
 * in only after the whole set passes validateBuilds; on any error the old
 * builds stay untouched.
 *
 * Usage: node scripts/update-builds-stratz.mjs [--force] [--heroes 26,1]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StratzTransport, loadToken, BUCKET_SEC, BRACKETS } from './update-data-stratz.mjs';
import { POSITION_ELIGIBILITY } from './stratz/eligibility.mjs';
import { accumulateHero, addAllRanks, buildHeroQuery, summarizeBuild, summarizeLanes, validateBuilds } from './stratz/builds.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'public', 'data');
const OUT = path.join(ROOT, 'public', 'builds');
const OPEN_DOTA = 'https://api.opendota.com/api';
const MAX_AGE_DAYS = 7;

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'lastpick-builds' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt >= 4) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

/** Is a rebuild due? Returns a reason or null. */
export function rebuildReason({ index, meta, heroIds, now = new Date(), force = false }) {
  if (force) return 'FORCE';
  if (!index) return 'NO_BUILDS';
  if (index.patch !== meta.latestPatch) return 'NEW_PATCH';
  const age = (now.getTime() - Date.parse(index.generatedAt)) / 86_400_000;
  if (!(age < MAX_AGE_DAYS - 0.25)) return 'WEEKLY';
  // First week of a patch: each day adds a lot of new-patch games (new
  // talents start with a handful of picks), so rebuild daily until it settles.
  if (meta.matchupWindow?.patch?.mode === 'YOUNG_PATCH_FILLED' && !(age < 0.75)) return 'YOUNG_PATCH';
  const built = new Set(index.heroes);
  if (heroIds.some((id) => !built.has(id))) return 'ROSTER_CHANGED';
  return null;
}

/** name → id from OpenDota's ability_ids. Some keys list several ids
 *  ("3060,1617"): the first one is the current id (Number() made them NaN). */
export function abilityIdMap(abilityIds) {
  const out = new Map();
  for (const [ids, name] of Object.entries(abilityIds)) {
    const id = Number(String(ids).split(',')[0]);
    if (Number.isFinite(id) && !out.has(name)) out.set(name, id);
  }
  return out;
}

/** A usable display name: STRATZ text with numbers → OpenDota text without its
 *  `{s:…}` templates → a readable key. Never the raw `special_bonus_…` key. */
export function abilityDisplayName({ key, stratz, openDota }) {
  const raw = (x) => !x || x === key || /^special_bonus_/.test(x);
  if (!raw(stratz)) return stratz;
  if (openDota && !raw(openDota)) {
    const cleaned = openDota.replace(/[+\-–]?\{s:[^}]+\}[%s]?\s*/g, '').replace(/\s+/g, ' ').trim();
    if (cleaned.length >= 4) return cleaned;
  }
  const words = String(key ?? '').replace(/^special_bonus_(unique_)?/, '').replace(/_/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : String(key);
}

async function fetchNames(transport) {
  const [abilityIds, odAbilities] = await Promise.all([
    getJson(`${OPEN_DOTA}/constants/ability_ids`),
    getJson(`${OPEN_DOTA}/constants/abilities`),
  ]);
  const stratz = new Map();
  for (const lang of ['ENGLISH', 'RUSSIAN']) {
    const r = await transport.query(`{ constants { abilities(language: ${lang}) { id name language { displayName } } } }`);
    for (const a of r.data?.constants?.abilities ?? []) {
      const e = stratz.get(a.id) ?? { key: a.name };
      e[lang === 'ENGLISH' ? 'en' : 'ru'] = a.language?.displayName ?? null;
      stratz.set(a.id, e);
    }
  }
  return (id) => {
    const a = stratz.get(Number(id));
    const key = a?.key ?? abilityIds[id] ?? String(id);
    const en = abilityDisplayName({ key, stratz: a?.en, openDota: odAbilities[key]?.dname });
    const ru = a?.ru && !/^special_bonus_/.test(a.ru) && a.ru !== key ? a.ru : en;
    return [key, en, ru];
  };
}

/** Index entry of an item: [key, name, components]. Components (item keys) let
 *  the app skip a component most players complete (Yasha → Manta). */
export function itemEntry(key, od) {
  const comps = Array.isArray(od?.components) ? od.components.filter((c) => typeof c === 'string') : [];
  return comps.length ? [key, od?.dname ?? key, comps] : [key, od?.dname ?? key];
}

/** STRATZ answers "analytics database is at capacity" (GraphQL SERVER_BUSY,
 *  HTTP 200) under load: wait and retry instead of failing the whole run. */
export async function queryWithRetry(transport, q, { attempts = 6, baseMs = 15000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await transport.query(q);
    } catch (e) {
      const busy = /SERVER_BUSY|at capacity|temporarily unavailable/i.test(String(e?.message));
      if (!busy || i >= attempts) throw e;
      log(`    STRATZ busy, retry ${i}/${attempts - 1} in ${Math.round((baseMs * i) / 1000)}s`);
      await sleep(baseMs * i);
    }
  }
}

function eligiblePositions(entry) {
  if (!entry?.positions) return [];
  return ['1', '2', '3', '4', '5'].filter((p) => {
    const s = entry.positions[p];
    return s && s.share >= POSITION_ELIGIBILITY.minShare && s.games >= POSITION_ELIGIBILITY.minGames;
  }).map(Number);
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const only = args.includes('--heroes') ? args[args.indexOf('--heroes') + 1].split(',').map(Number) : null;

  if (args.includes('--names-only')) {
    // Refresh ability/talent names in index.json without re-querying the stats.
    const idx = readJson(path.join(OUT, 'index.json'));
    const tr = new StratzTransport(loadToken());
    await tr.init();
    try {
      const nameOf = await fetchNames(tr);
      for (const id of Object.keys(idx.abilities)) idx.abilities[id] = nameOf(id);
      const odItems = await getJson(`${OPEN_DOTA}/constants/items`);
      for (const [id, entry] of Object.entries(idx.items)) idx.items[id] = itemEntry(entry[0], odItems[entry[0]]);
    } finally {
      await tr.close();
    }
    fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(idx));
    console.log(`Names refreshed for ${Object.keys(idx.abilities).length} abilities and ${Object.keys(idx.items).length} items.`);
    return;
  }
  const meta = readJson(path.join(DATA, 'meta.json'));
  const heroes = readJson(path.join(DATA, 'heroes.json'));
  const positions = readJson(path.join(DATA, 'positions.json'));
  const indexPath = path.join(OUT, 'index.json');
  const index = fs.existsSync(indexPath) ? readJson(indexPath) : null;
  const reason = only ? 'PARTIAL' : rebuildReason({ index, meta, heroIds: heroes.map((h) => h.id), force });
  if (!reason) {
    console.log(`Builds are current (patch ${index.patch}, generated ${index.generatedAt}) — nothing to do.`);
    return;
  }
  console.log(`--- Building hero builds (${reason}) ---`);

  const window = meta.matchupWindow;
  const buckets = window.weeklyBuckets;
  const weights = window.bucketWeights ?? {};

  // Names and keys: OpenDota for item keys/cost/type and hero ability lists,
  // STRATZ for display names with the numbers filled in (EN + RU).
  const [odItems, heroAbilities, abilityIds] = await Promise.all([
    getJson(`${OPEN_DOTA}/constants/items`),
    getJson(`${OPEN_DOTA}/constants/hero_abilities`),
    getJson(`${OPEN_DOTA}/constants/ability_ids`),
  ]);
  const itemMeta = new Map(Object.entries(odItems).map(([key, v]) => [v.id, { key, name: v.dname, cost: v.cost, qual: v.qual }]));
  const abilityIdByName = abilityIdMap(abilityIds);

  const transport = new StratzTransport(loadToken());
  await transport.init();
  const nameOf = await fetchNames(transport);
  try {
    const builds = {};
    /** Laning results with each partner, per position and rank (public/builds/lanes/). */
    const lanes = {};
    const list = heroes.filter((h) => !only || only.includes(h.id));
    let n = 0;
    for (const hero of list) {
      n += 1;
      const pos = eligiblePositions(positions[String(hero.id)]);
      const ha = heroAbilities[hero.key];
      if (!pos.length || !ha) {
        console.log(`    [${n}/${list.length}] ${hero.name}: skipped (${!pos.length ? 'no eligible position' : 'no ability list'})`);
        continue;
      }
      const ctx = {
        abilityIds: ha.abilities.filter((a) => a !== 'generic_hidden').map((a) => abilityIdByName.get(a)).filter(Boolean),
        talents: (ha.talents ?? []).map((t) => ({ id: abilityIdByName.get(t.name), level: t.level })).filter((t) => t.id),
        items: itemMeta,
      };
      const raw = {};
      const t0 = Date.now();
      for (const bucket of buckets) {
        const res = await queryWithRetry(transport, buildHeroQuery(hero.id, bucket * BUCKET_SEC, pos, BRACKETS));
        accumulateHero(raw, res, pos, BRACKETS, weights[bucket] ?? 1);
      }
      addAllRanks(raw, BRACKETS);
      const out = { heroId: hero.id, positions: {} };
      const laneOut = { heroId: hero.id, positions: {} };
      for (const p of pos) {
        const byRank = {};
        const lanesByRank = {};
        for (const rank of ['ALL', ...BRACKETS]) {
          const b = raw[p]?.[rank] ? summarizeBuild(raw[p][rank], ctx) : null;
          if (b) byRank[rank] = b;
          const l = raw[p]?.[rank] ? summarizeLanes(raw[p][rank]) : null;
          if (l) lanesByRank[rank] = l;
        }
        if (byRank.ALL) out.positions[p] = byRank;
        if (lanesByRank.ALL) laneOut.positions[p] = lanesByRank;
      }
      if (Object.keys(out.positions).length) builds[hero.id] = out;
      if (Object.keys(laneOut.positions).length) lanes[hero.id] = laneOut;
      console.log(`    [${n}/${list.length}] ${hero.name}: positions ${pos.join(',')} in ${Date.now() - t0}ms`);
    }

    validateBuilds(builds, { minHeroes: only ? 1 : 100 });

    // Only the names the builds use.
    const usedItems = new Set();
    const usedAbilities = new Set();
    for (const b of Object.values(builds)) {
      for (const byRank of Object.values(b.positions)) {
        for (const build of Object.values(byRank)) {
          for (const it of [...build.start, ...build.boots, ...build.items]) usedItems.add(it[0]);
          for (const t of build.talents) { usedAbilities.add(t[1][0]); usedAbilities.add(t[2][0]); }
          for (const s of build.skills) usedAbilities.add(s[0]);
        }
      }
    }
    const items = {};
    for (const id of usedItems) {
      const m = itemMeta.get(id);
      if (m) items[id] = itemEntry(m.key, odItems[m.key]);
    }
    const abilities = {};
    for (const id of usedAbilities) abilities[id] = nameOf(id);
    const newIndex = {
      generatedAt: new Date().toISOString(),
      patch: meta.latestPatch,
      window: { start: window.windowStartUtc, end: window.windowEndUtc, buckets, weights },
      brackets: BRACKETS,
      heroes: Object.keys(builds).map(Number).sort((a, b) => a - b),
      items,
      abilities,
      /** heroId → position → rank → lane win share (won / (won + lost)) with any partner. */
      laneAvg: Object.fromEntries(Object.entries(lanes).map(([id, l]) => [id, Object.fromEntries(
        Object.entries(l.positions).map(([p, byRank]) => [p, Object.fromEntries(Object.entries(byRank).map(([r, x]) => [r, x.avg]))]),
      )])),
    };

    // Atomic swap of the whole directory (a partial run keeps the other heroes).
    const next = `${OUT}.__next`;
    const prev = `${OUT}.__prev`;
    fs.rmSync(next, { recursive: true, force: true });
    fs.rmSync(prev, { recursive: true, force: true });
    if (only && fs.existsSync(OUT)) fs.cpSync(OUT, next, { recursive: true });
    else fs.mkdirSync(next, { recursive: true });
    if (only && index) {
      newIndex.heroes = [...new Set([...index.heroes, ...newIndex.heroes])].sort((a, b) => a - b);
      newIndex.items = { ...index.items, ...newIndex.items };
      newIndex.abilities = { ...index.abilities, ...newIndex.abilities };
      newIndex.laneAvg = { ...(index.laneAvg ?? {}), ...newIndex.laneAvg };
      newIndex.generatedAt = index.generatedAt; // a partial run does not make the rest fresh
    }
    let bytes = 0;
    for (const [id, b] of Object.entries(builds)) {
      const s = JSON.stringify(b);
      bytes += s.length;
      fs.writeFileSync(path.join(next, `${id}.json`), s);
    }
    fs.mkdirSync(path.join(next, 'lanes'), { recursive: true });
    let laneBytes = 0;
    for (const [id, l] of Object.entries(lanes)) {
      const s = JSON.stringify(l);
      laneBytes += s.length;
      fs.writeFileSync(path.join(next, 'lanes', `${id}.json`), s);
    }
    console.log(`    lane files: ${Object.keys(lanes).length} heroes, ${Math.round(laneBytes / 1024)} KB`);
    if (!only && Object.keys(lanes).length < 100) throw new Error(`only ${Object.keys(lanes).length} heroes have lane data`);
    fs.writeFileSync(path.join(next, 'index.json'), JSON.stringify(newIndex));
    if (fs.existsSync(OUT)) fs.renameSync(OUT, prev);
    fs.renameSync(next, OUT);
    fs.rmSync(prev, { recursive: true, force: true });
    console.log(`--- Builds published: ${Object.keys(builds).length} heroes, ${Math.round(bytes / 1024)} KB, index ${Math.round(JSON.stringify(newIndex).length / 1024)} KB ---`);
  } finally {
    await transport.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('update-builds-stratz.mjs')) {
  main().catch((e) => {
    console.error(`✗ builds update failed: ${e.message}`);
    process.exit(1);
  });
}
