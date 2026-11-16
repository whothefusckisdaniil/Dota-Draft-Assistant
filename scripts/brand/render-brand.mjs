// Renders the PNG brand assets from public/brand/*.svg with Playwright:
//   public/icons/icon-192.png, icon-512.png, maskable-512.png, apple-touch-icon.png
//   public/og-image.png (1200×630 link preview; crawlers do not render SVG)
// Usage: node scripts/brand/render-brand.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pub = (...p) => path.join(root, 'public', ...p);
const svg = (name) => fs.readFileSync(pub('brand', name), 'utf8');
const dataUrl = (name) => `data:image/svg+xml;base64,${Buffer.from(svg(name)).toString('base64')}`;

const browser = await chromium.launch();
const page = await browser.newPage();

async function renderSvg(name, size, out) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style><img src="${dataUrl(name)}" width="${size}" height="${size}" style="display:block">`);
  await page.locator('img').evaluate((img) => img.decode());
  await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  console.log(path.relative(root, out));
}

fs.mkdirSync(pub('icons'), { recursive: true });
await renderSvg('lastpick-app-icon.svg', 192, pub('icons', 'icon-192.png'));
await renderSvg('lastpick-app-icon.svg', 512, pub('icons', 'icon-512.png'));
await renderSvg('lastpick-maskable.svg', 512, pub('icons', 'maskable-512.png'));
await renderSvg('lastpick-maskable.svg', 180, pub('icons', 'apple-touch-icon.png'));

// Link preview
await page.setViewportSize({ width: 1200, height: 630 });
await page.setContent(`<!doctype html><html><head>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family=Unbounded:wght@700&display=block" rel="stylesheet">
<style>
  html,body{margin:0;width:1200px;height:630px;background:#090B0F;color:#E8ECF2;font-family:Inter,sans-serif;overflow:hidden}
  .wrap{position:absolute;inset:0;padding:72px 80px;display:flex;flex-direction:column;justify-content:space-between;
    background:radial-gradient(700px 420px at 92% 18%,rgba(255,180,58,.16),transparent 70%)}
  .logo{height:84px;filter:drop-shadow(0 0 24px rgba(255,180,58,.35))}
  h1{font-family:Unbounded,sans-serif;font-weight:700;font-size:58px;line-height:68px;letter-spacing:.01em;margin:0;max-width:860px}
  h1 em{font-style:normal;color:#FFB43A}
  p{margin:18px 0 0;font-size:26px;color:#8A94A6}
  .row{display:flex;align-items:center;justify-content:space-between}
  .slots{display:flex;gap:26px;padding-right:14px}
  .slots i{width:34px;height:34px;border-radius:7px;transform:rotate(45deg);border:2.5px dashed #2E3847}
  .slots i.on{border:0;background:linear-gradient(#FFC857,#FF9F1C);box-shadow:0 0 24px rgba(255,180,58,.45)}
  small{font-size:18px;color:#8A94A6}
</style></head><body><div class="wrap">
  <img class="logo" src="${dataUrl('lastpick-horizontal.svg')}" style="margin-left:-75px;margin-top:-60px;height:200px;width:auto;align-self:flex-start">
  <div><h1>Win the draft <em>before</em> the game starts</h1>
  <p>Counterpicks for every role and rank · Dota 2</p></div>
  <div class="row"><small>Last 30 days of STRATZ data · Not affiliated with Valve</small>
  <div class="slots"><i></i><i></i><i></i><i></i><i class="on"></i></div></div>
</div></body></html>`);
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);
await page.screenshot({ path: pub('og-image.png') });
console.log('public/og-image.png');
await browser.close();
