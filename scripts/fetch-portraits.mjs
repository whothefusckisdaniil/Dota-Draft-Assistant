// Downloads hero portraits (Steam CDN, 256×144 PNG) and stores them as WebP
// in public/heroes/<key>.webp, so the app serves them from its own origin:
// smaller files, cacheable offline by the service worker, and usable on a
// <canvas> for the share card (the CDN allows CORS only for dota2.com).
// The app falls back to the CDN URL for a hero without a local file (a new
// hero before this script is re-run).
// Usage: node scripts/fetch-portraits.mjs [--force]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public', 'heroes');
const force = process.argv.includes('--force');
const heroes = JSON.parse(fs.readFileSync(path.join(root, 'public', 'data', 'heroes.json'), 'utf8'));
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<canvas id="c"></canvas>');
let done = 0, skipped = 0, failed = 0;
for (const h of heroes) {
  const key = h.key.replace('npc_dota_hero_', '');
  const out = path.join(outDir, `${key}.webp`);
  if (!force && fs.existsSync(out)) { skipped++; continue; }
  try {
    const res = await fetch(h.img, { headers: { 'User-Agent': 'lastpick-portraits' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const b64 = Buffer.from(await res.arrayBuffer()).toString('base64');
    const webp = await page.evaluate(async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.getElementById('c');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/webp', 0.82).split(',')[1];
    }, `data:image/png;base64,${b64}`);
    fs.writeFileSync(out, Buffer.from(webp, 'base64'));
    done++;
  } catch (e) {
    failed++;
    console.warn(`${key}: ${e.message}`);
  }
}
await browser.close();
console.log(`portraits: ${done} written, ${skipped} kept, ${failed} failed → public/heroes/`);
if (failed) process.exitCode = 1;
