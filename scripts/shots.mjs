import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = 'http://127.0.0.1:4174';
const OUT = 'screenshots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});

const errors = [];

async function shoot(name, viewport, actions) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${name}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${name}] pageerror: ${e.message}`));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  if (actions) await actions(page);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  // horizontal overflow check
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log(`${name}: overflowPx=${overflow}`);
  await ctx.close();
}

const pickHeroes = async (page) => {
  for (const name of ['Puck', 'Tidehunter', 'Juggernaut']) {
    const chip = page.getByRole('button', { name, exact: true }).first();
    if (await chip.count()) { await chip.click(); await page.waitForTimeout(250); }
    else {
      await page.locator('#hero-search').fill(name.slice(0, 4));
      await page.waitForTimeout(300);
      await page.locator('.drop-item').first().click();
      await page.waitForTimeout(250);
    }
  }
};

await shoot('desktop-empty', { width: 1440, height: 900 });
await shoot('desktop-draft', { width: 1440, height: 900 }, pickHeroes);
await shoot('mobile-empty', { width: 390, height: 844 });
await shoot('mobile-draft', { width: 390, height: 844 }, pickHeroes);

// drawer check (desktop)
await shoot('desktop-drawer', { width: 1440, height: 900 }, async (page) => {
  await pickHeroes(page);
  await page.getByRole('button', { name: /View analysis/i }).first().click();
  await page.waitForTimeout(400);
});

console.log('console errors:', errors.length ? errors : 'none');
await browser.close();
