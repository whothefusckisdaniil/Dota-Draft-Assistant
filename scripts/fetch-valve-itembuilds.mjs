#!/usr/bin/env node
/**
 * Fetch Valve itembuild files into a normalized, committed research snapshot.
 *
 *   node scripts/fetch-valve-itembuilds.mjs [--out research/valve-itembuilds.json]
 *
 * ТЗ №18 §1: the research input must be reproducible. The raw 128 files are
 * Valve game data, not ours, so we do NOT commit them; we commit ONE normalized
 * snapshot that records exactly which source commit it came from. Re-running
 * this script must produce a byte-identical file for the same input, so the
 * output carries no timestamps — only the pinned source commit.
 *
 * No token, no auth, no secrets. Not run in CI: the snapshot is refreshed
 * deliberately and reviewed like any other data change.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const REPO = 'SteamDatabase/GameTracking-Dota2';
const RAW = `https://raw.githubusercontent.com/${REPO}/master/game/dota/itembuilds`;
const API = `https://api.github.com/repos/${REPO}`;

const outIdx = process.argv.indexOf('--out');
const OUT = path.resolve(outIdx > -1 ? process.argv[outIdx + 1] : 'research/valve-itembuilds.json');

/** Phase order is Valve's own; it is categorical, NOT a time scale. */
const PHASE_ORDER = [
  'Starting_Items', 'Starting_Items_Secondary',
  'Early_Game', 'Early_Game_Secondary',
  'Core_Items', 'Core_Items_Secondary',
  'Mid_Items', 'Late_Items', 'Luxury', 'Other_Items',
];

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/**
 * Fetch with a small retry. Fetching ~130 files in sequence intermittently
 * drops a connection; without this the whole snapshot would abort on a
 * transient failure and the run would look like a data problem.
 */
async function fetchText(url, attempts = 4) {
  let lastErr;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (res.ok) return await res.text();
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 400 * i));
  }
  throw lastErr;
}

async function listFiles() {
  const tree = await getJson(`${API}/git/trees/master?recursive=1`);
  return tree.tree
    .map((x) => x.path)
    .filter((p) => p.startsWith('game/dota/itembuilds/') && p.endsWith('.txt'))
    .sort();
}

/** Parse one Valve itembuilds KV file. Phase is a LABEL, not a time bucket. */
export function parseBuildFile(text) {
  const hero = (text.match(/"hero"\s*"([a-z0-9_]+)"/) ?? [])[1] ?? null;
  const author = (text.match(/"author"\s*"([^"]+)"/) ?? [])[1] ?? null;
  const phases = {};
  const blocks = text.split(/"(#[A-Za-z_]+)"/);
  for (let i = 1; i < blocks.length - 1; i += 2) {
    const phase = blocks[i].replace('#DOTA_Item_Build_', '');
    const items = [...blocks[i + 1].matchAll(/"item"\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
    if (items.length) phases[phase] = items;
  }
  return { hero, author, phases };
}

async function main() {
  console.log('--- fetching Valve itembuilds (GameTracking-Dota2) ---');
  const head = await getJson(`${API}/commits/master`);
  console.log(`source commit: ${head.sha}`);

  const files = await listFiles();
  console.log(`itembuild files listed: ${files.length}`);

  const heroes = {};
  const templates = [];
  const itemPhases = {};
  const failed = [];

  for (const p of files) {
    const name = p.split('/').pop();
    let parsed;
    try {
      parsed = parseBuildFile(await fetchText(`${RAW}/${name}`));
    } catch (e) {
      failed.push(`${name}: ${e.message}`);
      continue;
    }
    if (!parsed.hero) {
      // Not a failure: Valve ships at least one template file that carries phase
      // blocks but no hero (default_generic.txt). It cannot join on a hero id,
      // so it is recorded separately rather than counted as a hero build.
      templates.push(name);
      continue;
    }
    heroes[parsed.hero] = { author: parsed.author, sourceFile: name, phases: parsed.phases };
    for (const [phase, items] of Object.entries(parsed.phases)) {
      for (const it of items) {
        if (!itemPhases[it]) itemPhases[it] = {};
        itemPhases[it][phase] = (itemPhases[it][phase] ?? 0) + 1;
      }
    }
  }
  if (failed.length) {
    console.error('files that could not be used:');
    for (const f of failed) console.error(`  ${f}`);
    throw new Error(`${failed.length}/${files.length} itembuild files failed — snapshot NOT written`);
  }

  const snapshot = {
    source: {
      repository: REPO,
      path: 'game/dota/itembuilds/',
      kind: 'Valve-authored default item builds, mirrored by a community tracker',
      sourceCommit: head.sha,
      sourceCommitDate: head.commit.committer.date,
      isOfficialValveApi: false,
    },
    phaseOrder: PHASE_ORDER,
    phaseSemantics:
      'Categorical build labels authored by Valve. NOT minute ranges, NOT positions. ' +
      'An item may appear under several phases; phase says nothing about inventory slots.',
    heroCount: Object.keys(heroes).length,
    distinctValveItems: Object.keys(itemPhases).length,
    herolessTemplateFiles: templates,
    heroes,
    itemPhases,
  };

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(snapshot, null, 1)}\n`);
  console.log(`heroes: ${snapshot.heroCount}   distinct valve items: ${snapshot.distinctValveItems}`);
  console.log(`hero-less template files (not hero builds): ${templates.length ? templates.join(', ') : 'none'}`);
  console.log(`written: ${OUT}`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((e) => { console.error(`FETCH FAILED: ${e.message}`); process.exit(1); });
}
