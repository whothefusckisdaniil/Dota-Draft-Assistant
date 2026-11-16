// Daily-job check for a newly released hero: is there a Russian name and a
// local WebP portrait? Neither blocks anything (the app falls back to the
// English name and the Steam CDN portrait); this only makes the gap visible.
//   node scripts/check-hero-assets.mjs                 → GitHub ::warning:: lines
//   node scripts/check-hero-assets.mjs --missing-portraits → prints keys, one per line
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const heroes = JSON.parse(fs.readFileSync(path.join(root, 'public/data/heroes.json'), 'utf8'));
const keyOf = (h) => h.key.replace('npc_dota_hero_', '');

const missingPortraits = heroes.filter((h) => !fs.existsSync(path.join(root, 'public/heroes', `${keyOf(h)}.webp`)));
if (process.argv.includes('--missing-portraits')) {
  for (const h of missingPortraits) console.log(keyOf(h));
  process.exit(0);
}

// heroNamesRu.ts is TypeScript: read its top-level keys (`  key: {`).
const src = fs.readFileSync(path.join(root, 'src/i18n/heroNamesRu.ts'), 'utf8');
const ruKeys = new Set([...src.matchAll(/^\s{2}([a-z0-9_]+):\s*\{/gm)].map((m) => m[1]));
const missingRu = heroes.filter((h) => !ruKeys.has(keyOf(h)));

for (const h of missingRu) {
  console.log(`::warning title=New hero without a Russian name::${h.name} (${keyOf(h)}) — add it to src/i18n/heroNamesRu.ts; the RU UI shows the English name until then.`);
}
for (const h of missingPortraits) {
  console.log(`::warning title=Hero without a local portrait::${h.name} (${keyOf(h)}) — the app uses the Steam CDN image; run node scripts/fetch-portraits.mjs.`);
}
if (!missingRu.length && !missingPortraits.length) console.log(`All ${heroes.length} heroes have a Russian name and a local portrait.`);
